import fs from 'node:fs/promises';
import { getCard } from './providers/tcgdex.mjs';
import { searchCardPrice } from './providers/ligaPokemon.mjs';
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
const previousShard = Number(previousShardRaw?.meta?.schemaVersion) === 4
  ? previousShardRaw
  : { prices: {}, variantCatalog: {} };
const prices = previousShard.prices || {};
const variantsByCard = previousShard.variantCatalog || {};
const unmatched = [];
let cursor = 0;

// Preço nacional é best-effort e tem interruptor próprio em config.json —
// se o endpoint da Liga começar a bloquear/mudar, dá para desligar sem
// deploy de código. Nenhuma falha aqui derruba o shard: cai para as fontes
// internacionais como já acontecia antes desta fonte existir.
const ligaConfig = config.ligaPokemon || {};
const ligaEnabled = ligaConfig.enabled !== false;
let ligaMatched = 0;

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

  // Preço nacional só é buscado quando a carta pt-br tem exatamente uma
  // variante: a busca da Liga não distingue normal de holo pelo número da
  // carta, então aplicar o mesmo valor às duas seria misturar preços de
  // acabamentos diferentes — o tipo de coisa que este projeto evita.
  let ligaPrice = null;
  if (ligaEnabled) {
    const ptBr = loadedList.find(entry => entry.language === 'pt-br');
    const ptBrEnums = ptBr ? enumsByLanguage.get('pt-br') : null;
    const total = ptBr?.card.set?.cardCount?.official;
    if (ptBr && ptBrEnums?.length === 1 && ptBr.card.localId && Number.isFinite(total) && total > 0) {
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
      const key = `${card.id}::${language}::${variantEnum}`;
      const applicableLiga = language === 'pt-br' && available.length === 1 ? ligaPrice : null;
      const resolved = resolvePrice({ card, variantEnum, fx, ligaPrice: applicableLiga });
      if (!resolved) {
        unmatched.push({
          id: card.id,
          language,
          variantEnum,
          sources: enumInfo.sources,
          reason: 'no_exact_price_for_enum',
          checkedAt: nowIso(),
        });
        delete prices[key];
        continue;
      }
      prices[key] = {
        cardId: card.id,
        language,
        variantEnum,
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
    schemaVersion: 4,
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
