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

// --- Versões com foil especial (variants_detailed do TCGdex) ---

// Vileplume 003/094: holo e reverse no produto da carta; a Cosmos Holo é o
// produto 684043, sem preço no TCGdex — o preço vem do tcgcsv.
const vileplume = {
  variants: { normal: false, holo: true, reverse: true },
  pricing: { tcgplayer: { holofoil: { marketPrice: 0.17 }, 'reverse-holofoil': { marketPrice: 0.26 } }, cardmarket: { trend: 0.04 } },
  variants_detailed: [
    { type: 'holo', size: 'standard', thirdParty: { tcgplayer: 662238 } },
    { type: 'reverse', size: 'standard', thirdParty: { tcgplayer: 662238 } },
    { type: 'holo', size: 'standard', foil: 'cosmos', thirdParty: { tcgplayer: 684043, cardmarket: 884287 },
      pricing: { tcgplayer: null, cardmarket: { avg: 0.22, trend: 0.3 } } },
    // Carimbo não ganha enum próprio aqui.
    { type: 'normal', size: 'standard', stamp: ['set-logo'], pricing: { cardmarket: { avg: 88 } } },
  ],
};
const produtos = { 684043: { holofoil: { marketPrice: 0.29, midPrice: 0.35 } } };
const catalogoVileplume = variantCatalog(vileplume, produtos);
const cosmos = catalogoVileplume.find(item => item.value === 'cosmos-holofoil');
assert(cosmos, 'A Cosmos Holo vira o enum cosmos-holofoil na própria carta');
assert.deepEqual(cosmos.kinds, ['special-foil'], 'Marcada como foil especial, não como versão básica');
assert.deepEqual(cosmos.sources, ['tcgdex'], 'Não conta como versão vendida no produto da carta');
assert(cosmos.priced);
assert(!catalogoVileplume.some(item => /set-logo|stamp/.test(item.value)), 'Carimbo fica de fora');
const precoCosmos = resolvePrice({ card: vileplume, variantEnum: 'cosmos-holofoil', fx, tcgplayerProducts: produtos });
assert.equal(precoCosmos.priceMarket, 'tcgplayer', 'Cosmos: preço do produto no TCGplayer');
assert.equal(precoCosmos.priceBrl, 1.6, 'Média de 0,29 e 0,35 dólar a 5 reais');
assert(precoCosmos.sources.every(item => item.source.includes('cosmos-holofoil')), 'Nunca o preço da carta comum');
// Sem o tcgcsv, vale o Cardmarket daquele produto: 0,22 e 0,3 euro a 6 reais.
const cosmosSoCardmarket = resolvePrice({ card: vileplume, variantEnum: 'cosmos-holofoil', fx });
assert.equal(cosmosSoCardmarket.priceMarket, 'cardmarket');
assert.equal(cosmosSoCardmarket.priceBrl, 1.56);
// A holo da carta não muda.
assert.equal(resolvePrice({ card: vileplume, variantEnum: 'holofoil', fx, tcgplayerProducts: produtos }).priceBrl, 0.85);

// Prismatic Evolutions: Poké Ball e Master Ball são reverses com produto e
// preço próprios já no TCGdex.
const exeggcute = {
  variants: { normal: true, reverse: true },
  pricing: { tcgplayer: { normal: { marketPrice: 0.1 }, 'reverse-holofoil': { marketPrice: 0.3 } } },
  variants_detailed: [
    { type: 'reverse', size: 'standard', foil: 'pokeball', thirdParty: { tcgplayer: 610536 }, pricing: { tcgplayer: { unit: 'USD', holofoil: { marketPrice: 0.8 } } } },
    { type: 'reverse', size: 'standard', foil: 'masterball', thirdParty: { tcgplayer: 610637 }, pricing: { tcgplayer: { unit: 'USD', holofoil: { marketPrice: 4 } } } },
  ],
};
const valoresExeggcute = variantCatalog(exeggcute).map(item => item.value);
assert(valoresExeggcute.includes('pokeball-holofoil') && valoresExeggcute.includes('masterball-holofoil'), 'Poké Ball e Master Ball com o nome que o app usa');
assert.equal(resolvePrice({ card: exeggcute, variantEnum: 'masterball-holofoil', fx }).priceBrl, 20);

// Mesmo foil em holo e em reverse: o reverse ganha nome próprio.
const ambos = variantCatalog({ variants_detailed: [
  { type: 'reverse', size: 'standard', foil: 'cosmos', pricing: { cardmarket: { avg: 1 } } },
  { type: 'holo', size: 'standard', foil: 'cosmos', pricing: { cardmarket: { avg: 2 } } },
] }).map(item => item.value).sort();
assert.deepEqual(ambos, ['cosmos-holofoil', 'cosmos-reverse-holofoil']);
assert.equal(resolvePrice({ card: { variants_detailed: [
  { type: 'reverse', size: 'standard', foil: 'cosmos', pricing: { cardmarket: { avg: 1 } } },
  { type: 'holo', size: 'standard', foil: 'cosmos', pricing: { cardmarket: { avg: 2 } } },
] }, variantEnum: 'cosmos-holofoil', fx }).priceBrl, 12, 'cosmos-holofoil é a holo');

console.log('Enums dinâmicos e prioridade de mercado aprovados: nenhum valor da fonte é descartado e a busca usa a string exata.');
console.log('Foils especiais aprovados: cada versão ligada ao próprio produto, com o preço dele.');
