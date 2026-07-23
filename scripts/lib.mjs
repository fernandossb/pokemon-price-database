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

export const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

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

export function finishes(card) {
  const variants = card.variants || {};
  const result = [];
  if (variants.normal) result.push('normal');
  if (variants.holo) result.push('holo');
  if (variants.reverse) result.push('reverse');
  if (variants.firstEdition) result.push('firstEdition');
  return result.length ? result : ['normal'];
}

export function marketValues(card, finish, fx) {
  const cardmarket = card.pricing?.cardmarket || {};
  const tcgplayer = card.pricing?.tcgplayer || {};
  const foil = ['holo', 'reverse', 'firstEditionHolo'].includes(finish);
  const tcgKey = finish === 'reverse' ? 'reverse-holofoil' : foil ? 'holofoil' : 'normal';
  const values = [];

  const pushEur = (source, value) => {
    if (Number.isFinite(value) && value > 0) values.push({ source, value: value * fx.eurBrl });
  };
  const pushUsd = (source, value) => {
    if (Number.isFinite(value) && value > 0) values.push({ source, value: value * fx.usdBrl });
  };

  pushEur('cardmarketTrend', foil ? cardmarket['trend-holo'] : cardmarket.trend);
  pushEur('cardmarketAvg30', foil ? cardmarket['avg30-holo'] : cardmarket.avg30);
  pushEur('cardmarketAvg7', foil ? cardmarket['avg7-holo'] : cardmarket.avg7);
  pushEur('cardmarketAvg1', foil ? cardmarket['avg1-holo'] : cardmarket.avg1);
  pushEur('cardmarketAverageSell', foil ? cardmarket['average-sell-price-holo'] : cardmarket['average-sell-price']);
  pushEur('cardmarketLow', foil ? cardmarket['low-holo'] : cardmarket.low);

  const tcg = tcgplayer[tcgKey] || tcgplayer[finish] || null;
  pushUsd('tcgplayerMarket', tcg?.marketPrice);
  pushUsd('tcgplayerMid', tcg?.midPrice);
  pushUsd('tcgplayerLow', tcg?.lowPrice);
  return values;
}

function removeOutliers(values, tolerance) {
  if (values.length < 3) return values;
  const center = median(values.map(item => item.value));
  if (!Number.isFinite(center) || center <= 0) return values;
  return values.filter(item => Math.abs(item.value - center) / center <= tolerance);
}

export function resolvePrice(card, finish, brSources, fx) {
  const key = `${card.id}::${finish}`;
  const brazilian = brSources.get(key) || [];
  const market = marketValues(card, finish, fx);
  const candidates = [
    ...brazilian.map(item => ({ source: 'brMedian', value: item.priceBrl, detail: item.source })),
    ...market
  ];
  const filtered = removeOutliers(candidates, config.outlierTolerance);
  if (!filtered.length) return null;

  let weighted = 0;
  let totalWeight = 0;
  for (const item of filtered) {
    const weight = config.weights[item.source] ?? 0.03;
    weighted += item.value * weight;
    totalWeight += weight;
  }
  if (totalWeight <= 0) return null;

  const price = weighted / totalWeight;
  const confidence = Math.min(100, Math.round(25 + filtered.length * 11 + (brazilian.length ? 25 : 0)));
  return {
    priceBrl: round2(price),
    confidence,
    sources: filtered.map(item => ({
      source: item.source,
      valueBrl: round2(item.value),
      detail: item.detail || null
    }))
  };
}
