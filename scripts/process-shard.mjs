import fs from 'node:fs/promises';
import { getCard } from './providers/tcgdex.mjs';
import { searchCardPrice } from './providers/ligaPokemon.mjs';
import { loadBrazilianPrices } from './providers/brCsv.mjs';
import { config, getFx, nowIso, readJson, resolvePrice, sleep, variantCatalog } from './lib.mjs';

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

const previousShardRaw = await readJson(`cache/shards/shard-${shardTag}.json`, { prices: {}, variantCatalog: {} });
const previousShard = Number(previousShardRaw?.meta?.schemaVersion) === 5
  ? previousShardRaw
  : { prices: {}, variantCatalog: {} };
const prices = previousShard.prices || {};
const variantsByCard = previousShard.variantCatalog || {};
const unmatched = [];
let cursor = 0;

// Preço nacional automático é best-effort e tem interruptor próprio em
// config.json — se o endpoint da Liga começar a bloquear/mudar, dá para
// desligar sem deploy de código. Nenhuma falha aqui derruba o shard: cai
// para as fontes internacionais como já acontecia antes desta fonte existir.
const ligaConfig = config.ligaPokemon || {};
const ligaEnabled = ligaConfig.enabled !== false;
let ligaMatched = 0;

// Preço conferido manualmente (data/br-prices.csv) — uma pessoa olhando a
// Liga Pokémon como qualquer cliente, sem automação, para a condição exata
// de cartas cadastradas. Indexado por "cardId::language::finish" para achar
// rápido quais condições existem para cada enum sem varrer o mapa inteiro.
const brManualPrices = await loadBrazilianPrices();
const brManualConditionsByEnum = new Map();
for (const key of brManualPrices.keys()) {
  const lastSep = key.lastIndexOf('::');
  const prefix = key.slice(0, lastSep);
  const condition = key.slice(lastSep + 2);
  if (!brManualConditionsByEnum.has(prefix)) brManualConditionsByEnum.set(prefix, new Set());
  brManualConditionsByEnum.get(prefix).add(condition);
}

// Condições publicadas numa execução anterior, para o mesmo fim: sem isto,
// uma condição que já não tem preço nenhum (CSV editado, Liga sem estoque)
// nunca seria apagada — ficaria presa no banco publicado para sempre.
const previousConditionsByPrefix = new Map();
for (const key of Object.keys(prices)) {
  const parts = key.split('::');
  if (parts.length !== 4) continue;
  const [cardId, language, variantEnum, condition] = parts;
  const prefix = `${cardId}::${language}::${variantEnum}`;
  if (!previousConditionsByPrefix.has(prefix)) previousConditionsByPrefix.set(prefix, new Set());
  previousConditionsByPrefix.get(prefix).add(condition);
}

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
  const loadedList = await fetchAllLanguages(summary);
  if (!loadedList.length) {
    unmatched.push({ id: summary.id, reason: 'card_not_loaded', checkedAt: nowIso() });
    return;
  }

  const enumsByLanguage = new Map(loadedList.map(({ card, language }) => [language, variantCatalog(card)]));

  // Preço nacional automático: busca só pt-br, num endpoint público sem
  // login/cookie. É um preço só, sem recorte de condição — por isso só é
  // aplicado à condição "mercado" mais abaixo, nunca a uma condição
  // específica (essa vem só de data/br-prices.csv, conferida por pessoa).
  let ligaPrice = null;
  if (ligaEnabled) {
    const ptBr = loadedList.find(entry => entry.language === 'pt-br');
    const total = ptBr?.card.set?.cardCount?.official;
    if (ptBr && ptBr.card.localId && Number.isFinite(total) && total > 0) {
      ligaPrice = await searchCardPrice(
        { name: ptBr.card.name, num: ptBr.card.localId, total },
        { attempts: ligaConfig.maxAttempts, retryDelayMs: ligaConfig.retryDelayMs, maxPages: ligaConfig.maxPages },
      );
      if (ligaPrice) ligaMatched += 1;
      await sleep(ligaConfig.requestDelayMs ?? config.requestDelayMs ?? 80);
    }
  }

  for (const { card, language } of loadedList) {
    const available = enumsByLanguage.get(language);
    mergeVariantCatalog(card.id, language, available);
    for (const enumInfo of available) {
      const variantEnum = enumInfo.value;
      const prefix = `${card.id}::${language}::${variantEnum}`;

      // "mercado" é sempre publicada (preço sem condição específica, igual
      // ao banco antes de existir a dimensão de condição). As demais só
      // existem quando há cadastro manual para elas agora ou existiam na
      // publicação anterior (para poder ser removida quando some do CSV).
      const conditions = new Set([
        'mercado',
        ...(brManualConditionsByEnum.get(prefix) ?? []),
        ...(previousConditionsByPrefix.get(prefix) ?? []),
      ]);

      for (const condition of conditions) {
        const key = `${prefix}::${condition}`;
        const brManualValues = brManualPrices.get(key) ?? null;
        const resolved = resolvePrice({
          card,
          variantEnum,
          fx,
          ligaPrice: condition === 'mercado' && language === 'pt-br' ? ligaPrice : null,
          brManualValues,
        });
        if (!resolved) {
          if (condition === 'mercado') {
            unmatched.push({
              id: card.id,
              language,
              variantEnum,
              sources: enumInfo.sources,
              reason: 'no_exact_price_for_enum',
              checkedAt: nowIso(),
            });
          }
          delete prices[key];
          continue;
        }
        prices[key] = {
          cardId: card.id,
          language,
          variantEnum,
          condition,
          enumSources: enumInfo.sources,
          enumKinds: enumInfo.kinds,
          name: card.name,
          number: card.localId,
          // Total impresso na carta ("015/094" usa o oficial, não o total com
          // secretas). Ambos são publicados para a identificação exata no app.
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
      }
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
    schemaVersion: 5,
    shardIndex,
    shardCount,
    catalogHash: catalog.hash,
    generatedAt: nowIso(),
    cardsAssigned: cards.length,
    variantsDiscovered: Object.values(variantsByCard).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0),
    variantsPriced: Object.keys(prices).length,
    unmatched: unmatched.length,
    ligaPokemonMatched: ligaMatched,
    fx,
  },
  prices,
  variantCatalog: variantsByCard,
  unmatched,
};
await fs.writeFile(`work/shards/shard-${shardTag}.json`, JSON.stringify(result));
console.log(`Shard ${shardIndex} concluído: ${cards.length} cartas, ${Object.keys(prices).length} enums com preço, ${ligaMatched} com preço nacional (Liga Pokémon), ${unmatched.length} pendências.`);
