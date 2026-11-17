import assert from 'node:assert/strict';
import { fetchLigaPrintOffers, normalizeLigaOffer, loadLigaOffers, summarizeLigaOffers } from './providers/ligaPokemon.mjs';

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

const validLiveOffers = [
  { offer_id: 'a1', store_id: 11, store_name: 'Loja A', price_brl: 10, condition: 'M', language: 'PT', extras: ['Foil'], is_foil: true },
  { offer_id: 'b1', store_id: 12, store_name: 'Loja B', price_brl: 20, condition: 'NM', language: 'PT', extras: ['Foil'], is_foil: true },
  { offer_id: 'c1', store_id: 13, store_name: 'Loja C', price_brl: 40, condition: 'NM', language: 'PT', extras: ['Foil'], is_foil: true },
];
let capturedRequest;
const liveFetchedAt = new Date().toISOString();
const fakeFetch = async (url, options) => {
  capturedRequest = { url, options, body: JSON.parse(options.body) };
  return new Response(JSON.stringify({
    ok: true,
    meta: { api: 'ligapokemon', endpoint: 'card', mode: 'live', latency_ms: 12000, record_count: 3, cache_hit: false, fetched_at: liveFetchedAt },
    data: { editions: [{ edition_code: 'MEW', number: '006' }], offers: validLiveOffers },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const live = await fetchLigaPrintOffers({
  card: 'Charizard ex (006/165)', edition: 'MEW', number: '006', cardId: 'mew-006',
  availableEnums: [{ language: 'pt-br', value: 'holofoil' }],
  apiKey: 'unit-test-only', fetchImpl: fakeFetch,
});
assert.equal(capturedRequest.url, 'https://api.reefapi.com/ligapokemon/v1/card');
assert.equal(capturedRequest.options.headers['x-api-key'], 'unit-test-only');
assert.equal(capturedRequest.body.language, 'PT,EN,PTEN,JP');
assert.equal(capturedRequest.body.condition, 'NM');
assert.equal(live.offers.length, 3);
assert.equal(live.fetchedAt, liveFetchedAt);
assert.deepEqual(live.fetchedAtSources, ['reefapi-meta']);
assert.equal(summarizeLigaOffers(live.offers).medianPriceBrl, 20);

const liveWithoutSourceTimestamp = await fetchLigaPrintOffers({
  card: 'Charizard ex (006/165)', edition: 'MEW', number: '006', cardId: 'mew-006',
  availableEnums: [{ language: 'pt-br', value: 'holofoil' }], apiKey: 'unit-test-only',
  fetchImpl: async () => new Response(JSON.stringify({
    ok: true,
    meta: { api: 'ligapokemon', endpoint: 'card', mode: 'live', latency_ms: 12000, record_count: 3, cache_hit: false },
    data: { editions: [{ edition_code: 'MEW', number: '006' }], offers: validLiveOffers },
  }), { status: 200, headers: { 'content-type': 'application/json' } }),
});
assert.deepEqual(liveWithoutSourceTimestamp.fetchedAtSources, ['response-received']);
assert.ok(Number.isFinite(Date.parse(liveWithoutSourceTimestamp.fetchedAt)));

await assert.rejects(() => fetchLigaPrintOffers({
  card: 'Charizard ex (006/165)', edition: 'MEW', number: '006', cardId: 'mew-006',
  availableEnums: [{ language: 'pt-br', value: 'holofoil' }], apiKey: 'unit-test-only',
  fetchImpl: async () => new Response(JSON.stringify({
    ok: true,
    meta: { api: 'ligapokemon', endpoint: 'card', mode: 'live', latency_ms: 12000, record_count: 3, cache_hit: false, fetched_at: new Date().toISOString() },
    data: {
      editions: [{ edition_code: 'MEW', number: '006' }],
      offers: [{ ...validLiveOffers[0], offer_id: 'special', extras: ['Foil Etched'], is_foil: true }],
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } }),
}), /Acabamento especial da Liga sem enum exato/);

console.log('Liga Pokémon: validação, mediana e deduplicação aprovadas.');
