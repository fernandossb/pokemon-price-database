import fs from 'node:fs/promises';
import path from 'node:path';
import { enumForLigaOffer, offerLanguages, normalizeLigaOffer, MAX_BROWSER_SNAPSHOT_AGE_MS } from './providers/ligaPokemon.mjs';

const inputFile = path.resolve(process.argv[2] || 'data/ligapokemon-browser-capture.json');
const outputFile = path.resolve(process.env.LIGA_OFFERS_FILE || 'data/ligapokemon-offers.json');
const capture = JSON.parse(await fs.readFile(inputFile, 'utf8'));
const currentCatalog = JSON.parse(await fs.readFile('work/catalog.json', 'utf8'));
const coverage = capture?.coverage || {};
const batchCardCount = Number.isInteger(coverage.batchCardCount)
  ? coverage.batchCardCount : coverage.capturedCardCount;
let previousSnapshot = null;
try { previousSnapshot = JSON.parse(await fs.readFile(outputFile, 'utf8')); } catch {}
if (capture?.schemaVersion !== 1 || capture?.source !== 'ligapokemon-browser-capture'
  || typeof coverage.complete !== 'boolean'
  || coverage.catalogHash !== currentCatalog.hash
  || coverage.cardCount !== currentCatalog.count
  || !Array.isArray(capture.cards)
  || capture.cards.length !== batchCardCount
  || batchCardCount > coverage.capturedCardCount
  || (coverage.complete && coverage.capturedCardCount !== coverage.eligibleCardCount)
  || capture.cards.some(card => card.captured !== true)
  || coverage.capturedCardCount > coverage.eligibleCardCount
  || !Array.isArray(capture.excluded)
  || capture.excluded.length !== coverage.excludedCardCount
  || capture.excluded.some(item => !['digital_only_tcg_pocket', 'liga_print_unmatched', 'multiple_liga_prints_for_card_id'].includes(item.reason))
  || coverage.eligibleCardCount + coverage.excludedCardCount !== coverage.cardCount) {
  throw new Error('Captura de navegador parcial, com cartas físicas sem edição Liga validada ou incompatível com o catálogo atual; snapshot anterior preservado.');
}

const observedAt = new Date().toISOString();
const offers = [];
const errors = [];
const refreshedCardIds = new Set(capture.cards.map(card => String(card.cardId)));
const pendingMappings = (previousSnapshot?.pendingMappings || [])
  .filter(item => !refreshedCardIds.has(String(item.cardId)));
for (const card of capture.cards) {
  for (const row of (Array.isArray(card.unparsedRows) ? card.unparsedRows : []).slice(0, 500)) {
    pendingMappings.push({
      cardId: String(card.cardId),
      listingId: String(row?.listingId || '').slice(0, 120),
      reason: 'liga_language_unparsed',
      language: '',
      condition: String(row?.condition || '').slice(0, 12),
      priceBrl: Number(row?.priceBrl) || null,
      detail: String(row?.text || '').slice(0, 180),
    });
  }
}
for (const card of capture.cards) {
  const byLanguage = new Map();
  for (const { language, value } of card.availableEnums || []) {
    if (!byLanguage.has(language)) byLanguage.set(language, []);
    byLanguage.get(language).push({ value });
  }
  for (const raw of card.offers || []) {
    const observedMs = Date.parse(String(raw.observedAt || ''));
    if (Number.isFinite(observedMs) && observedMs < Date.now() - MAX_BROWSER_SNAPSHOT_AGE_MS) continue;
    const languages = offerLanguages(raw);
    if (!languages.length) {
      pendingMappings.push({ cardId: card.cardId, listingId: raw.listingId, reason: 'liga_language_unmapped', value: raw.language || '' });
      continue;
    }
    for (const language of languages) {
      const availableEnums = byLanguage.get(language) || [];
      if (!availableEnums.length) {
        pendingMappings.push({ cardId: card.cardId, listingId: raw.listingId, language, reason: 'app_language_variant_unmapped' });
        continue;
      }
      let variantEnum;
      try { variantEnum = enumForLigaOffer(raw, availableEnums); }
      catch (error) {
        pendingMappings.push({ cardId: card.cardId, listingId: raw.listingId, language, reason: 'liga_finish_unmapped', detail: error.message });
        continue;
      }
      if (!availableEnums.some(item => item.value === variantEnum)) {
        pendingMappings.push({ cardId: card.cardId, listingId: raw.listingId, language, reason: 'app_finish_variant_unmapped', value: raw.finish || '' });
        continue;
      }
      const offer = normalizeLigaOffer({
        cardId: card.cardId,
        language,
        variantEnum,
        listingId: `${raw.listingId}:${language}`,
        seller: raw.seller,
        sellerId: raw.sellerId,
        condition: raw.condition,
        priceBrl: raw.priceBrl,
        url: raw.url,
        observedAt: raw.observedAt,
      }, Date.now(), MAX_BROWSER_SNAPSHOT_AGE_MS);
      if (!offer) errors.push(`${card.cardId}/${raw.listingId}: anúncio inválido ou vencido.`);
      else offers.push(offer);
    }
  }
}

if (errors.length) {
  throw new Error(`Captura não convertida: ${errors.length} anúncios precisam de correspondência exata. Primeiro: ${errors.slice(0, 5).join(' | ')}`);
}

// A cada checkpoint, substitua somente as cartas que já foram relidas. Para as
// demais, mantenha anúncios ainda válidos do snapshot publicado anteriormente.
const previousOffers = previousSnapshot?.schemaVersion === 2
  && previousSnapshot?.source === 'ligapokemon' && Array.isArray(previousSnapshot.offers)
  ? previousSnapshot.offers : [];
const retainedOffers = previousOffers.filter(raw => !refreshedCardIds.has(String(raw.cardId)))
  .map(raw => normalizeLigaOffer(raw, Date.now(), MAX_BROWSER_SNAPSHOT_AGE_MS))
  .filter(Boolean);
const mergedOffers = [...retainedOffers, ...offers];

const snapshot = {
  schemaVersion: 2,
  source: 'ligapokemon',
  capturedAt: observedAt,
  coverage: {
    catalogHash: currentCatalog.hash,
    cardCount: currentCatalog.count,
    eligibleCardCount: coverage.eligibleCardCount,
    capturedCardCount: coverage.capturedCardCount,
    batchCardCount,
    complete: true,
    crawlComplete: coverage.complete,
    pendingVariantMappings: pendingMappings.length,
  },
  pendingMappings,
  offers: mergedOffers,
};
const temporary = `${outputFile}.tmp`;
await fs.mkdir(path.dirname(outputFile), { recursive: true });
await fs.writeFile(temporary, JSON.stringify(snapshot));
await fs.rename(temporary, outputFile);
console.log(JSON.stringify({
  snapshotFile: path.relative(process.cwd(), outputFile),
  catalogCards: currentCatalog.count,
  eligibleCards: coverage.eligibleCardCount,
  capturedCards: coverage.capturedCardCount,
  crawlComplete: coverage.complete,
  excludedCards: coverage.excludedCardCount,
  listingRows: mergedOffers.length,
  capturedAt: snapshot.capturedAt,
}, null, 2));
