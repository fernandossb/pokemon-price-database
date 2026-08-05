import fs from 'node:fs/promises';

export const config = JSON.parse(await fs.readFile('config.json', 'utf8'));
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const nowIso = () => new Date().toISOString();
export const todayUtc = () => new Date().toISOString().slice(0, 10);
export const round2 = value => Math.round(value * 100) / 100;

export async function readJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function getFx() {
  try {
    const response = await fetch('https://api.frankfurter.app/latest?from=EUR&to=BRL,USD');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const eurBrl = data.rates.BRL;
    const usdBrl = eurBrl / data.rates.USD;
    return { eurBrl, usdBrl, date: data.date, fallback: false };
  } catch (error) {
    console.warn(`Cotação indisponível; usando fallback: ${error.message}`);
    return { eurBrl: 6.4, usdBrl: 5.5, date: null, fallback: true };
  }
}

// Enumera as combinações de acabamento (normal/holo/reverse), variação de
// impressão (unlimited/firstEdition) e carimbo (unstamped/stamped) que
// realmente existem para a carta, a partir das flags estruturadas do TCGdex.
export function variants(card) {
  const v = card.variants || {};
  const finishes = [];
  if (v.normal) finishes.push('normal');
  if (v.holo) finishes.push('holo');
  if (v.reverse) finishes.push('reverse');
  if (!finishes.length) finishes.push('normal');

  const printVariations = v.firstEdition ? ['unlimited', 'firstEdition'] : ['unlimited'];
  const stamps = v.wPromo ? ['unstamped', 'stamped'] : ['unstamped'];

  const result = [];
  for (const finish of finishes) {
    for (const printVariation of printVariations) {
      for (const stamp of stamps) {
        result.push({ finish, printVariation, stamp });
      }
    }
  }
  return result;
}

export function marketValues(card, variant, fx) {
  const { finish, printVariation, stamp } = variant;
  const cardmarket = card.pricing?.cardmarket || {};
  const tcgplayer = card.pricing?.tcgplayer || {};
  const foil = ['holo', 'reverse'].includes(finish);
  const values = [];
  const estimatedDimensions = [];

  const pushEur = (source, value) => {
    if (Number.isFinite(value) && value > 0) values.push({ source, value: value * fx.eurBrl });
  };
  const pushUsd = (source, value) => {
    if (Number.isFinite(value) && value > 0) values.push({ source, value: value * fx.usdBrl });
  };

  // O Cardmarket exposto pelo TCGdex separa foil/não foil, mas não separa
  // explicitamente 1ª edição. Para não misturar versões, ele só participa da
  // combinação unlimited. A 1ª edição exige uma chave própria do TCGplayer.
  if (printVariation === 'unlimited') {
    pushEur('cardmarketTrend', foil ? cardmarket['trend-holo'] : cardmarket.trend);
    pushEur('cardmarketAvg30', foil ? cardmarket['avg30-holo'] : cardmarket.avg30);
    pushEur('cardmarketAvg7', foil ? cardmarket['avg7-holo'] : cardmarket.avg7);
    pushEur('cardmarketAvg1', foil ? cardmarket['avg1-holo'] : cardmarket.avg1);
    pushEur('cardmarketAverageSell', foil ? cardmarket['average-sell-price-holo'] : cardmarket['average-sell-price']);
    pushEur('cardmarketLow', foil ? cardmarket['low-holo'] : cardmarket.low);
  }

  let tcgCandidates = [];
  if (printVariation === 'firstEdition') {
    if (finish === 'normal') tcgCandidates = ['1st-edition'];
    else if (finish === 'holo') tcgCandidates = ['1st-edition-holofoil'];
    else tcgCandidates = ['1st-edition-reverse-holofoil'];
  } else if (finish === 'reverse') {
    tcgCandidates = ['reverse-holofoil', 'reverse', 'reverseHolofoil'];
  } else if (finish === 'holo') {
    tcgCandidates = ['unlimited-holofoil', 'holofoil', 'holo'];
  } else {
    tcgCandidates = ['unlimited', 'normal'];
  }

  const tcgKey = tcgCandidates.find(key => tcgplayer[key] && typeof tcgplayer[key] === 'object');
  const tcg = tcgKey ? tcgplayer[tcgKey] : null;
  pushUsd(tcgKey ? `tcgplayerMarket:${tcgKey}` : 'tcgplayerMarket', tcg?.marketPrice);
  pushUsd(tcgKey ? `tcgplayerMid:${tcgKey}` : 'tcgplayerMid', tcg?.midPrice);
  pushUsd(tcgKey ? `tcgplayerLow:${tcgKey}` : 'tcgplayerLow', tcg?.lowPrice);

  // TCGdex informa que a carta possui versão com carimbo promocional, mas os
  // campos de preço públicos não identificam o carimbo em cada valor. Mantemos
  // uma estimativa separada, porém com confiança limitada para o app exigir
  // confirmação em vez de misturar silenciosamente as versões.
  if (stamp === 'stamped') estimatedDimensions.push('stamp');

  return {
    values,
    matchLevel: estimatedDimensions.length ? 'estimated' : 'exact',
    estimatedDimensions,
    tcgKey: tcgKey || null,
  };
}

function simpleAverage(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Preço final = média simples de todos os valores de Cardmarket/TCGplayer
// disponíveis para o acabamento da combinação exata (idioma + variação de
// impressão + carimbo + acabamento). Nenhum resultado é descartado como
// "outlier" e nenhuma fonte tem peso maior que outra.
export function resolvePrice({ card, variant, fx }) {
  const market = marketValues(card, variant, fx);
  if (!market.values.length) return null;

  const price = simpleAverage(market.values.map(item => item.value));
  let confidence = Math.min(100, Math.round(15 + market.values.length * 12));
  if (market.matchLevel === 'estimated') confidence = Math.min(34, confidence);

  return {
    priceBrl: round2(price),
    confidence,
    matchLevel: market.matchLevel,
    estimatedDimensions: market.estimatedDimensions,
    pricingVariantKey: market.tcgKey,
    sources: market.values.map(item => ({
      source: item.source,
      valueBrl: round2(item.value),
      detail: null
    }))
  };
}
