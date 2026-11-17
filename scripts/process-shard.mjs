import fs from 'node:fs/promises';
import { getCard } from './providers/tcgdex.mjs';
import { assertLigaSnapshotCoversCatalog, fetchLigaPrintOffers, summarizeLigaOffers } from './providers/ligaPokemon.mjs';
import { config, nowIso, readJson, sleep, variantCatalog } from './lib.mjs';

const shardIndex = Number(process.env.SHARD_INDEX);
const shardCount = Number(process.env.SHARD_COUNT || config.shardCount || 12);
if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
  throw new Error(`SHARD_INDEX inválido: ${process.env.SHARD_INDEX}`);
}
const shardTag = String(shardIndex).padStart(2, '0');

const catalog = await readJson('work/catalog.json', null);
if (!catalog?.cards?.length) throw new Error('work/catalog.json ausente ou vazio');
const sourceSnapshot = await assertLigaSnapshotCoversCatalog(catalog);
const snapshotId = String(process.env.LIGA_SNAPSHOT_ID || '');
if (!snapshotId) throw new Error('LIGA_SNAPSHOT_ID ausente; coleta cancelada.');
const cards = catalog.cards.filter((_, index) => index % shardCount === shardIndex);
// O TCGdex só fornece catálogo/variantes. Os preços deste lote vêm de chamadas
// live à Liga; nenhuma fonte nem cache anterior pode preencher uma ausência.
const ligaOffers = new Map();
let ligaFetchedAtMin = null;
let ligaFetchedAtMax = null;
const ligaFetchedAtSources = new Set();
let ligaOfferCount = 0;
if (sourceSnapshot) {
  const capturedMs = Date.parse(sourceSnapshot.capturedAt);
  ligaFetchedAtMin = capturedMs;
  ligaFetchedAtMax = capturedMs;
  ligaFetchedAtSources.add(sourceSnapshot.source);
}

