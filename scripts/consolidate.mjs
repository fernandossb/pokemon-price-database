import fs from 'node:fs/promises';
import path from 'node:path';
import { config, nowIso, readJson, round2, todayUtc } from './lib.mjs';

const OUTPUT_SHARD_DIR = 'output/shards';
const SHARD_COUNT = config.shardCount || 12;

await fs.mkdir('output', { recursive: true });
await fs.mkdir(OUTPUT_SHARD_DIR, { recursive: true });
await fs.mkdir('cache/shards', { recursive: true });
await fs.mkdir('history', { recursive: true });

const catalog = await readJson('work/catalog.json', null);
if (!catalog?.cards?.length) throw new Error('Catálogo ausente');

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
try { files = (await fs.readdir('work/shards')).filter(file => file.endsWith('.json')).sort(); } catch {}
if (!files.length) throw new Error('Nenhum resultado de shard encontrado');

const shardMetas = [];
const outputShardFiles = [];
for (const file of files) {
  const result = await readJson(path.join('work/shards', file), null);
  if (!result?.meta) continue;
  if (Number(result.meta.schemaVersion) !== 4) throw new Error(`Schema antigo em ${file}`);
  if (result.meta.catalogHash !== catalog.hash) throw new Error(`Hash de catálogo divergente em ${file}`);

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
  await fs.writeFile(path.join('cache/shards', file), JSON.stringify(result));

  const outputName = `shard-${String(shardIndex).padStart(2, '0')}.json`;
  const outputPayload = {
    meta: {
      schemaVersion: 4,
      format: 'price-shard-v2',
      shardIndex,
      shardCount: Number(result.meta.shardCount) || SHARD_COUNT,
      catalogHash: catalog.hash,
      generatedAt: result.meta.generatedAt || nowIso(),
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
  workers: shardMetas,
};

await fs.writeFile('output/card-shard-index.json', JSON.stringify(indexPayload));
await fs.writeFile('output/unmatched-cards.json', JSON.stringify(unmatched));
await fs.writeFile('output/status.json', JSON.stringify(meta, null, 2));
await fs.writeFile(`history/${todayUtc()}-changes.json`, JSON.stringify({ meta, changes }));
await fs.rm('output/prices-current.json', { force: true });

console.log(meta);
if (meta.status !== 'complete') throw new Error(`Consolidação parcial: ${meta.shardsCompleted}/${meta.shardsExpected} shards`);
