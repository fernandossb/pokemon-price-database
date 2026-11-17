import { getCard } from './providers/tcgdex.mjs';
import { fetchLigaPrintOffers, summarizeLigaOffers } from './providers/ligaPokemon.mjs';
import { config, variantCatalog } from './lib.mjs';

const cardId = String(process.argv[2] || process.env.LIGA_PILOT_CARD_ID || '').trim();
if (!process.env.REEF_API_KEY) {
  throw new Error('REEF_API_KEY ausente. O piloto não fez nenhuma chamada à Liga.');
}
if (!cardId) throw new Error('Informe o ID TCGdex: npm run liga:pilot -- <cardId>');

const loaded = [];
for (const language of config.languages) {
  try {
    const card = await getCard(language, cardId);
    if (card) loaded.push({ card, language });
  } catch {
    // O idioma pode não existir para esta impressão; outros idiomas seguem.
  }
}
if (!loaded.length) throw new Error(`TCGdex não encontrou ${cardId} em nenhum idioma configurado.`);

const availableEnums = loaded.flatMap(({ card, language }) =>
  variantCatalog(card).map(item => ({ language, ...item })));
const primary = loaded[0].card;
const edition = String(primary.set?.abbreviation?.official || '').trim();
const number = String(primary.localId || '').trim();
const denominator = String(primary.set?.cardCount?.official || '').trim();
if (!edition || !number || !denominator) {
  throw new Error(`TCGdex não forneceu código oficial/número/total para ${cardId}.`);
}

const result = await fetchLigaPrintOffers({
  card: `${primary.name} (${number}/${denominator})`,
  edition,
  number,
  cardId,
  availableEnums,
});
const grouped = new Map();
for (const offer of result.offers) {
  const key = `${offer.language}::${offer.variantEnum}`;
  if (!grouped.has(key)) grouped.set(key, []);
  grouped.get(key).push(offer);
}
const prices = [...grouped.entries()].map(([key, offers]) => {
  const summary = summarizeLigaOffers(offers);
  return {
    key,
    validOffers: offers.length,
    distinctSellers: summary?.sellerCount || 0,
    medianBrl: summary?.medianPriceBrl ?? null,
    hasLigaPriceLink: Boolean(summary && summary.sellerCount >= 1),
  };
});

console.log(JSON.stringify({
  source: 'ligapokemon',
  mode: 'live',
  cardId,
  print: result.print,
  fetchedAt: result.fetchedAt,
  fetchedAtSources: result.fetchedAtSources,
  rawMappedOffers: result.offers.length,
  prices,
}, null, 2));
