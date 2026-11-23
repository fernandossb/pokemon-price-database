const API = 'https://mypcards.com/api/v1/pokemon/precos';
const PAGE_SIZE = 50;
const MAX_PAGES = 1200;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function retryAfterMs(response) {
  const raw = response.headers.get('retry-after');
  if (!raw) return 60_000;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(1_000, seconds * 1_000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(1_000, date - Date.now()) : 60_000;
}

async function getPage(page, token) {
  const url = new URL(API);
  url.searchParams.set('page_number', String(page));
  url.searchParams.set('page_size', String(PAGE_SIZE));
  const headers = { accept: 'application/json', 'user-agent': 'POKECARD-price-database/1.0' };
  if (token) headers['X-Api-Token'] = token;

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await fetch(url, { headers });
    if (response.status === 429) {
      const delay = retryAfterMs(response);
      console.warn(`MYP Cards limitou a chamada; aguardando ${Math.ceil(delay / 1000)}s antes da página ${page}.`);
      await sleep(delay);
      continue;
    }
    if (response.status >= 500 && attempt < 5) {
      await sleep(1_000 * attempt);
      continue;
    }
    if (!response.ok) throw new Error(`MYP Cards API respondeu HTTP ${response.status} na página ${page}`);
    const payload = await response.json();
    if (!Array.isArray(payload?.cards)) throw new Error(`Formato inválido na página ${page} da MYP Cards API`);
    const advertisedLimit = Number(response.headers.get('x-rate-limit-limit'));
    return { cards: payload.cards, minIntervalMs: advertisedLimit >= 60 ? 1_100 : 6_200 };
  }
  throw new Error(`MYP Cards API não respondeu após 5 tentativas (página ${page})`);
}

export async function loadMypCardsPrices({ token = process.env.MYP_CARDS_API_TOKEN || '' } = {}) {
  const products = [];
  const seenPages = new Set();
  let minIntervalMs = token ? 1_100 : 6_200;
  let page = 1;
  while (page <= MAX_PAGES) {
    // Respeita os limites oficiais: 10 req/min sem token e 60/min com token.
    if (page > 1) await sleep(minIntervalMs);
    const response = await getPage(page, token);
    minIntervalMs = response.minIntervalMs;
    const cards = response.cards;
    if (!cards.length) break;
    if (cards.length > PAGE_SIZE) throw new Error(`MYP Cards excedeu o tamanho de página documentado (${PAGE_SIZE})`);
    const fingerprint = cards.map(card => String(card.internal_code || '')).join('|');
    if (!fingerprint || seenPages.has(fingerprint)) throw new Error(`Paginação repetida/inválida da MYP Cards API na página ${page}`);
    seenPages.add(fingerprint);
    for (const card of cards) {
      const productId = Number(card.tcg_productId);
      if (!Number.isInteger(productId) || productId <= 0) continue;
      const rawPrices = Array.isArray(card.prices) ? card.prices : [];
      if (rawPrices.length && !rawPrices.some(row => typeof row?.sellerVerified === 'boolean'
          && String(row.sellerId || '').trim())) {
        throw new Error('A API pública da MYP Cards fornece preço agregado sem identificação/status do vendedor; a coleta foi interrompida porque só são aceitos lojistas verificados.');
      }
      // O preço agregado da API não identifica o vendedor. Só aceitamos uma
      // linha se a resposta trouxer identificação e confirmação explícita do
      // selo; o schema público atual não fornece esses campos.
      const prices = rawPrices
        .filter(row => row?.sellerVerified === true && String(row.sellerId || '').trim()
          && Number.isFinite(Number(String(row.min_price ?? '').replace(',', '.')))
          && Number(String(row.min_price).replace(',', '.')) > 0)
        .map(row => ({
          language: String(row.language || ''),
          printing: String(row.printing || ''),
          min_price: String(row.min_price),
          sellerId: String(row.sellerId),
          sellerVerified: true,
        }));
      if (!prices.length) continue;
      products.push({
        internal_code: Number(card.internal_code) || null,
        card_code: String(card.card_code || ''),
        tcg_productId: productId,
        name_pt: String(card.name_pt || ''),
        name_en: String(card.name_en || ''),
        edition_code: String(card.edition_code || ''),
        prices,
        link: String(card.link || 'https://mypcards.com'),
      });
    }
    console.log(`MYP Cards: página ${page}, ${cards.length} produtos (${products.length} produtos ligados a preço/ID TCGplayer).`);
    page += 1;
  }
  if (page > MAX_PAGES) throw new Error(`MYP Cards excedeu o limite de segurança de ${MAX_PAGES} páginas`);
  if (!products.length) {
    throw new Error('A API pública do MYP Cards retorna apenas preço mínimo agregado, sem ID/selo do vendedor. Nenhum valor foi importado porque o filtro exige lojista verificado.');
  }

  const byTcgProductId = {};
  for (const product of products) {
    const key = String(product.tcg_productId);
    (byTcgProductId[key] ||= []).push(product);
  }
  return {
    meta: {
      provider: 'mypcards',
      generatedAt: new Date().toISOString(),
      pages: page - 1,
      products: products.length,
      pricedRows: products.reduce((sum, product) => sum + product.prices.length, 0),
      verifiedSellerRows: products.reduce((sum, product) => sum + product.prices.filter(row => row.sellerVerified === true).length, 0),
      attributionUrl: 'https://mypcards.com',
    },
    byTcgProductId,
  };
}
