import fs from 'node:fs/promises';
const data = JSON.parse(await fs.readFile('output/prices-current.json', 'utf8'));
if (!data.meta || !data.prices || typeof data.prices !== 'object') throw new Error('Saída inválida');
for (const [key, item] of Object.entries(data.prices)) {
  if (!key.includes('::') || !Number.isFinite(item.priceBrl) || item.priceBrl <= 0) throw new Error(`Preço inválido: ${key}`);
}
console.log(`OK: ${Object.keys(data.prices).length} variantes com preço.`);
