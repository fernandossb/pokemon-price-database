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

const TCGPLAYER_META_KEYS = new Set(['updated', 'unit']);
const CARDMARKET_META_KEYS = new Set(['updated', 'unit']);
// Campos que provam a EXISTÊNCIA de preço para a variante (descoberta de enum).
const PRICE_FIELDS = ['marketPrice', 'midPrice', 'lowPrice', 'highPrice', 'directLowPrice'];
// Campos usados para CALCULAR o valor. `highPrice` fica de fora: ele não é um
// preço de mercado, é o teto do anúncio mais caro da listagem — tipicamente uma
// carta graduada, um lote ou um erro de digitação. Num comum de US$ 0,08 o
// TCGplayer chega a publicar highPrice US$ 999, o que sozinho destruiria a
// média (Darumaka me02-015 saía a R$ 464,75 em vez de ~R$ 0,21).
const VALUATION_FIELDS = ['marketPrice', 'midPrice', 'lowPrice', 'directLowPrice'];
const CARDMARKET_NON_FOIL_KEYS = [
  'trend', 'avg30', 'avg7', 'avg1', 'avg', 'low', 'average-sell-price'
];
const CARDMARKET_FOIL_KEYS = [
  'trend-holo', 'avg30-holo', 'avg7-holo', 'avg1-holo', 'avg-holo', 'low-holo', 'average-sell-price-holo'
];

function exactEnum(value) {
  return String(value ?? '').trim();
}

