import fs from 'node:fs/promises';

const current = JSON.parse(await fs.readFile('output/prices-current.json', 'utf8'));
const status = JSON.parse(await fs.readFile('output/status.json', 'utf8'));
if (!current || typeof current.prices !== 'object') throw new Error('prices-current.json inválido');
if (status.status !== 'complete') throw new Error(`Atualização incompleta: ${status.shardsCompleted}/${status.shardsExpected} shards`);
if (!Number.isFinite(status.cardsInCatalog) || status.cardsInCatalog < 1) throw new Error('Catálogo vazio');
if (!Number.isFinite(status.variantsPriced) || status.variantsPriced < 1) throw new Error('Nenhum preço gerado');
console.log({
  status: status.status,
  cardsInCatalog: status.cardsInCatalog,
  shards: `${status.shardsCompleted}/${status.shardsExpected}`,
  variantsPriced: status.variantsPriced,
  unmatched: status.unmatched,
  changedPrices: status.changedPrices,
  generatedAt: status.generatedAt
});
