import fs from 'node:fs/promises';

const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const ALLOWED_LANGUAGES = new Set(['pt-br', 'en', 'ja']);

export function normalizeLigaOffer(raw, nowMs = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const cardId = String(raw.cardId || '');
  const language = String(raw.language || '');
  const variantEnum = String(raw.variantEnum || '');
  const listingId = String(raw.listingId || '');
  const seller = String(raw.seller || '').trim();
  const condition = String(raw.condition || '').trim().toUpperCase();
  const priceBrl = Number(raw.priceBrl);
  const observedAt = String(raw.observedAt || '');
  const observedMs = Date.parse(observedAt);
  if (!/^[a-zA-Z0-9_.-]+$/.test(cardId) || !ALLOWED_LANGUAGES.has(language)) return null;
  if (!variantEnum || variantEnum !== variantEnum.trim() || variantEnum.length > 100) return null;
  if (!listingId || listingId.length > 180 || !seller || seller.length > 120) return null;
  if (!condition || !Number.isFinite(priceBrl) || priceBrl <= 0 || priceBrl > 1_000_000) return null;
  if (!Number.isFinite(observedMs) || observedMs < nowMs - MAX_AGE_MS || observedMs > nowMs + 5 * 60 * 1000) return null;
  let url;
  try { url = new URL(String(raw.url || '')); } catch { return null; }
  if (url.protocol !== 'https:' || !/(^|\.)ligapokemon\.com\.br$/i.test(url.hostname)) return null;
  return { cardId, language, variantEnum, listingId, seller, condition, priceBrl,
    url: url.toString(), observedAt: new Date(observedMs).toISOString() };
}

export async function loadLigaOffers(file = 'data/ligapokemon-offers.json', nowMs = Date.now()) {
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  if (data?.schemaVersion !== 1 || !Array.isArray(data.offers)) {
    throw new Error('Formato inválido para data/ligapokemon-offers.json');
  }
  const byListing = new Map();
  for (const raw of data.offers) {
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

export function summarizeLigaOffers(offers = []) {
  const sellers = new Map();
  for (const offer of offers) {
    if (offer.condition !== 'NM') continue;
    const key = offer.seller.trim().toLocaleLowerCase('pt-BR');
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
