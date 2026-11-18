import fs from 'node:fs/promises';
import path from 'node:path';

const status = JSON.parse(await fs.readFile('output/status.json', 'utf8'));
const index = JSON.parse(await fs.readFile('output/card-shard-index.json', 'utf8'));
const browserSnapshot = (status.ligaFetchedAtSources || []).includes('snapshot-captured-at');
const freshnessWindow = browserSnapshot ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;

if (Number(status.schemaVersion) !== 4 || status.format !== 'sharded-v2') throw new Error('Versão/formato do status incompatível');
if (Number(index.meta?.schemaVersion) !== 4 || index.meta?.format !== 'card-shard-index-v2') throw new Error('Índice de cartas inválido');
if (status.status !== 'complete') throw new Error(`Atualização incompleta: ${status.shardsCompleted}/${status.shardsExpected} shards`);
if (!Number.isFinite(status.cardsInCatalog) || status.cardsInCatalog < 1) throw new Error('Catálogo vazio');
if (!Number.isFinite(status.variantsDiscovered) || status.variantsDiscovered < 1) throw new Error('Nenhum enum descoberto');
if (!Number.isFinite(status.variantsPriced) || status.variantsPriced < 0) throw new Error('Contagem de preços inválida');
if (Object.keys(index.cards || {}).length !== status.cardsInCatalog) throw new Error('Índice não cobre todo o catálogo');
if (status.priceSource !== 'ligapokemon' || !status.ligaSnapshotId ||
    !Number.isFinite(Date.parse(status.ligaFetchedAtMin || '')) ||
    !Number.isFinite(Date.parse(status.ligaFetchedAtMax || '')) ||
    Date.parse(status.ligaFetchedAtMin) > Date.parse(status.ligaFetchedAtMax) ||
    Date.now() - Date.parse(status.ligaFetchedAtMin) > freshnessWindow ||
    !Number.isFinite(status.ligaOffersCount) || status.ligaOffersCount < 0) {
  throw new Error('O status não comprova snapshot live recente da Liga Pokémon.');
}

let countedPrices = 0;
let countedVariants = 0;
let countedLigaOffers = 0;
let ligaFetchedAtMin = null;
let ligaFetchedAtMax = null;
for (const file of status.shardFiles || []) {
  const payload = JSON.parse(await fs.readFile(path.join('output/shards', file), 'utf8'));
  const shardBrowserSnapshot = (payload.meta?.ligaFetchedAtSources || []).includes('snapshot-captured-at');
  const shardFreshnessWindow = shardBrowserSnapshot ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  if (Number(payload.meta?.schemaVersion) !== 4 || payload.meta?.format !== 'price-shard-v2') throw new Error(`Shard inválido: ${file}`);
  if (payload.meta?.priceSource !== 'ligapokemon' || payload.meta?.ligaSnapshotId !== status.ligaSnapshotId ||
      !Number.isFinite(Date.parse(payload.meta?.ligaFetchedAtMin || '')) ||
      !Number.isFinite(Date.parse(payload.meta?.ligaFetchedAtMax || '')) ||
      Date.parse(payload.meta.ligaFetchedAtMin) > Date.parse(payload.meta.ligaFetchedAtMax) ||
      Date.now() - Date.parse(payload.meta.ligaFetchedAtMin) > shardFreshnessWindow) {
    throw new Error(`Proveniência da execução Liga inválida: ${file}`);
  }
  const shardMin = Date.parse(payload.meta.ligaFetchedAtMin);
  const shardMax = Date.parse(payload.meta.ligaFetchedAtMax);
  ligaFetchedAtMin = ligaFetchedAtMin === null ? shardMin : Math.min(ligaFetchedAtMin, shardMin);
  ligaFetchedAtMax = ligaFetchedAtMax === null ? shardMax : Math.max(ligaFetchedAtMax, shardMax);
  countedLigaOffers += Number(payload.meta.ligaOffersCount) || 0;
  countedPrices += Object.keys(payload.prices || {}).length;
  countedVariants += Object.values(payload.variantCatalog || {}).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
  for (const [key, item] of Object.entries(payload.prices || {})) {
    const expected = `${item.cardId}::${item.language}::${item.variantEnum}`;
    if (key !== expected) throw new Error(`Chave não exata em ${file}: ${key}`);
    if (!Object.hasOwn(index.cards || {}, item.cardId) ||
        Number(index.cards[item.cardId]) !== Number(payload.meta.shardIndex)) {
      throw new Error(`Preço fora do shard atribuído pelo índice: ${file} ${key}`);
    }
    const sources = Array.isArray(item.sources) ? item.sources : [];
    if (item.priceMarket !== 'ligapokemon' || sources.length < 1 ||
        sources.some(source => source.source !== 'ligapokemon:listing' || source.used !== true ||
          !/^https:\/\/(www\.)?ligapokemon\.com\.br\//i.test(source.detail || '') ||
          !String(source.seller || '').trim() || !String(source.listingId || '').trim() ||
          !['M', 'NM'].includes(source.condition) || !Number.isFinite(Number(source.valueBrl)) ||
          Number(source.valueBrl) <= 0 || !Number.isFinite(Date.parse(source.observedAt || '')) ||
          Date.parse(source.observedAt) > Date.now() + 5 * 60 * 1000 ||
          Date.now() - Date.parse(source.observedAt) > freshnessWindow)) {
      throw new Error(`Preço sem proveniência exclusiva de anúncio da Liga: ${file} ${key}`);
    }
    const cheapestBySeller = new Map();
    for (const source of sources) {
      const sellerName = String(source.seller).trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ');
      const seller = source.sellerId ? `id:${source.sellerId}` : `name:${sellerName}`;
      const previous = cheapestBySeller.get(seller);
      const value = Number(source.valueBrl);
      if (previous === undefined || value < previous) cheapestBySeller.set(seller, value);
    }
    const sellerPrices = [...cheapestBySeller.values()].sort((a, b) => a - b);
    const middle = Math.floor(sellerPrices.length / 2);
    const median = sellerPrices.length % 2
      ? sellerPrices[middle]
      : (sellerPrices[middle - 1] + sellerPrices[middle]) / 2;
    if (sellerPrices.length < 1 || Math.abs(Number(item.priceBrl) - Math.round(median * 100) / 100) > 0.001 ||
        Number(item.brazilMarket?.sellerCount) !== sellerPrices.length ||
        Math.abs(Number(item.brazilMarket?.medianPriceBrl) - Number(item.priceBrl)) > 0.001) {
      throw new Error(`Mediana/preço não corresponde aos anúncios Liga de vendedores distintos: ${file} ${key}`);
    }
  }
}
if (countedPrices !== Number(status.variantsPriced)) throw new Error(`Contagem de preços divergente: ${countedPrices}`);
if (countedVariants !== Number(status.variantsDiscovered)) throw new Error(`Contagem de enums divergente: ${countedVariants}`);
if (countedLigaOffers !== Number(status.ligaOffersCount) ||
    ligaFetchedAtMin !== Date.parse(status.ligaFetchedAtMin) ||
    ligaFetchedAtMax !== Date.parse(status.ligaFetchedAtMax)) {
  throw new Error('Metadados de coleta Liga não correspondem aos shards publicados.');
}

console.log({
  status: status.status,
  cardsInCatalog: status.cardsInCatalog,
  shards: `${status.shardsCompleted}/${status.shardsExpected}`,
  variantsDiscovered: countedVariants,
  variantsPriced: countedPrices,
  unmatched: status.unmatched,
  generatedAt: status.generatedAt,
});
