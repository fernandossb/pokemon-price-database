import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = process.cwd();
const progressFile = 'data/ligapokemon-browser-progress.json';
const queueFile = 'data/ligapokemon-browser-queue.json';
const offersFile = 'data/ligapokemon-offers.json';
const mergedOffersFile = 'work/ligapokemon-offers-merged.json';
const aggregateCaptureFile = 'work/ligapokemon-browser-capture-aggregate.json';
const processedFile = 'data/ligapokemon-browser-processed.json';
const deltaCardIdsFile = 'work/ligapokemon-delta-card-ids.json';

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

function queueId(queue) {
  return `${queue.catalogHash}:${queue.generatedAt}`;
}

function runImporter(inputFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/import-liga-browser-capture.mjs', inputFile], {
      cwd: root,
      env: { ...process.env, LIGA_OFFERS_FILE: mergedOffersFile },
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Importador de checkpoints terminou com código ${code}.`)));
  });
}

if (!(await exists(progressFile))) {
  if (process.env.GITHUB_ENV) await fs.appendFile(process.env.GITHUB_ENV, `LIGA_OFFERS_FILE=${offersFile}\n`);
  console.log('Sem checkpoint da extensão; usando o snapshot completo da Liga.');
  process.exit(0);
}

const progress = JSON.parse(await fs.readFile(progressFile, 'utf8'));
const queue = JSON.parse(await fs.readFile(queueFile, 'utf8'));
const catalog = JSON.parse(await fs.readFile('work/catalog.json', 'utf8'));
if (progress?.source !== 'ligapokemon-crawl-progress' || progress.queueId !== queueId(queue)
  || progress.catalogHash !== catalog.hash || queue.catalogHash !== catalog.hash) {
  if (process.env.GITHUB_ENV) await fs.appendFile(process.env.GITHUB_ENV, `LIGA_OFFERS_FILE=${offersFile}\n`);
  console.log('Checkpoint de outra fila ou catálogo; usando o snapshot-base da Liga.');
  process.exit(0);
}
if (progress?.schemaVersion !== 1 || !Array.isArray(progress.completedIndices)
  || !Array.isArray(progress.checkpointFiles) || !Array.isArray(queue.cards)) {
  throw new Error('O índice dos checkpoints está malformado.');
}

const cardsById = new Map();
const queueIndexById = new Map(queue.cards.map((card, index) => [String(card.cardId), index]));
for (const relativeFile of progress.checkpointFiles) {
  if (typeof relativeFile !== 'string'
    || !relativeFile.startsWith('data/ligapokemon-browser-checkpoints/')
    || relativeFile.includes('..')) throw new Error('Caminho de checkpoint inválido.');
  const chunk = JSON.parse(await fs.readFile(path.resolve(root, relativeFile), 'utf8'));
  if (chunk?.queueId !== progress.queueId || chunk?.catalogHash !== progress.catalogHash || !Array.isArray(chunk.cards)) {
    throw new Error(`Checkpoint inválido: ${relativeFile}`);
  }
  for (const card of chunk.cards) {
    const cardId = String(card.cardId || '');
    if (!queueIndexById.has(cardId) || card.captured !== true || !Array.isArray(card.offers)) {
      throw new Error(`Carta inválida no checkpoint ${relativeFile}: ${cardId || '(sem ID)'}`);
    }
    cardsById.set(cardId, card);
  }
}

const completedIndices = [...new Set(progress.completedIndices.filter(index => Number.isInteger(index)
  && index >= 0 && index < queue.cards.length))];
if (cardsById.size !== completedIndices.length) {
  throw new Error(`Checkpoints cobrem ${cardsById.size} cartas, mas o índice declara ${completedIndices.length}.`);
}
if (progress.complete && completedIndices.length !== queue.cards.length) {
  throw new Error('O índice marca a coleta completa, mas ainda faltam cartas.');
}

let previousProcessed = null;
try { previousProcessed = JSON.parse(await fs.readFile(processedFile, 'utf8')); } catch {}
const sameQueue = previousProcessed?.schemaVersion === 1
  && previousProcessed.queueId === progress.queueId
  && previousProcessed.catalogHash === progress.catalogHash
  && Array.isArray(previousProcessed.completedIndices);
const processedIndices = new Set(sameQueue ? previousProcessed.completedIndices : []);
const newIndices = completedIndices.filter(index => !processedIndices.has(index));
const newCards = newIndices.map(index => cardsById.get(String(queue.cards[index]?.cardId))).filter(Boolean);
if (newCards.length !== newIndices.length) {
  throw new Error('Há novos índices completos sem captura correspondente; nenhum marcador foi avançado.');
}
const nextProcessedIndices = [...new Set([...processedIndices, ...completedIndices])].sort((a, b) => a - b);
await fs.mkdir('work', { recursive: true });
await fs.writeFile(deltaCardIdsFile, JSON.stringify(newCards.map(card => String(card.cardId))));
await fs.writeFile(processedFile, JSON.stringify({
  schemaVersion: 1,
  source: 'ligapokemon-browser-processed',
  queueId: progress.queueId,
  catalogHash: progress.catalogHash,
  completedIndices: nextProcessedIndices,
  processedAt: new Date().toISOString(),
}));

const capture = {
  schemaVersion: 1,
  source: 'ligapokemon-browser-capture',
  capturedAt: progress.updatedAt,
  coverage: {
    catalogHash: queue.catalogHash,
    cardCount: queue.catalogCardCount,
    eligibleCardCount: queue.cards.length,
    excludedCardCount: queue.excluded.length,
    capturedCardCount: completedIndices.length,
    batchCardCount: newCards.length,
    complete: progress.complete === true,
  },
  excluded: queue.excluded,
  cards: newCards,
};
await fs.mkdir('work', { recursive: true });
await fs.writeFile(aggregateCaptureFile, JSON.stringify(capture));
await fs.copyFile(offersFile, mergedOffersFile).catch(async () => {
  await fs.writeFile(mergedOffersFile, JSON.stringify({ schemaVersion: 2, source: 'ligapokemon',
    capturedAt: new Date().toISOString(), coverage: { catalogHash: catalog.hash, cardCount: catalog.count, complete: true },
    pendingMappings: [], offers: [] }));
});
await runImporter(aggregateCaptureFile);
// The progress file is cumulative even while the queue is still running. Save
// each validated partial snapshot so the next Actions run can retain and
// replace offers by captured card instead of losing them in runner temp files.
await fs.copyFile(mergedOffersFile, offersFile);
if (process.env.GITHUB_ENV) await fs.appendFile(process.env.GITHUB_ENV, `LIGA_OFFERS_FILE=${mergedOffersFile}\n`);
if (process.env.GITHUB_ENV) await fs.appendFile(process.env.GITHUB_ENV, `LIGA_DELTA_CARD_IDS_FILE=${deltaCardIdsFile}\n`);
console.log(`Checkpoints preparados: ${newCards.length} novas/alteradas; ${completedIndices.length}/${queue.cards.length} acumuladas; fila ${progress.complete ? 'completa' : 'em andamento'}.`);