// Recriar de zero: um preço que não veio do snapshot atual da Liga não pode
// sobreviver por reaproveitamento de cache.
const prices = {};
const variantsByCard = {};
const unmatched = [];
let cursor = 0;

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
  if (failures.length) {
    throw new Error(`TCGdex não carregou todos os idiomas catalogados para ${summary.id}: ${failures.join(', ')}.`);
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

function discoverLigaVariants(card) {
  // O indicador `priced` representa preço presente neste banco, não preço em
  // TCGplayer/Cardmarket republicado pelo TCGdex.
  return variantCatalog(card).map(item => ({ ...item, priced: false }));
}

async function processOne(summary) {
  const loadedList = await fetchAllLanguages(summary);
  if (!loadedList.length) {
    throw new Error(`TCGdex não carregou ${summary.id}; interrompendo sem reaproveitar preços antigos.`);
  }
  const allEnums = new Map();
  for (const { card, language } of loadedList) {
    const available = variantCatalog(card);
    for (const item of available) allEnums.set(`${language}::${item.value}`, { language, ...item });
  }

  const primaryCard = loadedList[0].card;
  if (summary.marketplaceEligible) {
    const edition = String(summary.edition || '').trim();
    const number = String(summary.localId || '').trim();
    const detailUrl = String(summary.detailUrl || '').trim();
    if (!edition || !number || !detailUrl || summary.editionSource !== 'ligapokemon-browser') {
      throw new Error(`Impressão sem vínculo confirmado à Liga para ${summary.id}; coleta cancelada.`);
    }
    const cardLabel = `${summary.ligaName || primaryCard.name} (${number}/${summary.setTotal || ''})`;
    const fetched = await fetchLigaPrintOffers({
      card: cardLabel,
      edition,
      number,
      cardId: summary.id,
      availableEnums: [...allEnums.values()],
    });
    const fetchedMs = Date.parse(fetched.fetchedAt);
    ligaFetchedAtMin = ligaFetchedAtMin === null ? fetchedMs : Math.min(ligaFetchedAtMin, fetchedMs);
    ligaFetchedAtMax = ligaFetchedAtMax === null ? fetchedMs : Math.max(ligaFetchedAtMax, fetchedMs);
    for (const source of fetched.fetchedAtSources || []) ligaFetchedAtSources.add(source);
    ligaOfferCount += fetched.offers.length;
    for (const offer of fetched.offers) {
      const key = `${offer.cardId}::${offer.language}::${offer.variantEnum}`;
      if (!ligaOffers.has(key)) ligaOffers.set(key, []);
      ligaOffers.get(key).push(offer);
    }
  }

  for (const { card, language } of loadedList) {
    const available = discoverLigaVariants(card);
    mergeVariantCatalog(card.id, language, available);
    for (const enumInfo of available) {
      const variantEnum = enumInfo.value;
      const key = `${card.id}::${language}::${variantEnum}`;
      const liga = summarizeLigaOffers(ligaOffers.get(key));
      // Toda oferta M/NM individual já é um preço da Liga ligado; a mediana
      // usa um valor por vendedor e funciona também com apenas uma loja.
      const ligaReference = liga && liga.sellerCount >= 1 ? {
        priceBrl: liga.medianPriceBrl,
        confidence: Math.min(85, 35 + liga.sellerCount * 10),
        matchLevel: 'exact',
        estimatedDimensions: [],
        priceMarket: 'ligapokemon',
        sourceEnums: [{ provider: 'ligapokemon', value: variantEnum }],
        sources: liga.offers.map(offer => ({
          source: 'ligapokemon:listing', valueBrl: offer.priceBrl, used: true,
          detail: offer.url, seller: offer.seller, sellerId: offer.sellerId || null, listingId: offer.listingId,
          condition: offer.condition, observedAt: offer.observedAt,
        })),
      } : null;
      const resolved = ligaReference;
      if (!resolved) {
        unmatched.push({
          id: card.id,
          language,
          variantEnum,
          sources: enumInfo.sources,
          reason: summary.marketplaceEligible ? 'no_exact_price_for_enum' : 'liga_print_unmatched',
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
        name: summary.ligaName || card.name,
        number: summary.localId,
        edition: summary.edition || null,
        editionId: summary.ligaEditionId || null,
        editionSource: summary.editionSource || null,
        detailUrl: summary.detailUrl || null,
        // Total impresso na carta ("015/094" usa o oficial, não o total com
        // secretas). Ambos são publicados para a identificação exata no app.
        setTotal: summary.setTotal || null,
        setTotalWithSecrets: card.set?.cardCount?.total ?? null,
        setId: card.set?.id || null,
        setName: summary.setName || card.set?.name || null,
        rarity: card.rarity || null,
        illustrator: card.illustrator || null,
        promotional: Boolean(card.set?.id?.toLowerCase().includes('promo')),
        updatedAt: nowIso(),
        ...resolved,
        ...(liga ? { brazilMarket: {
          source: 'ligapokemon', sellerCount: liga.sellerCount,
          medianPriceBrl: liga.medianPriceBrl,
          minimumPriceBrl: liga.minimumPriceBrl,
          maximumPriceBrl: liga.maximumPriceBrl,
          usedForPrice: Boolean(ligaReference),
          listingUrls: liga.offers.map(item => item.url),
        }} : {}),
      };
      mergeVariantCatalog(card.id, language, [{ ...enumInfo, priced: true }]);
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
    priceSource: 'ligapokemon',
    ligaSnapshotId: snapshotId,
    ligaFetchedAtMin: ligaFetchedAtMin === null ? null : new Date(ligaFetchedAtMin).toISOString(),
    ligaFetchedAtMax: ligaFetchedAtMax === null ? null : new Date(ligaFetchedAtMax).toISOString(),
    ligaFetchedAtSources: [...ligaFetchedAtSources].sort(),
    ligaOffersCount: ligaOfferCount,
  },
  prices,
  variantCatalog: variantsByCard,
  unmatched,
};
await fs.writeFile(`work/shards/shard-${shardTag}.json`, JSON.stringify(result));
console.log(`Shard ${shardIndex} concluído: ${cards.length} cartas, ${Object.keys(prices).length} enums com preço, ${unmatched.length} pendências.`);
