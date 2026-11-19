import fs from 'node:fs/promises';

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_BROWSER_SNAPSHOT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const ALLOWED_LANGUAGES = new Set(['pt-br', 'en', 'ja']);

export function normalizeLigaOffer(raw, nowMs = Date.now(), maxAgeMs = MAX_AGE_MS) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const cardId = String(raw.cardId || '');
  const language = String(raw.language || '');
  const variantEnum = String(raw.variantEnum || '');
  const listingId = String(raw.listingId || '');
  const seller = String(raw.seller || '').trim();
  const sellerId = String(raw.sellerId || '').trim();
  const condition = String(raw.condition || '').trim().toUpperCase();
  const priceBrl = Number(raw.priceBrl);
  const observedAt = String(raw.observedAt || '');
  const observedMs = Date.parse(observedAt);
  if (!/^[a-zA-Z0-9_.-]+$/.test(cardId) || !ALLOWED_LANGUAGES.has(language)) return null;
  if (!variantEnum || variantEnum !== variantEnum.trim() || variantEnum.length > 100) return null;
  if (!listingId || listingId.length > 180 || !seller || seller.length > 120) return null;
  if (!condition || !Number.isFinite(priceBrl) || priceBrl <= 0 || priceBrl > 1_000_000) return null;
  if (!Number.isFinite(observedMs) || observedMs < nowMs - maxAgeMs || observedMs > nowMs + 5 * 60 * 1000) return null;
  let url;
  try { url = new URL(String(raw.url || '')); } catch { return null; }
  if (url.protocol !== 'https:' || !/(^|\.)ligapokemon\.com\.br$/i.test(url.hostname)) return null;
  return { cardId, language, variantEnum, listingId, seller, sellerId, condition, priceBrl,
    url: url.toString(), observedAt: new Date(observedMs).toISOString() };
}

// Compatibilidade com os fixtures locais antigos; o pipeline de publicação não
// chama esta função. O processamento de preços usa apenas fetchLigaPrintOffers.
export async function loadLigaOffers(file = 'data/ligapokemon-offers.json', nowMs = Date.now()) {
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  if (data?.schemaVersion !== 1 || !Array.isArray(data.offers)) {
    throw new Error('Formato inválido para data/ligapokemon-offers.json');
  }
  const byListing = new Map();
  for (const [index, raw] of data.offers.entries()) {
    const offer = normalizeLigaOffer(raw, nowMs);
    if (!offer) continue;
    const previous = byListing.get(offer.listingId);
    if (!previous || Date.parse(offer.observedAt) > Date.parse(previous.observedAt)) {
      byListing.set(offer.listingId, offer);
    }
  }
  const groups = new Map();
  for (const offer of byListing.values()) {
    const key = `${offer.cardId}::${offer.language}::${offer.variantEnum}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(offer);
  }
  return groups;
}

export async function loadLigaOfferSnapshot(file = 'data/ligapokemon-offers.json', nowMs = Date.now()) {
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  if (data?.schemaVersion !== 2 || data?.source !== 'ligapokemon' || !Array.isArray(data.offers)
    || !data.coverage || data.coverage.complete !== true
    || !/^[a-f0-9]{64}$/i.test(String(data.coverage.catalogHash || ''))
    || !Number.isInteger(data.coverage.cardCount) || data.coverage.cardCount < 1) {
    throw new Error('Formato inválido para snapshot de anúncios da Liga Pokémon (schemaVersion 2).');
  }
  const capturedMs = Date.parse(String(data.capturedAt || ''));
  if (!Number.isFinite(capturedMs) || capturedMs < nowMs - MAX_BROWSER_SNAPSHOT_AGE_MS || capturedMs > nowMs + 5 * 60 * 1000) {
    throw new Error('O snapshot de anúncios da Liga não tem `capturedAt` recente e válido.');
  }
  const byListing = new Map();
  for (const [index, raw] of data.offers.entries()) {
    const offer = normalizeLigaOffer(raw, nowMs, MAX_BROWSER_SNAPSHOT_AGE_MS);
    if (!offer) throw new Error(`Anúncio ${index + 1} inválido ou vencido no snapshot da Liga; importação cancelada.`);
    const dedupeKey = `${offer.cardId}::${offer.language}::${offer.variantEnum}::${offer.listingId}`;
    const previous = byListing.get(dedupeKey);
    if (!previous || Date.parse(offer.observedAt) > Date.parse(previous.observedAt)) {
      byListing.set(dedupeKey, offer);
    }
  }
  const groups = new Map();
  for (const offer of byListing.values()) {
    const key = `${offer.cardId}::${offer.language}::${offer.variantEnum}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(offer);
  }
  return {
    groups,
    capturedAt: new Date(capturedMs).toISOString(),
    offerCount: byListing.size,
    coverage: data.coverage,
  };
}

