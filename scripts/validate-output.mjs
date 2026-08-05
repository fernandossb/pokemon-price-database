import fs from 'node:fs/promises';
import path from 'node:path';

const status = JSON.parse(await fs.readFile('output/status.json', 'utf8'));
const index = JSON.parse(await fs.readFile('output/card-shard-index.json', 'utf8'));

if (Number(status.schemaVersion) !== 4 || status.format !== 'sharded-v2') throw new Error('Versão/formato do status incompatível');
if (Number(index.meta?.schemaVersion) !== 4 || index.meta?.format !== 'card-shard-index-v2') throw new Error('Índice de cartas inválido');
if (status.status !== 'complete') throw new Error(`Atualização incompleta: ${status.shardsCompleted}/${status.shardsExpected} shards`);
if (!Number.isFinite(status.cardsInCatalog) || status.cardsInCatalog < 1) throw new Error('Catálogo vazio');
if (!Number.isFinite(status.variantsDiscovered) || status.variantsDiscovered < 1) throw new Error('Nenhum enum descoberto');
if (!Number.isFinite(status.variantsPriced) || status.variantsPriced < 1) throw new Error('Nenhum preço gerado');
if (Object.keys(index.cards || {}).length !== status.cardsInCatalog) throw new Error('Índice não cobre todo o catálogo');

let countedPrices = 0;
let countedVariants = 0;
for (const file of status.shardFiles || []) {
  const payload = JSON.parse(await fs.readFile(path.join('output/shards', file), 'utf8'));
  if (Number(payload.meta?.schemaVersion) !== 4 || payload.meta?.format !== 'price-shard-v2') throw new Error(`Shard inválido: ${file}`);
  countedPrices += Object.keys(payload.prices || {}).length;
  countedVariants += Object.values(payload.variantCatalog || {}).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
  for (const [key, item] of Object.entries(payload.prices || {})) {
    const expected = `${item.cardId}::${item.language}::${item.variantEnum}`;
    if (key !== expected) throw new Error(`Chave não exata em ${file}: ${key}`);
  }
}
if (countedPrices !== Number(status.variantsPriced)) throw new Error(`Contagem de preços divergente: ${countedPrices}`);
if (countedVariants !== Number(status.variantsDiscovered)) throw new Error(`Contagem de enums divergente: ${countedVariants}`);

console.log({
  status: status.status,
  cardsInCatalog: status.cardsInCatalog,
  shards: `${status.shardsCompleted}/${status.shardsExpected}`,
  variantsDiscovered: countedVariants,
  variantsPriced: countedPrices,
  unmatched: status.unmatched,
  generatedAt: status.generatedAt,
});
