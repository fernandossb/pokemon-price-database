import assert from 'node:assert/strict';
import { marketValues, resolvePrice, variants } from './lib.mjs';

const fx = { eurBrl: 6, usdBrl: 5 };
const card = {
  variants: { normal: true, holo: true, reverse: true, firstEdition: true, wPromo: true },
  pricing: {
    cardmarket: {
      trend: 2, avg30: 3, low: 1,
      'trend-holo': 4, 'avg30-holo': 5, 'low-holo': 3,
    },
    tcgplayer: {
      normal: { marketPrice: 2, midPrice: 2.5, lowPrice: 1.5 },
      unlimited: { marketPrice: 3, midPrice: 3.5, lowPrice: 2.5 },
      holofoil: { marketPrice: 6, midPrice: 6.5, lowPrice: 5.5 },
      'reverse-holofoil': { marketPrice: 4, midPrice: 4.5, lowPrice: 3.5 },
      '1st-edition': { marketPrice: 20, midPrice: 21, lowPrice: 19 },
      '1st-edition-holofoil': { marketPrice: 40, midPrice: 41, lowPrice: 39 },
    },
  },
};

const all = variants(card);
assert(all.some(item => item.finish === 'normal' && item.printVariation === 'firstEdition' && item.stamp === 'stamped'));
assert(all.some(item => item.finish === 'reverse' && item.printVariation === 'unlimited' && item.stamp === 'unstamped'));

const unlimited = marketValues(card, { finish: 'normal', printVariation: 'unlimited', stamp: 'unstamped' }, fx);
assert.equal(unlimited.matchLevel, 'exact');
assert(unlimited.values.some(item => item.source.includes('tcgplayerMarket:unlimited')));
assert(unlimited.values.some(item => item.source === 'cardmarketTrend'));

const firstEdition = marketValues(card, { finish: 'normal', printVariation: 'firstEdition', stamp: 'unstamped' }, fx);
assert.equal(firstEdition.matchLevel, 'exact');
assert(firstEdition.values.every(item => !item.source.startsWith('cardmarket')));
assert(firstEdition.values.some(item => item.source.includes('1st-edition')));

const firstEditionPrice = resolvePrice({ card, variant: { finish: 'normal', printVariation: 'firstEdition', stamp: 'unstamped' }, fx });
assert(firstEditionPrice.priceBrl > 90, '1ª edição deve usar valores próprios, não o preço unlimited');
assert.equal(firstEditionPrice.matchLevel, 'exact');
assert.deepEqual(firstEditionPrice.estimatedDimensions, []);

const stamped = resolvePrice({ card, variant: { finish: 'holo', printVariation: 'unlimited', stamp: 'stamped' }, fx });
assert.equal(stamped.matchLevel, 'estimated');
assert(stamped.estimatedDimensions.includes('stamp'));
assert(stamped.confidence <= 34, 'carimbo sem preço estruturado deve exigir revisão no app');

const reverseFirst = resolvePrice({ card, variant: { finish: 'reverse', printVariation: 'firstEdition', stamp: 'unstamped' }, fx });
assert.equal(reverseFirst, null, 'não deve reutilizar preço reverse genérico para 1ª edição sem chave própria');

console.log('Variações: unlimited, 1ª edição, acabamento e carimbo separados sem mistura silenciosa.');
