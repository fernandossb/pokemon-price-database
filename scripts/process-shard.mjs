import fs from 'node:fs/promises';
import { getCard } from './providers/tcgdex.mjs';
import { config, variants as cardVariants, getFx, nowIso, readJson, resolvePrice, sleep } from './lib.mjs';

const shardIndex = Number(process.env.SHARD_INDEX);
const shardCount = Number(process.env.SHARD_COUNT || config.shardCount || 12);
if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
  throw new Error(`SHARD_INDEX inválido: ${process.env.SHARD_INDEX}`);
}
const shardTag = String(shardIndex).padStart(2, '0');

const catalog = await readJson('work/catalog.json', null);
if (!catalog?.cards?.length) throw new Error('work/catalog.json ausente ou vazio');
const cards = catalog.cards.filter((_, index) => index % shardCount === shardIndex);
const fx = await getFx();

const previousShardRaw = await readJson(`cache/shards/shard-${shardTag}.json`, { prices: {} });
const previousShard = Number(previousShardRaw?.meta?.schemaVersion) === 2 ? previousShardRaw : { prices: {} };
const prices = previousShard.prices || {};
const unmatched = [];
let cursor = 0;

async function fetchAllLanguages(summary) {
  const languages = summary.availableLanguages?.length ? summary.availableLanguages : config.languages;
  const loaded = [];
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
    else if (lastError) console.warn(`${summary.id} [${language}]: ${lastError.message}`);
    await sleep(config.requestDelayMs || 80);
  }
  return loaded;
}

async function processOne(summary) {
  const loadedList = await fetchAllLanguages(summary);
  if (!loadedList.length) {
    unmatched.push({ id: summary.id, reason: 'card_not_loaded', checkedAt: nowIso() });
    return;
  }
  for (const { card, language } of loadedList) {
    for (const variant of cardVariants(card)) {
      const key = `${card.id}::${language}::${variant.printVariation}::${variant.stamp}::${variant.finish}`;
      const resolved = resolvePrice({ card, variant: { ...variant, language }, fx });
      if (!resolved) {
        unmatched.push({
          id: card.id,
          language,
          finish: variant.finish,
          printVariation: variant.printVariation,
          stamp: variant.stamp,
          reason: 'no_price_data',
          checkedAt: nowIso()
        });
        continue;
      }
      prices[key] = {
        cardId: card.id,
        language,
        finish: variant.finish,
        printVariation: variant.printVariation,
        stamp: variant.stamp,
        name: card.name,
        number: card.localId,
        setId: card.set?.id || null,
        setName: card.set?.name || null,
        illustrator: card.illustrator || null,
        promotional: Boolean(card.set?.id?.toLowerCase().includes('promo')),
        updatedAt: nowIso(),
        ...resolved
      };
    }
  }
}

async function worker() {
  while (true) {
    const index = cursor++;
    if (index >= cards.length) return;
    await processOne(cards[index]);
    if ((index + 1) % 100 === 0) console.log(`Shard ${shardIndex}: ${index + 1}/${cards.length}`);
  }
}

const concurrency = Math.max(1, config.maxConcurrentRequestsPerShard || 4);
await Promise.all(Array.from({ length: concurrency }, () => worker()));

await fs.mkdir('work/shards', { recursive: true });
const result = {
  meta: {
    schemaVersion: 2,
    shardIndex,
    shardCount,
    catalogHash: catalog.hash,
    generatedAt: nowIso(),
    cardsAssigned: cards.length,
    variantsPriced: Object.keys(prices).length,
    unmatched: unmatched.length,
    fx
  },
  prices,
  unmatched
};
await fs.writeFile(`work/shards/shard-${shardTag}.json`, JSON.stringify(result));
console.log(`Shard ${shardIndex} concluído: ${cards.length} cartas, ${Object.keys(prices).length} variantes, ${unmatched.length} pendências.`);
