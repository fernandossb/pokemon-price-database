import fs from 'node:fs/promises';
import path from 'node:path';
import { config, nowIso, readJson, round2, todayUtc } from './lib.mjs';

const OUTPUT_SHARD_DIR = 'output/shards';
const INPUT_SHARD_DIR = process.env.SHARD_OUTPUT_DIR || 'work/shards';
const PRICE_SOURCE = process.env.PRICE_SOURCE || 'ligapokemon';
const CACHE_SHARD_DIR = PRICE_SOURCE === 'mypcards' ? 'cache/shards-mypcards' : 'cache/shards';
const SHARD_COUNT = config.shardCount || 12;

await fs.mkdir('output', { recursive: true });
await fs.mkdir(OUTPUT_SHARD_DIR, { recursive: true });
await fs.mkdir(CACHE_SHARD_DIR, { recursive: true });
await fs.mkdir('history', { recursive: true });

const catalog = await readJson('work/catalog.json', null);
if (!catalog?.cards?.length) throw new Error('Catálogo ausente');
const mypcardsSnapshot = PRICE_SOURCE === 'mypcards' ? await readJson('work/mypcards-prices.json', null) : null;
if (PRICE_SOURCE === 'mypcards' && (!mypcardsSnapshot?.meta?.generatedAt || !mypcardsSnapshot?.byTcgProductId)) {
  throw new Error('Snapshot MYP Cards ausente ou inválido');
}
if (!['ligapokemon', 'mypcards'].includes(PRICE_SOURCE)) throw new Error(`Fonte de preços não reconhecida: ${PRICE_SOURCE}`);

async function loadPreviousPrices() {
  const previous = {};
  try {
    const files = (await fs.readdir(OUTPUT_SHARD_DIR)).filter(file => /^shard-\d+\.json$/.test(file));
    for (const file of files) {
      const shard = await readJson(path.join(OUTPUT_SHARD_DIR, file), null);
      if (Number(shard?.meta?.schemaVersion) === 4) Object.assign(previous, shard?.prices || {});
    }
  } catch {}
  return previous;
}

const previousPrices = await loadPreviousPrices();
const publishedPrices = {};
const publishedVariantCatalog = {};
const allowedCardIds = new Set(catalog.cards.map(card => card.id));

await fs.rm(OUTPUT_SHARD_DIR, { recursive: true, force: true });
await fs.mkdir(OUTPUT_SHARD_DIR, { recursive: true });
const unmatchedByKey = new Map();
let files = [];
try { files = (await fs.readdir(INPUT_SHARD_DIR)).filter(file => /^shard-\d+\.json$/.test(file)).sort(); } catch {}
if (!files.length) throw new Error('Nenhum resultado de shard encontrado');