export function summarizeLigaOffers(offers = []) {
  const sellers = new Map();
  for (const offer of offers) {
    if (!['M', 'NM'].includes(offer.condition)) continue;
    const sellerName = offer.seller.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ');
    const key = offer.sellerId ? `id:${offer.sellerId}` : `name:${sellerName}`;
    const previous = sellers.get(key);
    if (!previous || offer.priceBrl < previous.priceBrl) sellers.set(key, offer);
  }
  const uniqueOffers = [...sellers.values()].sort((a, b) => a.priceBrl - b.priceBrl);
  if (!uniqueOffers.length) return null;
  const n = uniqueOffers.length;
  const medianPriceBrl = n % 2
    ? uniqueOffers[(n - 1) / 2].priceBrl
    : (uniqueOffers[n / 2 - 1].priceBrl + uniqueOffers[n / 2].priceBrl) / 2;
  return {
    sellerCount: n,
    medianPriceBrl: Math.round(medianPriceBrl * 100) / 100,
    minimumPriceBrl: uniqueOffers[0].priceBrl,
    maximumPriceBrl: uniqueOffers[n - 1].priceBrl,
    offers: uniqueOffers,
  };
}

const LANGUAGE_BY_LIGA = new Map([
  ['PT', 'pt-br'], ['PTBR', 'pt-br'], ['EN', 'en'], ['JP', 'ja'], ['JA', 'ja'],
]);

export function offerLanguages(raw) {
  const value = String(raw?.language || raw?.lang || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (value === 'PTEN') return ['pt-br', 'en'];
  const language = LANGUAGE_BY_LIGA.get(value);
  return language ? [language] : [];
}

function cleanLigaFinishText(value) {
  const tokens = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)
    .filter(token => token && token !== 'comprar')
    .flatMap(token => token === 'foilpromo' ? ['foil', 'promo'] : [token]);
  // The Liga page collector can capture the same finish once per responsive
  // control/button. Collapse repeated cycles such as "foil foil foil" while
  // preserving meaningful multiword finishes like "shattered holo".
  for (let size = 1; size <= Math.floor(tokens.length / 2); size += 1) {
    if (tokens.length % size !== 0) continue;
    if (tokens.every((token, index) => token === tokens[index % size])) {
      return tokens.slice(0, size).join(' ');
    }
  }
  return tokens.join(' ');
}

export function enumForLigaOffer(raw, availableEnums) {
  const finishLabel = [raw?.finish, raw?.finish_name, raw?.foil_name, raw?.variant]
    .map(cleanLigaFinishText).find(Boolean) || '';
  const extras = cleanLigaFinishText(Array.isArray(raw?.extras) ? raw.extras.join(' ') : raw?.extras);
  const description = finishLabel || extras;
  const enums = new Set(availableEnums.map(item => item.value));
  const specialFoils = [...enums]
    .filter(value => /-holofoil$/.test(value) && !['holofoil', 'reverse-holofoil', '1st-edition-holofoil'].includes(value))
    .sort((a, b) => b.length - a.length);
  const special = specialFoils.find(value => {
    const slug = value.replace(/-reverse-holofoil$|-holofoil$/, '').replace(/-/g, ' ');
    return description.includes(slug);
  });
  if (special) return special;
  if (/reverse|reversa|reverso/.test(description)) {
    if (enums.has('reverse-holofoil')) return 'reverse-holofoil';
    if (enums.has('reverse')) return 'reverse';
    throw new Error('Anúncio reverso da Liga sem variante reversa exata no catálogo TCGdex.');
  }
  if (/1st\s*edition|first\s*edition|primeira\s*edicao/.test(description)) {
    if (enums.has('1st-edition-holofoil')) return '1st-edition-holofoil';
    if (enums.has('firstEdition')) return 'firstEdition';
    throw new Error('Anúncio de primeira edição sem enum exato no catálogo TCGdex.');
  }
  if (/pok[eé]?\s*ball/.test(description) && enums.has('pokeball-holofoil')) return 'pokeball-holofoil';
  if (/master\s*ball/.test(description) && enums.has('masterball-holofoil')) return 'masterball-holofoil';
  if (/cosmos/.test(description) && enums.has('cosmos-holofoil')) return 'cosmos-holofoil';
  if (/cracked\s*ice/.test(description) && enums.has('cracked-ice-holofoil')) return 'cracked-ice-holofoil';
  const foil = raw?.is_foil === true || raw?.is_foil === 1 || /holo|foil/.test(description);
  if (!foil) {
    if (/(etched|cosmos|cracked|galaxy|radiant|texture|pok[eé]?\s*ball|master\s*ball)/.test(description)) {
      throw new Error(`Acabamento especial da Liga sem enum exato no catálogo TCGdex: ${finishLabel || extras}`);
    }
    if (enums.has('normal')) return 'normal';
    throw new Error('Anúncio Normal da Liga sem enum normal exato no catálogo TCGdex.');
  }
  if (/(etched|cosmos|cracked|galaxy|radiant|texture|pok[eé]?\s*ball|master\s*ball)/.test(description)) {
    throw new Error(`Acabamento especial da Liga sem enum exato no catálogo TCGdex: ${finishLabel || extras}`);
  }
  const normalizedFinish = String(finishLabel).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const genericFoilLabels = new Set(['foil', 'foil promo', 'promo foil', 'holo', 'holofoil', 'holo foil', 'regular holo', 'standard holo', 'normal holo']);
  if (normalizedFinish && !genericFoilLabels.has(normalizedFinish)) {
    throw new Error(`Acabamento foil não reconhecido com segurança na Liga: ${finishLabel}`);
  }
  if (enums.has('holofoil')) return 'holofoil';
  if (enums.has('holo')) return 'holo';
  throw new Error('Anúncio Foil da Liga sem enum holo exato no catálogo TCGdex.');
}

