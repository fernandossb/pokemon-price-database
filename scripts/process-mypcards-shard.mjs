import fs from 'node:fs/promises';
import { getCard } from './providers/tcgdex.mjs';
import { config, getFx, nowIso, readJson, resolvePrice, sleep, variantCatalog } from './lib.mjs';

const shardIndex = Number(process.env.SHARD_INDEX);
const shardCount = Number(process.env.SHARD_COUNT || config.shardCount || 12);
if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
  throw new Error(`SHARD_INDEX inválido: ${process.env.SHARD_INDEX}`);
}
const shardTag = String(shardIndex).padStart(2, '0');
const catalog = await readJson('work/catalog.json', null);
const mypcardsPrices = await readJson('work/mypcards-prices.json', null);
if (!catalog?.cards?.length) throw new Error('work/catalog.json ausente ou vazio');
if (!mypcardsPrices?.meta?.generatedAt || !mypcardsPrices?.byTcgProductId) {
  throw new Error('Snapshot direto da API MYP Cards ausente ou inválido');
}

const cards = catalog.cards.filter((_, index) => index % shardCount === shardIndex);
const fx = await getFx();
const tcgplayerProducts = (await readJson('work/tcgplayer-products.json', { products: {} }))?.products || {};
const prices = {};
const variantsByCard = {};
const unmatched = [];
let cursor = 0;
let mypcardsMatched = 0;
const mypcardsMatchedKeys = new Set();

async function fetchAllLanguages(summary) {
  const languages = summary.availableLanguages?.length ? summary.availableLanguages : config.languages;
  const loaded = [];
  const failures = [];
  for (const language of languages) {
    let card = null;
    let lastError;
    for (let attempt = 1; attempt <= (config.maxAttemptsPerCard || 3); attempt += 1) {
      try {
        card = await getCard(language, summary.id);
        if (card) break;
      } catch (error) {
        lastError = error;
        if (attempt < (config.maxAttemptsPerCard || 3)) await sleep((config.retryDelayMs || 500) * attempt);
      }
    }
    if (card) loaded.push({ card, language });
    else failures.push(`${language}${lastError ? ` (${lastError.message})` : ''}`);
    await sleep(config.requestDelayMs || 80);
  }
  if (failures.length) throw new Error(`TCGdex falhou em ${summary.id}: ${failures.join(', ')}`);
  return loaded;
}

function mergeVariantCatalog(cardId, language, items) {
  const current = Array.isArray(variantsByCard[cardId]) ? variantsByCard[cardId] : [];
  const byKey = new Map(current.map(item => [`${item.language}::${item.value}`, item]));
  for (const item of items) {
    const key = `${language}::${item.value}`;
    const previous = byKey.get(key) || { language, value: item.value, sources: [], kinds: [], priced: false };
    byKey.set(key, {
      language,
      value: item.value,
      sources: [...new Set([...(previous.sources || []), ...(item.sources || [])])].sort(),
      kinds: [...new Set([...(previous.kinds || []), ...(item.kinds || [])])].sort(),
      priced: Boolean(previous.priced || item.priced),
    });
  }
  variantsByCard[cardId] = [...byKey.values()].sort((a, b) => `${a.language}:${a.value}`.localeCompare(`${b.language}:${b.value}`, 'en'));
}

async function processOne(summary) {
  const loaded = await fetchAllLanguages(summary);
  if (!loaded.length) throw new Error(`TCGdex não retornou ${summary.id}`);
  for (const { card, language } of loaded) {
    const available = variantCatalog(card, tcgplayerProducts, mypcardsPrices);
    mergeVariantCatalog(card.id, language, available);
    for (const enumInfo of available) {
      const variantEnum = enumInfo.value;
      const key = `${card.id}::${language}::${variantEnum}`;
      const resolved = resolvePrice({ card, variantEnum, language, fx, tcgplayerProducts, mypcardsPrices });
      if (!resolved) {
        unmatched.push({ id: card.id, language, variantEnum, sources: enumInfo.sources,
          reason: 'no_exact_price_for_enum', checkedAt: nowIso() });
        continue;
      }
      if (resolved.priceMarket === 'mypcards') {
        mypcardsMatched += 1;
        mypcardsMatchedKeys.add(key);
      }
      prices[key] = {
        cardId: card.id,
        language,
        variantEnum,
        enumSources: [...new Set([...(enumInfo.sources || []), ...(resolved.priceMarket === 'mypcards' ? ['mypcards'] : [])])].sort(),
        enumKinds: enumInfo.kinds,
        name: card.name,
        number: card.localId,
        setTotal: card.set?.cardCount?.official ?? null,
        setTotalWithSecrets: card.set?.cardCount?.total ?? null,
        setId: card.set?.id || null,
        setName: card.set?.name || null,
        rarity: card.rarity || null,
        illustrator: card.illustrator || null,
        promotional: Boolean(card.set?.id?.toLowerCase().includes('promo')),
        updatedAt: nowIso(),
        ...resolved,
      };
      if (resolved.priceMarket === 'mypcards') {
        mergeVariantCatalog(card.id, language, [{ ...enumInfo, sources: [...new Set([...(enumInfo.sources || []), 'mypcards'])], priced: true }]);
      }
    }
  }
}

async function worker() {
  while (true) {
    const index = cursor++;
    if (index >= cards.length) return;
    await processOne(cards[index]);
    if ((index + 1) % 100 === 0) console.log(`Shard MYP ${shardIndex}: ${index + 1}/${cards.length}`);
  }
}

const concurrency = Math.max(1, config.maxConcurrentRequestsPerShard || 4);
await Promise.all(Array.from({ length: concurrency }, () => worker()));

await fs.mkdir('work/shards-mypcards', { recursive: true });
const result = {
  meta: {
    schemaVersion: 4,
    format: 'price-shard-v2',
    shardIndex,
    shardCount,
    catalogHash: catalog.hash,
    generatedAt: nowIso(),
    cardsAssigned: cards.length,
    variantsDiscovered: Object.values(variantsByCard).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0),
    variantsPriced: Object.keys(prices).length,
    unmatched: unmatched.length,
    priceSource: 'mypcards',
    mypcardsMatched,
    mypcardsMatchedKeys: mypcardsMatchedKeys.size,
    mypcardsSnapshotGeneratedAt: mypcardsPrices.meta.generatedAt,
    mypcardsProducts: Number(mypcardsPrices.meta.products) || 0,
    mypcardsPricedRows: Number(mypcardsPrices.meta.pricedRows) || 0,
    fx,
  },
  prices,
  variantCatalog: variantsByCard,
  unmatched,
};
await fs.writeFile(`work/shards-mypcards/shard-${shardTag}.json`, JSON.stringify(result));
console.log(`Shard MYP ${shardIndex} concluído: ${cards.length} cartas, ${Object.keys(prices).length} enums com preço, ${mypcardsMatchedKeys.size} ligados à MYP Cards.`);
