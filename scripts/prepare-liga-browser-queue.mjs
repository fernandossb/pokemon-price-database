import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = process.cwd();
const catalogPath = path.resolve(root, process.env.LIGA_BROWSER_CATALOG || 'work/catalog.json');
const outputPath = path.resolve(root, process.env.LIGA_BROWSER_QUEUE || 'work/liga-browser-queue.json');
const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
if (!Array.isArray(catalog.cards) || !catalog.cards.length || !/^[a-f0-9]{64}$/i.test(catalog.hash || '')) {
  throw new Error('Catálogo TCGdex inválido; fila de coleta não foi criada.');
}
const ligaMap = JSON.parse(await fs.readFile(path.resolve(root, 'work/liga-version-map.json'), 'utf8'));
if (ligaMap?.cardIdHash !== createHash('sha256').update(catalog.cards.map(card => card.id).join('\n')).digest('hex')) {
  throw new Error('Mapeamento de versões Liga ausente ou de outro catálogo; fila não gerada.');
}

const variantCatalog = new Map();
const shardDir = path.resolve(root, 'output/shards');
for (let index = 0; index < 12; index += 1) {
  const file = path.join(shardDir, `shard-${String(index).padStart(2, '0')}.json`);
  const shard = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const [cardId, variants] of Object.entries(shard.variantCatalog || {})) {
    variantCatalog.set(cardId, [...(variantCatalog.get(cardId) || []), ...variants]);
  }
}

const cards = [];
const excluded = [];
for (const card of catalog.cards) {
  if (!card.marketplaceEligible || !card.edition || !card.detailUrl) {
    excluded.push({ cardId: card.id, setId: card.setId, setName: card.setName,
      reason: card.marketplaceExclusionReason || 'liga_print_unmatched' });
    continue;
  }
  const variants = variantCatalog.get(card.id) || [];
  const availableEnums = [...new Map(variants.map(item => [
    `${item.language}::${item.value}`,
    { language: item.language, value: item.value },
  ])).values()];
  if (!availableEnums.length) {
    throw new Error(`Variantes TCGdex ausentes para ${card.id}; fila integral não foi criada.`);
  }
  cards.push({
    cardId: card.id,
    name: card.ligaName || card.name,
    setId: card.setId,
    setName: card.setName,
    edition: card.edition,
    number: String(card.localId),
    setTotal: String(card.setTotal),
    detailUrl: card.detailUrl,
    availableEnums,
  });
}

const queue = {
  schemaVersion: 1,
  source: 'ligapokemon-version-map',
  catalogHash: catalog.hash,
  catalogCardCount: catalog.count,
  eligibleCardCount: cards.length,
  excludedCardCount: excluded.length,
  generatedAt: new Date().toISOString(),
  cards,
  excluded,
};
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, JSON.stringify(queue));
console.log(JSON.stringify({
  file: path.relative(root, outputPath),
  catalogHash: queue.catalogHash,
  catalogCards: queue.catalogCardCount,
  eligibleCards: queue.eligibleCardCount,
  excludedCards: queue.excludedCardCount,
}, null, 2));