function ligaCardUrl(card, edition, number, responseData) {
  const raw = responseData?.card?.url;
  if (raw) {
    try {
      const url = new URL(raw);
      if (url.protocol === 'https:' && /(^|\.)ligapokemon\.com\.br$/i.test(url.hostname)) return url.toString();
    } catch {}
    throw new Error('A API da Liga retornou uma URL de carta inválida.');
  }
  return `https://www.ligapokemon.com.br/?view=cards/card&card=${encodeURIComponent(card)}&ed=${encodeURIComponent(edition)}&num=${encodeURIComponent(number)}`;
}

async function requestLigaCard({ card, edition, number, apiKey, fetchImpl, offersOffset }) {
  let response;
  try {
    response = await fetchImpl('https://api.reefapi.com/ligapokemon/v1/card', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        card, edition, number, condition: 'NM', language: 'PT,EN,PTEN,JP',
        offers_limit: 2000, offers_offset: offersOffset,
      }),
      signal: AbortSignal.timeout(90000),
    });
  } catch (cause) {
    const error = new Error(`Falha de rede/timeout ao consultar Liga Pokémon: ${cause.message}`);
    error.retryable = true;
    throw error;
  }
  let body;
  try {
    body = await response.json();
  } catch (cause) {
    const error = new Error(`Resposta JSON inválida da Liga Pokémon (HTTP ${response.status}): ${cause.message}`);
    error.retryable = response.status === 429 || response.status >= 500;
    throw error;
  }
  if (!response.ok || body?.ok !== true) {
    const apiError = body?.error || {};
    const error = new Error(`Liga Pokémon API ${response.status} ${apiError.code || ''}: ${apiError.message || response.statusText}`);
    error.retryable = Boolean(apiError.retryable) || response.status === 429 || response.status >= 500;
    throw error;
  }
  if (body.meta?.api !== 'ligapokemon' || body.meta?.endpoint !== 'card' || body.meta?.mode !== 'live' || body.meta?.cache_hit === true) {
    throw new Error('A resposta não comprova leitura live da Liga Pokémon; preços não serão publicados.');
  }
  const receivedAtMs = Date.now();
  const upstreamFetchedAt = String(body.meta?.fetched_at || '').trim();
  const fetchedAtMs = upstreamFetchedAt ? Date.parse(upstreamFetchedAt) : receivedAtMs;
  if (!Number.isFinite(fetchedAtMs) || fetchedAtMs < receivedAtMs - MAX_AGE_MS || fetchedAtMs > receivedAtMs + 5 * 60 * 1000) {
    throw new Error('A resposta live da Liga trouxe `meta.fetched_at` inválido ou vencido; preços não serão publicados.');
  }
  if (!body.data || !Array.isArray(body.data.offers) || !Array.isArray(body.data.editions)) {
    throw new Error('Formato de resposta da Liga Pokémon mudou; atualização cancelada.');
  }
  const exactPrint = body.data.editions.some(item =>
    String(item.edition_code || '').toUpperCase() === String(edition).toUpperCase() &&
    String(item.number || '').replace(/^0+(?=\d)/, '') === String(number).replace(/^0+(?=\d)/, '')
  );
  if (!exactPrint) throw new Error(`A Liga não confirmou a impressão ${edition} ${number}; atualização cancelada.`);
  // A documentação oficial não inclui fetched_at na resposta padrão. Quando
  // esse campo falta, o envelope live sem cache comprova a consulta atual e
  // usamos o recebimento local como horário de observação, sem chamá-lo de
  // horário de origem da Liga.
  return {
    offers: body.data.offers,
    data: body.data,
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    fetchedAtSource: upstreamFetchedAt ? 'reefapi-meta' : 'response-received',
  };
}

