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

// --- Prioridade de mercado: TCGplayer, depois TCGdex, depois Cardmarket ---

// A variante "normal" tem preço nos dois mercados. Só o TCGplayer entra na
// conta: 2, 2.5 e 1.5 dólares a 5 reais = média de 10.
const normal = resolvePrice({ card, variantEnum: 'normal', fx });
assert.equal(normal.priceMarket, 'tcgplayer', 'TCGplayer tem prioridade sobre o Cardmarket');
assert.equal(normal.priceBrl, 10, 'A média não pode misturar os dois mercados');
assert(
  normal.sources.some(item => item.source.startsWith('cardmarket:') && item.used === false),
  'O Cardmarket continua registrado como referência, marcado como não usado'
);
assert(
  normal.sources.filter(item => item.used).every(item => item.source.startsWith('tcgplayer:')),
  'Só valores do mercado escolhido podem entrar na conta'
);

// Sem TCGplayer para a variante, o Cardmarket assume: 3 e 3 euros a 6 reais.
const soCardmarket = resolvePrice({
  card: { pricing: { cardmarket: { trend: 3, avg30: 3 } } },
  variantEnum: 'normal',
  fx,
});
assert.equal(soCardmarket.priceMarket, 'cardmarket', 'Sem TCGplayer, usa o Cardmarket');
assert.equal(soCardmarket.priceBrl, 18);

console.log('Enums dinâmicos e prioridade de mercado aprovados: nenhum valor da fonte é descartado e a busca usa a string exata.');
