import fs from 'node:fs/promises';
import { getCard } from './providers/tcgdex.mjs';
import { assertLigaSnapshotCoversCatalog, fetchLigaPrintOffers, summarizeLigaOffers, MAX_BROWSER_SNAPSHOT_AGE_MS } from './providers/ligaPokemon.mjs';
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
const assignedCards = catalog.cards.filter((_, index) => index % shardCount === shardIndex);
const deltaIdsFile = String(process.env.LIGA_DELTA_CARD_IDS_FILE || '').trim();
const requestedDeltaIds = deltaIdsFile ? await readJson(deltaIdsFile, null) : null;
const previousShard = await readJson(`output/shards/shard-${shardTag}.json`, null);
const canReusePrevious = Boolean(sourceSnapshot && Array.isArray(requestedDeltaIds)
  && previousShard?.meta?.format === 'price-shard-v2'
  && Number(previousShard.meta.schemaVersion) === 4
  && previousShard.meta.catalogHash === catalog.hash
  && Number(previousShard.meta.shardIndex) === shardIndex);
const deltaIds = new Set(Array.isArray(requestedDeltaIds) ? requestedDeltaIds.map(String) : []);
const cards = canReusePrevious
  ? assignedCards.filter(card => deltaIds.has(String(card.id)))
  : assignedCards;
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

// For checkpoint runs, preserve only validated prices from the last published
// snapshot for cards outside this delta; changed cards are recalculated below.
// Stale offers and prices are removed using the same 30-day snapshot window.
const prices = canReusePrevious ? { ...(previousShard.prices || {}) } : {};
const variantsByCard = canReusePrevious ? { ...(previousShard.variantCatalog || {}) } : {};
let unmatched = [];
if (canReusePrevious) {
  const oldUnmatched = await readJson('output/unmatched-cards.json', []);
  const assignedIds = new Set(assignedCards.map(card => String(card.id)));
  unmatched = Array.isArray(oldUnmatched) ? oldUnmatched.filter(item => assignedIds.has(String(item.id))) : [];
  const changedIds = new Set(cards.map(card => String(card.id)));
  const expired = [];
  for (const [key, value] of Object.entries(prices)) {
    const cardId = String(value?.cardId || key.split('::', 1)[0]);
    if (changedIds.has(cardId)) {
      delete prices[key];
      continue;
    }
    const sources = Array.isArray(value?.sources) ? value.sources : [];
    if (!sources.length || sources.some(source => {
      const observedAt = Date.parse(String(source?.observedAt || ''));
      return !Number.isFinite(observedAt) || observedAt < Date.now() - MAX_BROWSER_SNAPSHOT_AGE_MS;
    })) {
      expired.push({ id: cardId, language: value?.language, variantEnum: value?.variantEnum,
        sources: value?.enumSources || [], reason: 'liga_price_expired', checkedAt: nowIso() });
      delete prices[key];
    }
  }
  for (const cardId of changedIds) delete variantsByCard[cardId];
  const expiredKeys = new Set(expired.map(item => `${item.id}::${item.language || ''}::${item.variantEnum || ''}`));
  unmatched = unmatched.filter(item => !changedIds.has(String(item.id))
    && !expiredKeys.has(`${item.id}::${item.language || ''}::${item.variantEnum || ''}`));
  unmatched.push(...expired);
}
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

for (const [cardId, variants] of Object.entries(variantsByCard)) {
  const priced = new Set(Object.values(prices)
    .filter(item => String(item?.cardId || '') === cardId)
    .map(item => `${item.language}::${item.variantEnum}`));
  for (const item of variants || []) item.priced = priced.has(`${item.language}::${item.value}`);
}

if (sourceSnapshot) {
  const catalogIndex = new Map(catalog.cards.map((card, index) => [String(card.id), index % shardCount]));
  ligaOfferCount = 0;
  for (const [key, offers] of sourceSnapshot.groups) {
    const cardId = key.split('::', 1)[0];
    if (catalogIndex.get(cardId) === shardIndex) ligaOfferCount += offers.length;
  }
}

await fs.mkdir('work/shards', { recursive: true });
const result = {
  meta: {
    schemaVersion: 4,
    shardIndex,
    shardCount,
    catalogHash: catalog.hash,
    generatedAt: nowIso(),
    cardsAssigned: assignedCards.length,
    cardsProcessed: cards.length,
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
