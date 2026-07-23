import fs from 'node:fs/promises';
import path from 'node:path';
import { config, nowIso, readJson, round2, todayUtc } from './lib.mjs';

await fs.mkdir('output', { recursive: true });
await fs.mkdir('cache/shards', { recursive: true });
await fs.mkdir('history', { recursive: true });
const catalog = await readJson('work/catalog.json', null);
if (!catalog?.cards?.length) throw new Error('Catálogo ausente');
const previous = await readJson('output/prices-current.json', { prices: {}, meta: {} });
const previousPrices = previous.prices || {};
const merged = { ...previousPrices };
const unmatchedByKey = new Map();
const shardDir = 'work/shards';
let files = [];
try { files = (await fs.readdir(shardDir)).filter(file => file.endsWith('.json')).sort(); } catch {}
if (!files.length) throw new Error('Nenhum resultado de shard encontrado');

const shards = [];
for (const file of files) {
  const result = await readJson(path.join(shardDir, file), null);
  if (!result?.meta) continue;
  if (result.meta.catalogHash !== catalog.hash) throw new Error(`Hash de catálogo divergente em ${file}`);
  shards.push(result.meta);
  Object.assign(merged, result.prices || {});
  for (const item of result.unmatched || []) unmatchedByKey.set(`${item.id}::${item.finish || ''}`, item);
  await fs.writeFile(path.join('cache/shards', file), JSON.stringify(result));
}

const changes = {};
const threshold = Math.max(0, config.priceChangeThresholdPercent || 0.1) / 100;
for (const [key, item] of Object.entries(merged)) {
  const old = previousPrices[key];
  if (!old) {
    changes[key] = { oldPriceBrl: null, newPriceBrl: item.priceBrl, changePercent: null };
    continue;
  }
  const oldPrice = Number(old.priceBrl);
  const newPrice = Number(item.priceBrl);
  if (!Number.isFinite(oldPrice) || !Number.isFinite(newPrice) || oldPrice <= 0) continue;
  const pct = (newPrice - oldPrice) / oldPrice;
  if (Math.abs(pct) >= threshold) {
    changes[key] = { oldPriceBrl: oldPrice, newPriceBrl: newPrice, changePercent: round2(pct * 100) };
  }
}

const generatedAt = nowIso();
const unmatched = [...unmatchedByKey.values()];
const completeShards = new Set(shards.map(s => s.shardIndex));
const meta = {
  status: completeShards.size === (config.shardCount || 12) ? 'complete' : 'partial',
  generatedAt,
  date: todayUtc(),
  catalogHash: catalog.hash,
  cardsInCatalog: catalog.count,
  shardsExpected: config.shardCount || 12,
  shardsCompleted: completeShards.size,
  variantsPriced: Object.keys(merged).length,
  unmatched: unmatched.length,
  changedPrices: Object.keys(changes).length,
  workers: shards
};

await fs.writeFile('output/prices-current.json', JSON.stringify({ meta, prices: merged }));
await fs.writeFile('output/unmatched-cards.json', JSON.stringify(unmatched));
await fs.writeFile('output/status.json', JSON.stringify(meta, null, 2));
await fs.writeFile(`history/${todayUtc()}-changes.json`, JSON.stringify({ meta, changes }));
console.log(meta);
if (meta.status !== 'complete') throw new Error(`Consolidação parcial: ${meta.shardsCompleted}/${meta.shardsExpected} shards`);
