import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './lib.mjs';

const root = process.cwd();
const shardDir = path.resolve(root, 'work', 'shards-mypcards');
const prefix = `${path.resolve(root)}${path.sep}`;
if (!shardDir.startsWith(prefix)) throw new Error('Pasta de shards fora do repositório; atualização cancelada.');

function runNode(script, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${script} terminou com código ${code}.`)));
  });
}

await fs.mkdir('work', { recursive: true });
await runNode('scripts/build-catalog.mjs');
try {
  await runNode('scripts/build-tcgplayer-prices.mjs');
} catch (error) {
  console.warn(`Snapshot TCGplayer indisponível; a coleta MYP Cards continua sem esse fallback. ${error.message}`);
}
await runNode('scripts/build-mypcards-prices.mjs');

const catalog = JSON.parse(await fs.readFile(path.join(root, 'work', 'catalog.json'), 'utf8'));
const snapshot = JSON.parse(await fs.readFile(path.join(root, 'work', 'mypcards-prices.json'), 'utf8'));
if (!catalog?.cards?.length || !snapshot?.meta?.generatedAt || !snapshot?.meta?.products) {
  throw new Error('Catálogo ou snapshot diário MYP Cards vazio; nada será publicado.');
}

await fs.mkdir(shardDir, { recursive: true });
for (const file of await fs.readdir(shardDir)) {
  if (/^shard-\d+\.json$/.test(file)) await fs.rm(path.join(shardDir, file));
}
let nextShard = 0;
const workerLimit = Math.min(3, Number(config.shardCount || 12));
const workers = Array.from({ length: workerLimit }, async () => {
  while (nextShard < Number(config.shardCount || 12)) {
    const shard = nextShard++;
    await runNode('scripts/process-mypcards-shard.mjs', {
      SHARD_INDEX: String(shard),
      SHARD_COUNT: String(config.shardCount || 12),
    });
  }
});
await Promise.all(workers);

for (let shard = 0; shard < Number(config.shardCount || 12); shard += 1) {
  await fs.access(path.join(shardDir, `shard-${String(shard).padStart(2, '0')}.json`));
}
await runNode('scripts/consolidate.mjs', { PRICE_SOURCE: 'mypcards', SHARD_OUTPUT_DIR: 'work/shards-mypcards' });
await runNode('scripts/validate-output.mjs');
console.log(`Atualização MYP Cards concluída: ${snapshot.meta.products} produtos, ${snapshot.meta.pricedRows} combinações e catálogo de ${catalog.count} cartas.`);