const shardMetas = [];
const outputShardFiles = [];
let ligaSnapshotId = null;
let ligaFetchedAtMin = null;
let ligaFetchedAtMax = null;
const ligaFetchedAtSources = new Set();
let ligaOffersCount = 0;
let mypcardsMatched = 0;
for (const file of files) {
  const result = await readJson(path.join(INPUT_SHARD_DIR, file), null);
  if (!result?.meta) continue;
  if (Number(result.meta.schemaVersion) !== 4) throw new Error(`Schema antigo em ${file}`);
  if (result.meta.catalogHash !== catalog.hash) throw new Error(`Hash de catálogo divergente em ${file}`);
  if (result.meta.priceSource !== PRICE_SOURCE) throw new Error(`Fonte divergente em ${file}: ${result.meta.priceSource}`);
  if (PRICE_SOURCE === 'ligapokemon') {
    const shardFetchedAtMin = Date.parse(result.meta.ligaFetchedAtMin || '');
    const shardFetchedAtMax = Date.parse(result.meta.ligaFetchedAtMax || '');
    const browserSnapshot = (result.meta.ligaFetchedAtSources || []).includes('snapshot-captured-at');
    const freshnessWindow = browserSnapshot ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    if (!result.meta.ligaSnapshotId || !Number.isFinite(shardFetchedAtMin) || !Number.isFinite(shardFetchedAtMax) ||
        shardFetchedAtMin > shardFetchedAtMax || Date.now() - shardFetchedAtMin > freshnessWindow || result.meta.ligaOffersCount < 0) {
      throw new Error(`Snapshot da Liga ausente ou vencido em ${file}`);
    }
    if (ligaSnapshotId === null) ligaSnapshotId = result.meta.ligaSnapshotId;
    else if (ligaSnapshotId !== result.meta.ligaSnapshotId) throw new Error('Os shards pertencem a execuções diferentes da Liga Pokémon.');
    ligaFetchedAtMin = ligaFetchedAtMin === null ? shardFetchedAtMin : Math.min(ligaFetchedAtMin, shardFetchedAtMin);
    ligaFetchedAtMax = ligaFetchedAtMax === null ? shardFetchedAtMax : Math.max(ligaFetchedAtMax, shardFetchedAtMax);
    for (const source of result.meta.ligaFetchedAtSources || []) ligaFetchedAtSources.add(source);
    ligaOffersCount += Number(result.meta.ligaOffersCount) || 0;
  } else {
    const generatedAt = Date.parse(result.meta.mypcardsSnapshotGeneratedAt || '');
    if (!Number.isFinite(generatedAt) || Date.now() - generatedAt > 30 * 60 * 60 * 1000 || generatedAt > Date.now() + 5 * 60 * 1000) {
      throw new Error(`Snapshot MYP Cards ausente ou vencido em ${file}`);
    }
    if (result.meta.mypcardsSnapshotGeneratedAt !== mypcardsSnapshot.meta.generatedAt) {
      throw new Error(`Shards MYP Cards foram processados com snapshots diferentes (${file}).`);
    }
    mypcardsMatched += Number(result.meta.mypcardsMatched) || 0;
  }

  shardMetas.push(result.meta);
  const shardIndex = Number(result.meta.shardIndex);
  const assignedToShard = cardId => {
    const index = catalog.cards.findIndex(card => card.id === cardId);
    return index >= 0 && index % SHARD_COUNT === shardIndex;
  };
  const shardPrices = Object.fromEntries(Object.entries(result.prices || {}).filter(([key, value]) => {
    const cardId = String(value?.cardId || key.split('::', 1)[0] || '');
    return allowedCardIds.has(cardId) && assignedToShard(cardId);
  }));
  const shardVariantCatalog = Object.fromEntries(Object.entries(result.variantCatalog || {}).filter(([cardId]) => {
    return allowedCardIds.has(cardId) && assignedToShard(cardId);
  }));

  Object.assign(publishedPrices, shardPrices);
  Object.assign(publishedVariantCatalog, shardVariantCatalog);
  for (const item of result.unmatched || []) {
    unmatchedByKey.set(`${item.id}::${item.language || ''}::${item.variantEnum || ''}`, item);
  }
  await fs.writeFile(path.join(CACHE_SHARD_DIR, file), JSON.stringify(result));

  const outputName = `shard-${String(shardIndex).padStart(2, '0')}.json`;
  const outputPayload = {
    meta: {
      schemaVersion: 4,
      format: 'price-shard-v2',
      shardIndex,
      shardCount: Number(result.meta.shardCount) || SHARD_COUNT,
      catalogHash: catalog.hash,
      generatedAt: result.meta.generatedAt || nowIso(),
      priceSource: PRICE_SOURCE,
      ligaSnapshotId: result.meta.ligaSnapshotId,
      ligaFetchedAtMin: result.meta.ligaFetchedAtMin,
      ligaFetchedAtMax: result.meta.ligaFetchedAtMax,
      ligaFetchedAtSources: result.meta.ligaFetchedAtSources || [],
      ligaOffersCount: Number(result.meta.ligaOffersCount) || 0,
      ...(PRICE_SOURCE === 'mypcards' ? {
        mypcardsSnapshotGeneratedAt: result.meta.mypcardsSnapshotGeneratedAt,
        mypcardsProducts: result.meta.mypcardsProducts,
        mypcardsPricedRows: result.meta.mypcardsPricedRows,
        mypcardsMatched: Number(result.meta.mypcardsMatched) || 0,
      } : {}),
      variantsDiscovered: Object.values(shardVariantCatalog).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0),
      variantsPriced: Object.keys(shardPrices).length,
    },
    prices: shardPrices,
    variantCatalog: shardVariantCatalog,
  };
  await fs.writeFile(path.join(OUTPUT_SHARD_DIR, outputName), JSON.stringify(outputPayload));
  outputShardFiles.push(outputName);
}

