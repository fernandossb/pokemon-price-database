import fs from 'node:fs/promises';
import { listCards, getCard } from './providers/tcgdex.mjs';
import { loadBrazilianPrices } from './providers/brCsv.mjs';

const config = JSON.parse(await fs.readFile('config.json', 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = values => {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

async function getFx() {
  try {
    const r = await fetch('https://api.frankfurter.app/latest?from=EUR&to=BRL,USD');
    if (!r.ok) throw new Error('fx');
    const j = await r.json();
    const eurBrl = j.rates.BRL;
    const usdBrl = eurBrl / j.rates.USD;
    return { eurBrl, usdBrl, date: j.date };
  } catch {
    return { eurBrl: 6.4, usdBrl: 5.5, date: null, fallback: true };
  }
}

function finishes(card) {
  const v = card.variants || {};
  const out = [];
  if (v.normal) out.push('normal');
  if (v.holo) out.push('holo');
  if (v.reverse) out.push('reverse');
  if (v.firstEdition) out.push('firstEdition');
  return out.length ? out : ['normal'];
}

function marketValues(card, finish, fx) {
  const cm = card.pricing?.cardmarket || {};
  const tcg = card.pricing?.tcgplayer || {};
  const foil = finish === 'holo' || finish === 'reverse' || finish === 'firstEditionHolo';
  const tcgKey = finish === 'reverse' ? 'reverse-holofoil' : foil ? 'holofoil' : 'normal';
  const vals = [];
  if (foil && Number.isFinite(cm['trend-holo'])) vals.push({ source: 'cardmarketTrend', value: cm['trend-holo'] * fx.eurBrl });
  if (!foil && Number.isFinite(cm.trend)) vals.push({ source: 'cardmarketTrend', value: cm.trend * fx.eurBrl });
  if (foil && Number.isFinite(cm['avg30-holo'])) vals.push({ source: 'cardmarketAvg30', value: cm['avg30-holo'] * fx.eurBrl });
  if (!foil && Number.isFinite(cm.avg30)) vals.push({ source: 'cardmarketAvg30', value: cm.avg30 * fx.eurBrl });
  const tp = tcg[tcgKey] || tcg[finish] || null;
  if (Number.isFinite(tp?.marketPrice)) vals.push({ source: 'tcgplayerMarket', value: tp.marketPrice * fx.usdBrl });
  return vals;
}

function removeOutliers(values, tolerance) {
  if (values.length < 3) return values;
  const m = median(values.map(x => x.value));
  return values.filter(x => Math.abs(x.value - m) / m <= tolerance);
}

function resolvePrice(card, finish, brSources, fx) {
  const key = `${card.id}::${finish}`;
  const br = brSources.get(key) || [];
  const market = marketValues(card, finish, fx);
  const all = [
    ...br.map(x => ({ source: 'brMedian', value: x.priceBrl, detail: x.source })),
    ...market
  ];
  const filtered = removeOutliers(all, config.outlierTolerance);
  if (!filtered.length) return null;
  const weights = config.weights;
  let weighted = 0;
  let totalWeight = 0;
  for (const item of filtered) {
    const w = weights[item.source] ?? 0.05;
    weighted += item.value * w;
    totalWeight += w;
  }
  const price = weighted / totalWeight;
  const confidence = Math.min(100, Math.round(25 + filtered.length * 18 + (br.length ? 20 : 0)));
  return {
    priceBrl: Math.round(price * 100) / 100,
    confidence,
    sources: filtered.map(x => ({ source: x.source, valueBrl: Math.round(x.value * 100) / 100, detail: x.detail || null }))
  };
}

async function main() {
  await fs.mkdir('output', { recursive: true });
  const fx = await getFx();
  const brSources = await loadBrazilianPrices();
  const summaries = new Map();
  for (const language of config.languages) {
    const cards = await listCards(language);
    for (const card of cards) if (!summaries.has(card.id)) summaries.set(card.id, { ...card, language });
  }
  const ids = [...summaries.keys()];
  const output = {};
  const unmatched = [];
  let cursor = 0;
  async function worker() {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      let full = null;
      for (const language of config.languages) {
        try { full = await getCard(language, id); if (full) break; } catch {}
      }
      if (!full) { unmatched.push({ id, reason: 'card_not_loaded' }); continue; }
      for (const finish of finishes(full)) {
        const resolved = resolvePrice(full, finish, brSources, fx);
        const key = `${id}::${finish}`;
        if (resolved) {
          output[key] = {
            cardId: id,
            finish,
            name: full.name,
            number: full.localId,
            setId: full.set?.id || null,
            setName: full.set?.name || null,
            illustrator: full.illustrator || null,
            promotional: Boolean(full.set?.id?.toLowerCase().includes('promo')),
            updatedAt: new Date().toISOString(),
            ...resolved
          };
        } else unmatched.push({ id, finish, reason: 'no_market_data' });
      }
      await sleep(config.requestDelayMs);
    }
  }
  await Promise.all(Array.from({ length: config.maxConcurrency }, worker));
  const meta = {
    generatedAt: new Date().toISOString(),
    cardsScanned: ids.length,
    variantsPriced: Object.keys(output).length,
    unmatched: unmatched.length,
    fx
  };
  await fs.writeFile('output/prices-current.json', JSON.stringify({ meta, prices: output }, null, 2));
  await fs.writeFile('output/unmatched-cards.json', JSON.stringify(unmatched, null, 2));
  console.log(meta);
}

main().catch(error => { console.error(error); process.exit(1); });
