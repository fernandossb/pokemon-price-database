import fs from 'node:fs/promises';
import { loadMypCardsPrices } from './providers/mypcards.mjs';

await fs.mkdir('work', { recursive: true });
const prices = await loadMypCardsPrices();
if (prices?.meta?.provider !== 'mypcards' || !prices?.meta?.generatedAt || !prices?.byTcgProductId
  || typeof prices.byTcgProductId !== 'object' || Array.isArray(prices.byTcgProductId)) {
  throw new Error('Snapshot MYP Cards inválido; esperado meta.provider=mypcards e byTcgProductId.');
}
await fs.writeFile('work/mypcards-prices.json', JSON.stringify(prices));
console.log('Snapshot MYP Cards:', prices.meta);