const changes = {};
const threshold = Math.max(0, config.priceChangeThresholdPercent || 0.1) / 100;
for (const [key, item] of Object.entries(publishedPrices)) {
  const old = previousPrices[key];
  if (!old) {
    changes[key] = { oldPriceBrl: null, newPriceBrl: item.priceBrl, changePercent: null };
    continue;
  }
  const oldPrice = Number(old.priceBrl);
  const newPrice = Number(item.priceBrl);
  if (!Number.isFinite(oldPrice) || !Number.isFinite(newPrice) || oldPrice <= 0) continue;
  const pct = (newPrice - oldPrice) / oldPrice;
  if (Math.abs(pct) >= threshold) changes[key] = { oldPriceBrl: oldPrice, newPriceBrl: newPrice, changePercent: round2(pct * 100) };
}

const generatedAt = nowIso();
const unmatched = [...unmatchedByKey.values()];
const completeShards = new Set(shardMetas.map(meta => meta.shardIndex));
const cardShardIndex = Object.fromEntries(catalog.cards.map((card, index) => [card.id, index % SHARD_COUNT]));
const indexPayload = {
  meta: {
    schemaVersion: 4,
    format: 'card-shard-index-v2',
    generatedAt,
    catalogHash: catalog.hash,
    shardCount: SHARD_COUNT,
    cardsInCatalog: catalog.count,
  },
  cards: cardShardIndex,
};

const variantsDiscovered = Object.values(publishedVariantCatalog).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
const meta = {
  schemaVersion: 4,
  format: 'sharded-v2',
  status: completeShards.size === SHARD_COUNT ? 'complete' : 'partial',
  generatedAt,
  date: todayUtc(),
  catalogHash: catalog.hash,
  cardsInCatalog: catalog.count,
  shardsExpected: SHARD_COUNT,
  shardsCompleted: completeShards.size,
  shardFiles: outputShardFiles.sort(),
  indexFile: 'card-shard-index.json',
  variantsDiscovered,
  variantsPriced: Object.keys(publishedPrices).length,
  unmatched: unmatched.length,
  changedPrices: Object.keys(changes).length,
  sellerMarketPrices: {
    mypcards: mypcardsMatched,
    ligapokemon: shardMetas.reduce((sum, item) => sum + (Number(item.ligaMatched) || 0), 0),
  },
  ...(PRICE_SOURCE === 'mypcards' ? { mypcards: {
    generatedAt: mypcardsSnapshot.meta.generatedAt,
    products: Number(mypcardsSnapshot.meta.products) || 0,
    pricedRows: Number(mypcardsSnapshot.meta.pricedRows) || 0,
    verifiedSellerRows: Number(mypcardsSnapshot.meta.verifiedSellerRows) || 0,
    linkedVariants: mypcardsMatched,
    attributionUrl: mypcardsSnapshot.meta.attributionUrl || 'https://mypcards.com',
  } } : {}),
  workers: shardMetas,
  priceSource: PRICE_SOURCE,
  ligaSnapshotId,
  ligaFetchedAtMin: ligaFetchedAtMin === null ? null : new Date(ligaFetchedAtMin).toISOString(),
  ligaFetchedAtMax: ligaFetchedAtMax === null ? null : new Date(ligaFetchedAtMax).toISOString(),
  ligaFetchedAtSources: [...ligaFetchedAtSources].sort(),
  ligaOffersCount,
};

await fs.writeFile('output/card-shard-index.json', JSON.stringify(indexPayload));
await fs.writeFile('output/unmatched-cards.json', JSON.stringify(unmatched));
await fs.writeFile('output/status.json', JSON.stringify(meta, null, 2));
await fs.writeFile(`history/${todayUtc()}-changes.json`, JSON.stringify({ meta, changes }));
await fs.rm('output/prices-current.json', { force: true });

console.log(meta);
if (meta.status !== 'complete') throw new Error(`Consolidação parcial: ${meta.shardsCompleted}/${meta.shardsExpected} shards`);