function hasPositiveNumber(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function hasPriceObject(value) {
  return Boolean(value && typeof value === 'object' && PRICE_FIELDS.some(field => hasPositiveNumber(value[field])));
}

function hasAnyCardmarketPrice(cardmarket, keys) {
  return keys.some(key => hasPositiveNumber(cardmarket?.[key]));
}

/* ---------- Versões com foil especial ----------

   Cosmos Holo, Poké Ball, Master Ball, Cracked Ice... O TCGplayer vende cada
   uma como produto próprio (as Cosmos ficam em "Miscellaneous Cards &
   Products"), e o TCGdex liga cada versão da carta ao produto exato em
   `variants_detailed[].thirdParty.tcgplayer`. Cada uma vira um enum próprio
   na carta certa, com o nome que o app usa: "<foil>-holofoil"
   ("cosmos-holofoil", "pokeball-holofoil"...). Ficam marcadas como
   "special-foil": o app as mostra à parte, não entre as versões básicas.
   Carimbo e tamanho especial ficam de fora — não têm preço próprio aqui. */
function slugDeVariacao(value) {
  return exactEnum(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function specialFoilEnum(foil) {
  const base = slugDeVariacao(foil).replace(/-?holo(foil)?$/, '').replace(/-ball$/, 'ball');
  return base ? `${base}-holofoil` : '';
}

export function specialFoilVariants(card) {
  const detailed = Array.isArray(card?.variants_detailed) ? card.variants_detailed : [];
  const byEnum = new Map();
  for (const variant of detailed) {
    if (!variant?.foil) continue;
    const stamps = Array.isArray(variant.stamp) ? variant.stamp : variant.stamp ? [variant.stamp] : [];
    if (stamps.length) continue;
    if (variant.size && variant.size !== 'standard') continue;
    if (variant.subtype && variant.subtype !== 'unlimited') continue;
    let value = specialFoilEnum(variant.foil);
    if (!value) continue;
    // O mesmo foil em holo e em reverse na mesma carta: o reverse ganha nome próprio.
    if (byEnum.has(value)) {
      const reverso = value.replace(/-holofoil$/, '-reverse-holofoil');
      if (String(variant.type) === 'reverse') value = reverso;
      else { byEnum.set(reverso, byEnum.get(value)); byEnum.delete(value); }
    }
    byEnum.set(value, variant);
  }
  return byEnum;
}

// O primeiro subtipo com preço do produto: holofoil, reverse, normal, o resto.
function productPriceObject(product) {
  if (!product || typeof product !== 'object') return null;
  for (const key of ['holofoil', 'reverse-holofoil', 'normal']) {
    if (hasPriceObject(product[key])) return product[key];
  }
  for (const [key, value] of Object.entries(product)) {
    if (!TCGPLAYER_META_KEYS.has(key) && hasPriceObject(value)) return value;
  }
  return null;
}

function specialFoilTcgplayer(variant, tcgplayerProducts) {
  return productPriceObject(variant?.pricing?.tcgplayer)
    || productPriceObject(tcgplayerProducts?.[variant?.thirdParty?.tcgplayer]);
}

function specialFoilCardmarketKeys(variant) {
  const cardmarket = variant?.pricing?.cardmarket;
  if (hasAnyCardmarketPrice(cardmarket, CARDMARKET_NON_FOIL_KEYS)) return CARDMARKET_NON_FOIL_KEYS;
  if (hasAnyCardmarketPrice(cardmarket, CARDMARKET_FOIL_KEYS)) return CARDMARKET_FOIL_KEYS;
  return null;
}

/* Preço da versão especial: o do PRODUTO dela. TCGplayer (o que o TCGdex
   trouxer ou, sem isso, o tcgcsv pelo número do produto); senão o Cardmarket
   daquele produto. Nunca o preço da carta comum. */
function specialFoilMarketValues(variant, exact, fx, tcgplayerProducts) {
  const values = [];
  const sourceEnums = [];
  const tcg = specialFoilTcgplayer(variant, tcgplayerProducts);
  if (tcg) {
    sourceEnums.push({ provider: 'tcgplayer', value: exact });
    for (const field of VALUATION_FIELDS) pushConverted(values, `tcgplayer:${exact}:${field}`, tcg[field], fx.usdBrl);
  }
  const cardmarketKeys = specialFoilCardmarketKeys(variant);
  if (cardmarketKeys) {
    sourceEnums.push({ provider: 'cardmarket', value: exact });
    addCardmarketValues(values, variant.pricing.cardmarket, cardmarketKeys, fx, exact);
  }
  return { values, sourceEnums };
}

function addCatalogEnum(map, value, source, priced = false, kind = 'variant') {
  const exact = exactEnum(value);
  if (!exact) return;
  const current = map.get(exact) || { value: exact, sources: [], priced: false, kinds: [] };
  if (source && !current.sources.includes(source)) current.sources.push(source);
  if (kind && !current.kinds.includes(kind)) current.kinds.push(kind);
  current.priced = current.priced || Boolean(priced);
  map.set(exact, current);
}

/**
 * Returns every exact enum exposed for this card by TCGdex, TCGplayer or
 * Cardmarket. No allowlist is used: a future enum is preserved automatically.
 */
function tcgplayerProductIdsForVariant(card, exact) {
  const ids = new Set();
  const direct = card?.pricing?.tcgplayer;
  for (const key of [exact, exact === 'reverse' ? 'reverse-holofoil' : '', exact === 'holo' ? 'holofoil' : '']) {
    const id = direct?.[key]?.productId;
    if (Number.isInteger(Number(id)) && Number(id) > 0) ids.add(String(Number(id)));
  }
  const specialVariants = specialFoilVariants(card);
  for (const item of Array.isArray(card?.variants_detailed) ? card.variants_detailed : []) {
    const special = [...specialVariants].find(([, candidate]) => candidate === item)?.[0] || '';
    const stamps = Array.isArray(item?.stamp) ? item.stamp : item?.stamp ? [item.stamp] : [];
    const base = !stamps.length && (!item.size || item.size === 'standard') && (!item.subtype || item.subtype === 'unlimited');
    const matches = special
      ? special === exact
      : base && !item.foil && (
        (exact === 'normal' && item.type === 'normal')
        || (['holo', 'holofoil'].includes(exact) && item.type === 'holo')
        || (['reverse', 'reverse-holofoil'].includes(exact) && item.type === 'reverse')
      );
    if (!matches) continue;
    const id = item?.thirdParty?.tcgplayer ?? item?.pricing?.tcgplayer?.holofoil?.productId
      ?? item?.pricing?.tcgplayer?.['reverse-holofoil']?.productId ?? item?.pricing?.tcgplayer?.normal?.productId;
    if (Number.isInteger(Number(id)) && Number(id) > 0) ids.add(String(Number(id)));
  }
  return ids;
}

function normalizeMypLanguage(language) {
  const value = exactEnum(language).toLowerCase();
  if (/^(pt|portugu[eê]s|portuguese)/.test(value)) return 'pt-br';
  if (/^(en|english|ingl[eê]s)/.test(value)) return 'en';
  if (/^(ja|japanese|japon[eê]s)/.test(value)) return 'ja';
  return '';
}

function mypPrintingForVariant(exact) {
  if (exact === 'normal') return 'normal';
  if (['holo', 'holofoil'].includes(exact)) return 'foil';
  if (['reverse', 'reverse-holofoil'].includes(exact) || /-reverse-holofoil$/.test(exact)) return 'reverse foil';
  if (/-holofoil$/.test(exact)) return 'foil';
  return '';
}

function mypCardsPrice(card, exact, language, mypcardsPrices = {}) {
  const expectedLanguage = normalizeMypLanguage(language);
  const expectedPrinting = mypPrintingForVariant(exact);
  if (!expectedLanguage || !expectedPrinting) return null;
  const byId = mypcardsPrices?.byTcgProductId || {};
  const candidates = [];
  for (const id of tcgplayerProductIdsForVariant(card, exact)) {
    for (const product of byId[id] || []) {
      for (const row of Array.isArray(product.prices) ? product.prices : []) {
        if (row.sellerVerified !== true || !String(row.sellerId || '').trim()) continue;
        if (normalizeMypLanguage(row.language) !== expectedLanguage) continue;
        if (exactEnum(row.printing).toLowerCase() !== expectedPrinting) continue;
        const value = Number(String(row.min_price ?? '').replace(',', '.'));
        if (Number.isFinite(value) && value > 0) candidates.push({
          valueBrl: value,
          detail: String(product.link || 'https://mypcards.com'),
          productId: String(product.tcg_productId || id),
          sellerId: String(row.sellerId),
          sellerVerified: true,
        });
      }
    }
  }
  if (!candidates.length) return null;
  return candidates.reduce((best, item) => item.valueBrl < best.valueBrl ? item : best);
}

export function variantCatalog(card, tcgplayerProducts = {}, mypcardsPrices = {}) {
  const found = new Map();
  const tcgdexVariants = card?.variants && typeof card.variants === 'object' ? card.variants : {};
  for (const [key, value] of Object.entries(tcgdexVariants)) {
    if (value === true || (value != null && value !== false && value !== '')) {
      addCatalogEnum(found, key, 'tcgdex', false, 'tcgdex-flag');
    }
  }

  const tcgplayer = card?.pricing?.tcgplayer && typeof card.pricing.tcgplayer === 'object'
    ? card.pricing.tcgplayer
    : {};
  for (const [key, value] of Object.entries(tcgplayer)) {
    if (TCGPLAYER_META_KEYS.has(key) || !value || typeof value !== 'object') continue;
    addCatalogEnum(found, key, 'tcgplayer', hasPriceObject(value), 'market-variant');
  }

  const cardmarket = card?.pricing?.cardmarket && typeof card.pricing.cardmarket === 'object'
    ? card.pricing.cardmarket
    : {};
  const hasNonFoil = hasAnyCardmarketPrice(cardmarket, CARDMARKET_NON_FOIL_KEYS);
  const hasFoil = hasAnyCardmarketPrice(cardmarket, CARDMARKET_FOIL_KEYS);
  if (hasNonFoil) addCatalogEnum(found, 'normal', 'cardmarket', true, 'market-variant');
  if (hasFoil) addCatalogEnum(found, 'holo', 'cardmarket', true, 'market-variant');

  // Preserve any future Cardmarket enum-like nested object instead of dropping it.
  for (const [key, value] of Object.entries(cardmarket)) {
    if (CARDMARKET_META_KEYS.has(key) || !value || typeof value !== 'object') continue;
    addCatalogEnum(found, key, 'cardmarket', hasPriceObject(value), 'market-variant');
  }

  // Versões com foil especial, cada uma ligada ao próprio produto.
  for (const [value, variant] of specialFoilVariants(card)) {
    const priced = Boolean(specialFoilTcgplayer(variant, tcgplayerProducts) || specialFoilCardmarketKeys(variant));
    addCatalogEnum(found, value, 'tcgdex', priced, 'special-foil');
  }

  for (const exact of found.keys()) {
    const match = mypCardsPrice(card, exact, 'en', mypcardsPrices)
      || mypCardsPrice(card, exact, 'pt-br', mypcardsPrices)
      || mypCardsPrice(card, exact, 'ja', mypcardsPrices);
    if (match) addCatalogEnum(found, exact, 'mypcards', true, 'market-variant');
  }

  return [...found.values()]
    .map(item => ({
      value: item.value,
      sources: item.sources.sort(),
      priced: Boolean(item.priced),
      kinds: item.kinds.sort(),
    }))
    .sort((a, b) => a.value.localeCompare(b.value, 'en'));
}

function pushConverted(values, source, rawValue, rate) {
  const value = Number(rawValue);
  if (Number.isFinite(value) && value > 0) values.push({ source, value: value * rate });
}

function addCardmarketValues(values, cardmarket, keys, fx, enumValue) {
  for (const key of keys) pushConverted(values, `cardmarket:${enumValue}:${key}`, cardmarket?.[key], fx.eurBrl);
}

/**
 * Reads prices only from the exact enum selected. The only shared values are
 * Cardmarket's explicit normal/holo buckets when the exact enum is normal or
 * holo. No alias, translated name or legacy value is accepted.
 */
export function marketValues(card, variantEnum, fx, tcgplayerProducts = {}) {
  const exact = exactEnum(variantEnum);
  if (!exact) return { values: [], sourceEnums: [] };

  const special = specialFoilVariants(card).get(exact);
  if (special) return specialFoilMarketValues(special, exact, fx, tcgplayerProducts);

  const values = [];
  const sourceEnums = [];
  const tcgplayer = card?.pricing?.tcgplayer && typeof card.pricing.tcgplayer === 'object'
    ? card.pricing.tcgplayer
    : {};
  const tcg = tcgplayer[exact];
  if (tcg && typeof tcg === 'object') {
    sourceEnums.push({ provider: 'tcgplayer', value: exact });
    for (const field of VALUATION_FIELDS) pushConverted(values, `tcgplayer:${exact}:${field}`, tcg[field], fx.usdBrl);
  }

  const cardmarket = card?.pricing?.cardmarket && typeof card.pricing.cardmarket === 'object'
    ? card.pricing.cardmarket
    : {};
  if (exact === 'normal') {
    sourceEnums.push({ provider: 'cardmarket', value: exact });
    addCardmarketValues(values, cardmarket, CARDMARKET_NON_FOIL_KEYS, fx, exact);
  } else if (exact === 'holo') {
    sourceEnums.push({ provider: 'cardmarket', value: exact });
    addCardmarketValues(values, cardmarket, CARDMARKET_FOIL_KEYS, fx, exact);
  } else if (cardmarket[exact] && typeof cardmarket[exact] === 'object') {
    sourceEnums.push({ provider: 'cardmarket', value: exact });
    for (const field of VALUATION_FIELDS) pushConverted(values, `cardmarket:${exact}:${field}`, cardmarket[exact][field], fx.eurBrl);
  }

  return { values, sourceEnums };
}

function simpleAverage(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Ordem de preferência dos mercados. O preço publicado vem de UM mercado só —
// o primeiro desta lista que tenha valor para a variante —, não de uma média
// entre os três. Misturar TCGplayer (dólar, mercado americano) com Cardmarket
// (euro, mercado europeu) produz um número que não corresponde a lugar nenhum.
// TCGdex não tem preço próprio: ele republica os outros dois.
const SOURCE_PRIORITY = ['mypcards', 'tcgplayer', 'tcgdex', 'cardmarket'];

function providerOf(sourceId) {
  return String(sourceId || '').split(':')[0];
}

function pickPriorityMarket(values) {
  const byProvider = new Map();
  for (const item of values) {
    const provider = providerOf(item.source);
    if (!byProvider.has(provider)) byProvider.set(provider, []);
    byProvider.get(provider).push(item);
  }
  for (const provider of SOURCE_PRIORITY) {
    const chosen = byProvider.get(provider);
    if (chosen?.length) return { provider, values: chosen };
  }
  // Mercado novo, ainda fora da lista: melhor usar do que descartar o preço.
  for (const [provider, chosen] of byProvider) {
    if (chosen.length) return { provider, values: chosen };
  }
  return { provider: '', values: [] };
}

export function resolvePrice({ card, variantEnum, language = 'en', fx, tcgplayerProducts = {}, mypcardsPrices = {} }) {
  const market = marketValues(card, variantEnum, fx, tcgplayerProducts);
  const myp = mypCardsPrice(card, exactEnum(variantEnum), language, mypcardsPrices);
  if (myp) {
    market.sourceEnums.push({ provider: 'mypcards', value: exactEnum(variantEnum) });
    market.values.push({ source: `mypcards:${exactEnum(variantEnum)}`, value: myp.valueBrl, detail: myp.detail,
      sellerId: myp.sellerId, sellerVerified: myp.sellerVerified });
  }
  if (!market.values.length) return null;
  const chosen = pickPriorityMarket(market.values);
  if (!chosen.values.length) return null;
  const price = simpleAverage(chosen.values.map(item => item.value));
  return {
    priceBrl: round2(price),
    confidence: Math.min(100, Math.round(20 + chosen.values.length * 12)),
    matchLevel: 'exact',
    estimatedDimensions: [],
    priceMarket: chosen.provider,
    sourceEnums: market.sourceEnums,
    // Guardamos TODAS as referências lidas, marcando quais entraram na conta.
    // Assim o app consegue mostrar o mercado usado e os demais como contexto.
    sources: market.values.map(item => ({
      source: item.source,
      valueBrl: round2(item.value),
      used: providerOf(item.source) === chosen.provider,
      detail: item.detail || null,
      ...(item.sellerId ? { sellerId: item.sellerId, sellerVerified: item.sellerVerified === true } : {}),
    })),
  };
}
