import assert from 'node:assert/strict';
import { marketValues, resolvePrice, variantCatalog } from './lib.mjs';

const card = {
  variants: {
    normal: true,
    holo: true,
    reverse: true,
    firstEdition: true,
    wPromo: true,
    futureParallelFoil: true,
  },
  pricing: {
    cardmarket: {
      trend: 2,
      avg30: 2.2,
      'trend-holo': 4,
      'avg30-holo': 4.2,
    },
    tcgplayer: {
      updated: 1,
      unit: 1,
      normal: { marketPrice: 2, midPrice: 2.5, lowPrice: 1.5 },
      holofoil: { marketPrice: 6, midPrice: 6.5, lowPrice: 5.5 },
      'reverse-holofoil': { marketPrice: 4, midPrice: 4.5, lowPrice: 3.5 },
      '1st-edition-holofoil': { marketPrice: 40, midPrice: 41, lowPrice: 39 },
      'galaxy-foil-future': { marketPrice: 9.5 },
    },
  },
};
const fx = { eurBrl: 6, usdBrl: 5 };
const catalog = variantCatalog(card);
const values = catalog.map(item => item.value);
for (const exact of ['normal', 'holo', 'reverse', 'firstEdition', 'wPromo', 'futureParallelFoil', 'holofoil', 'reverse-holofoil', '1st-edition-holofoil', 'galaxy-foil-future']) {
  assert(values.includes(exact), `Enum deve ser preservado: ${exact}`);
}

const future = resolvePrice({ card, variantEnum: 'galaxy-foil-future', fx });
assert(future && future.priceBrl === 47.5, 'Enum futuro deve receber o preço da chave exata');
assert.equal(resolvePrice({ card, variantEnum: 'Galaxy Foil Future', fx }), null, 'Nome traduzido/alterado não deve localizar preço');
assert.equal(resolvePrice({ card, variantEnum: 'reversa', fx }), null, 'Alias antigo não deve localizar preço');
assert(marketValues(card, '1st-edition-holofoil', fx).values.every(item => item.source.includes('1st-edition-holofoil')));

console.log('Enums dinâmicos aprovados: nenhum valor da fonte é descartado e a busca usa a string exata.');
