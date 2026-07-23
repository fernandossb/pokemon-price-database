import fs from 'node:fs/promises';
import { getCard } from './providers/tcgdex.mjs';
import { loadBrazilianPrices } from './providers/brCsv.mjs';
import { config, finishes, getFx, nowIso, readJson, resolvePrice, sleep } from './lib.mjs';

const shardIndex = Number(process.env.SHARD_INDEX);
const shardCount = Number(process.env.SHARD_COUNT || config.shardCount || 12);
if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
  throw new Error(`SHARD_INDEX inválido: ${process.env.SHARD_INDEX}`);
}

const catalog = await readJson('work/catalog.json', null);
if (!catalog?.cards?.length) throw new Error('work/catalog.json ausente ou vazio');
const cards = catalog.cards.filter((_, index) => index % shardCount === shardIndex);
const fx = await getFx();
const brSources = await loadBrazilianPrices();
const previousShard = await readJson(`cache/shards/shard-${String(shardIndex).padStart(2, '0')}.json`, { prices: {} });
const prices = previousShard.prices || {};
const unmatched = [];
let cursor = 0;
let active = 0;

async function fetchFull(summary) {
  const languages = summary.availableLanguages?.length ? summary.availableLanguages : config.languages;
  let lastError;
  for (const language of languages) {
    for (let attempt = 1; attempt <= (config.maxAttemptsPerCard || 3); attempt += 1) {
      try {
        const card = await getCard(language, summary.id);
        if (card) return { card, language };
      } catch (error) {
        lastError = error;
        if (attempt < (config.maxAttemptsPerCard || 3)) await sleep((config.retryDelayMs || 500) * attempt);
      }
    }
  }
  if (lastError) console.warn(`${summary.id}: ${lastError.message}`);
  return null;
}

async function processOne(summary) {
  const loaded = await fetchFull(summary);
  if (!loaded) {
    unmatched.push({ id: summary.id, reason: 'card_not_loaded', checkedAt: nowIso() });
    return;
  }
  const { card, language } = loaded;
  for (const finish of finishes(card)) {
    const key = `${card.id}::${finish}`;
    const resolved = resolvePrice(card, finish, brSources, fx);
    if (!resolved) {
      unmatched.push({ id: card.id, finish, reason: 'no_market_data', checkedAt: nowIso() });
      continue;
    }
    prices[key] = {
      cardId: card.id,
      finish,
      name: card.name,
      number: card.localId,
      setId: card.set?.id || null,
      setName: card.set?.name || null,
      illustrator: card.illustrator || null,
      promotional: Boolean(card.set?.id?.toLowerCase().includes('promo')),
      language,
      updatedAt: nowIso(),
      ...resolved
    };
  }
  await sleep(config.requestDelayMs || 80);
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
const filename = `work/shards/shard-${String(shardIndex).padStart(2, '0')}.json`;
await fs.writeFile(filename, JSON.stringify(result));
console.log(`Shard ${shardIndex} concluído: ${cards.length} cartas, ${Object.keys(prices).length} variantes, ${unmatched.length} pendências.`);
