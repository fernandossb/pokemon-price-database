import { loadLigaOfferSnapshot, summarizeLigaOffers } from './providers/ligaPokemon.mjs';

const file = String(process.env.LIGA_OFFERS_FILE || process.argv[2] || 'data/ligapokemon-offers.json').trim();
const snapshot = await loadLigaOfferSnapshot(file);
let qualifiedVariants = 0;
let underSellerThreshold = 0;
for (const offers of snapshot.groups.values()) {
  const summary = summarizeLigaOffers(offers);
  if (summary?.sellerCount >= 1) qualifiedVariants += 1;
  else if (summary) underSellerThreshold += 1;
}

console.log(JSON.stringify({
  source: 'ligapokemon-listings',
  capturedAt: snapshot.capturedAt,
  offers: snapshot.offerCount,
  cards: new Set([...snapshot.groups.keys()].map(key => key.split('::', 1)[0])).size,
  cardLanguageVariants: snapshot.groups.size,
  variantsWithThreeOrMoreNMListings: qualifiedVariants,
  variantsWithFewerThanThreeSellers: underSellerThreshold,
}, null, 2));
