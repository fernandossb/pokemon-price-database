import assert from 'node:assert/strict';
import { normalizeLigaOffer, loadLigaOffers, summarizeLigaOffers } from './providers/ligaPokemon.mjs';

const now = Date.parse('2026-11-09T15:00:00.000Z');
const offer = (id, seller, priceBrl) => ({
  cardId: 'sv03.5-006', language: 'pt-br', variantEnum: 'normal',
  listingId: id, seller, condition: 'NM', priceBrl,
  url: 'https://www.ligapokemon.com.br/?view=prod/view&pcode=' + id,
  observedAt: '2026-11-09T14:00:00.000Z',
});
assert.equal(normalizeLigaOffer(offer('1', 'A', 10), now)?.priceBrl, 10);
assert.equal(normalizeLigaOffer({ ...offer('1', 'A', 10), url: 'https://example.com' }, now), null);
assert.equal(normalizeLigaOffer({ ...offer('1', 'A', 10), observedAt: '2026-10-01T00:00:00Z' }, now), null);
assert.equal(normalizeLigaOffer({ ...offer('1', 'A', 10), priceBrl: -5 }, now), null);
const sample = summarizeLigaOffers([
  offer('1','A',10), offer('2','B',40), offer('3','C',20), offer('4','C',100),
]);
assert.equal(sample.sellerCount, 3);
assert.equal(sample.medianPriceBrl, 20);
assert.equal(sample.minimumPriceBrl, 10);
assert.equal((await loadLigaOffers()).size, 0);
console.log('Liga Pokémon: validação, mediana e deduplicação aprovadas.');
