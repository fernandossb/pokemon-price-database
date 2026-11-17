import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './lib.mjs';
import { loadLigaOfferSnapshot } from './providers/ligaPokemon.mjs';

const repoRoot = process.cwd();
const snapshotFile = String(process.env.LIGA_OFFERS_FILE || 'data/ligapokemon-offers.json').trim();
const snapshot = await loadLigaOfferSnapshot(snapshotFile);
const shardCount = Number(config.shardCount || 12);
const workerLimit = Math.min(3, shardCount);
const snapshotId = `local-${snapshot.capturedAt.replace(/[^0-9]/g, '').slice(0, 14)}`;
const shardDir = path.resolve(repoRoot, 'work', 'shards');
const rootPrefix = `${path.resolve(repoRoot)}${path.sep}`;
if (!shardDir.startsWith(rootPrefix)) throw new Error('Caminho de shards fora do workspace; processamento cancelado.');

function runNode(script, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${script} terminou com código ${code}.`)));
  });
}

await runNode('scripts/build-catalog.mjs');
const catalog = JSON.parse(await fs.readFile(path.join(repoRoot, 'work', 'catalog.json'), 'utf8'));
if (catalog.hash !== snapshot.coverage.catalogHash || catalog.count !== snapshot.coverage.cardCount) {
  throw new Error(`Snapshot cobre catálogo ${snapshot.coverage.cardCount}/${snapshot.coverage.catalogHash}, mas o TCGdex atual é ${catalog.count}/${catalog.hash}; nada foi consolidado.`);
}

await fs.rm(shardDir, { recursive: true, force: true });
await fs.mkdir(shardDir, { recursive: true });
let nextShard = 0;
const workers = Array.from({ length: workerLimit }, async () => {
  while (nextShard < shardCount) {
    const shard = nextShard++;
    await runNode('scripts/process-shard.mjs', {
      SHARD_INDEX: String(shard),
      SHARD_COUNT: String(shardCount),
      LIGA_SNAPSHOT_ID: snapshotId,
      LIGA_OFFERS_FILE: snapshotFile,
    });
  }
});
await Promise.all(workers);

for (let shard = 0; shard < shardCount; shard += 1) {
  const file = path.join(shardDir, `shard-${String(shard).padStart(2, '0')}.json`);
  await fs.access(file);
}
await runNode('scripts/consolidate.mjs');
await runNode('scripts/validate-output.mjs');
console.log(`Snapshot Liga consolidado localmente: ${snapshot.offerCount} anúncios, catálogo ${catalog.count} cartas. Nenhum arquivo foi publicado.`);
