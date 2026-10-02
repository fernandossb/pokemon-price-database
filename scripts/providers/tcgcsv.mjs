// Preços do TCGplayer por PRODUTO, pelo tcgcsv.com — espelho público e
// gratuito dos dados do TCGplayer, atualizado todo dia.
//
// Por que existe: o TCGdex liga cada versão especial da carta (Cosmos Holo,
// Poké Ball, Master Ball...) ao produto exato do TCGplayer
// (variants_detailed[].thirdParty.tcgplayer), mas nem sempre traz o preço
// desse produto. A Vileplume 003/094 em Cosmos Holo, por exemplo, é o produto
// 684043, vendido em "Miscellaneous Cards & Products" — o TCGdex não tem o
// preço dela; o TCGplayer tem.
//
// Sai um mapa productId -> subtipo -> preços, com os subtipos no mesmo
// formato do TCGdex ("Reverse Holofoil" -> "reverse-holofoil").
const BASE = 'https://tcgcsv.com/tcgplayer/3'; // 3 = Pokémon
const PRICE_FIELDS = ['marketPrice', 'midPrice', 'lowPrice', 'directLowPrice', 'highPrice'];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchJson(url, retries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': 'FicharioPokemonPriceBot/0.1' } });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      await sleep(600 * attempt);
    }
  }
  throw lastError;
}

export function tcgplayerSubtypeKey(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export async function loadTcgplayerProductPrices({ delayMs = 150 } = {}) {
  const groups = (await fetchJson(`${BASE}/groups`))?.results || [];
  const products = {};
  let failedGroups = 0;
  let priced = 0;
  for (const group of groups) {
    try {
      const prices = (await fetchJson(`${BASE}/${group.groupId}/prices`))?.results || [];
      for (const row of prices) {
        const fields = {};
        for (const field of PRICE_FIELDS) {
          const value = Number(row[field]);
          if (Number.isFinite(value) && value > 0) fields[field] = value;
        }
        if (!Object.keys(fields).length) continue;
        const subtype = tcgplayerSubtypeKey(row.subTypeName) || 'normal';
        if (!products[row.productId]) products[row.productId] = {};
        products[row.productId][subtype] = fields;
        priced += 1;
      }
    } catch (error) {
      failedGroups += 1;
      console.warn(`tcgcsv grupo ${group.groupId} (${group.name}): ${error.message}`);
    }
    await sleep(delayMs);
  }
  return { generatedAt: new Date().toISOString(), groups: groups.length, failedGroups, priced, products };
}