let cachedOfferSnapshotPath = '';
let cachedOfferSnapshotPromise = null;

async function getLocalOfferSnapshot(file) {
  if (cachedOfferSnapshotPath !== file || !cachedOfferSnapshotPromise) {
    cachedOfferSnapshotPath = file;
    cachedOfferSnapshotPromise = loadLigaOfferSnapshot(file);
  }
  return cachedOfferSnapshotPromise;
}

export async function assertLigaSnapshotCoversCatalog(catalog) {
  const file = String(process.env.LIGA_OFFERS_FILE || '').trim();
  if (!file) return null;
  const snapshot = await getLocalOfferSnapshot(file);
  if (snapshot.coverage.catalogHash !== catalog.hash || snapshot.coverage.cardCount !== catalog.count) {
    throw new Error('O snapshot local da Liga não cobre exatamente o catálogo TCGdex deste processamento.');
  }
  return { capturedAt: snapshot.capturedAt, offerCount: snapshot.offerCount, source: 'snapshot-captured-at' };
}

export async function fetchLigaPrintOffers({ card, edition, number, cardId, availableEnums,
  apiKey = process.env.REEF_API_KEY, fetchImpl = fetch }) {
  if (!card || !edition || !number || !cardId) throw new Error(`Mapeamento TCGdex/Liga incompleto para ${cardId || 'carta desconhecida'}.`);
  const localSnapshotPath = String(process.env.LIGA_OFFERS_FILE || '').trim();
  if (localSnapshotPath) {
    const snapshot = await getLocalOfferSnapshot(localSnapshotPath);
    const validEnums = new Set(availableEnums.map(item => `${item.language}::${item.value}`));
    const offers = [];
    for (const [key, group] of snapshot.groups) {
      if (!key.startsWith(`${cardId}::`) || !validEnums.has(key.slice(cardId.length + 2))) continue;
      offers.push(...group);
    }
    return {
      offers,
      fetchedAt: snapshot.capturedAt,
      fetchedAtSources: ['snapshot-captured-at'],
      print: { edition, number },
      source: 'ligapokemon-local-offer-snapshot',
    };
  }
  if (!apiKey) throw new Error('REEF_API_KEY ausente. Configure LIGA_OFFERS_FILE com um snapshot recente de anúncios da Liga ou use a API live.');
  const offers = [];
  let latestFetchedAt = '';
  const fetchedAtSources = new Set();
  for (let offset = 0; ; offset += 2000) {
    let result;
    let lastError;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        result = await requestLigaCard({ card, edition, number, apiKey, fetchImpl, offersOffset: offset });
        break;
      } catch (error) {
        lastError = error;
        if (!error.retryable || attempt === 4) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(15000, 1000 * 2 ** (attempt - 1))));
      }
    }
    if (!result) throw lastError || new Error('Falha sem resposta da Liga Pokémon.');
    latestFetchedAt = result.fetchedAt;
    if (result.fetchedAtSource) fetchedAtSources.add(result.fetchedAtSource);
    for (const raw of result.offers) {
      const languages = offerLanguages(raw);
      if (!languages.length) continue;
      const condition = String(raw.condition || '').trim().toUpperCase();
      if (!['M', 'NM'].includes(condition)) continue;
      const sellerValue = raw.store_name ?? raw.store?.name ?? raw.seller;
      const seller = String(typeof sellerValue === 'string' ? sellerValue : sellerValue?.name || '').trim();
      const sellerId = String(raw.store_id ?? raw.store?.id ?? raw.seller_id ?? raw.seller?.id ?? '').trim();
      const listingId = String(raw.offer_id ?? raw.listing_id ?? raw.id ?? '');
      const priceBrl = Number(raw.price_brl);
      if (!seller || !listingId || !Number.isFinite(priceBrl) || priceBrl <= 0) {
        throw new Error(`Anúncio da Liga sem vendedor, ID ou preço válido em ${cardId}; atualização cancelada.`);
      }
      const variantEnum = enumForLigaOffer(raw, availableEnums);
      for (const language of languages) {
        if (!availableEnums.some(item => item.language === language && item.value === variantEnum)) continue;
        offers.push({
          cardId, language, variantEnum, listingId: `${listingId}:${language}`, seller, sellerId,
          condition, priceBrl,
          url: raw.url || ligaCardUrl(card, edition, number, result.data),
          observedAt: result.fetchedAt,
        });
      }
    }
    if (result.offers.length < 2000) break;
    if (offset >= 20000) throw new Error(`A Liga excedeu o limite de paginação em ${cardId}; atualização cancelada.`);
  }
  return { offers, fetchedAt: latestFetchedAt, fetchedAtSources: [...fetchedAtSources].sort(), print: { edition, number } };
}
