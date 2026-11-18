import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '127.0.0.1';
const PORT = Number(process.env.LIGA_SYNC_PORT || 17835);
const MAX_BODY = 100 * 1024 * 1024;
const PROGRESS_FILE = 'data/ligapokemon-browser-progress.json';
const QUEUE_FILE = 'data/ligapokemon-browser-queue.json';
const CHECKPOINT_DIR = 'data/ligapokemon-browser-checkpoints';
let syncLock = false;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      windowsHide: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${path.basename(command)} ${args[0] || ''} falhou (${code}): ${(stderr || stdout).slice(-3000)}`)));
  });
}

const runNode = (script, ...args) => run(process.execPath, [path.join(ROOT, script), ...args]);

async function fetchRemoteBranch() {
  const branch = process.env.LIGA_SYNC_BRANCH || 'main';
  await run('git', ['fetch', 'origin', branch]);
}

async function remoteJson(file) {
  const branch = process.env.LIGA_SYNC_BRANCH || 'main';
  try {
    const { stdout } = await run('git', ['show', `origin/${branch}:${file}`]);
    return JSON.parse(stdout);
  } catch (error) {
    if (/path .* does not exist|exists on disk, but not in|does not exist in/i.test(error.message)) return null;
    throw error;
  }
}

function queueId(queue) {
  return `${queue.catalogHash}:${queue.generatedAt}`;
}

function queueStorageId(queue) {
  return `${queue.catalogHash}-${String(queue.generatedAt || '').replace(/\D/g, '')}`;
}

async function remoteResumeState() {
  await fetchRemoteBranch();
  const queue = await remoteJson(QUEUE_FILE);
  if (!queue || queue?.source !== 'ligapokemon-version-map') {
    throw new Error('Ainda não existe uma fila de coleta publicada no pokemon-price-database.');
  }
  const progress = await remoteJson(PROGRESS_FILE);
  const valid = progress?.source === 'ligapokemon-crawl-progress'
    && progress.queueId === queueId(queue)
    && progress.catalogHash === queue.catalogHash;
  const completedIndices = valid && Array.isArray(progress.completedIndices)
    ? [...new Set(progress.completedIndices.filter(index => Number.isInteger(index) && index >= 0 && index < queue.cards.length))] : [];
  const cardIds = completedIndices.map(index => String(queue.cards[index].cardId));
  return { queue, progress: { queueId: queueId(queue), catalogHash: queue.catalogHash,
    cardIds, completedIndices, capturedCount: cardIds.length, complete: Boolean(valid && progress.complete) } };
}

function send(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function allowedOrigin(origin) {
  return /^chrome-extension:\/\/[a-p]{32}$/.test(String(origin || ''));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error(`Snapshot ultrapassou o limite de ${Math.round(MAX_BODY / 1024 / 1024)} MB.`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('O corpo enviado não é um JSON válido.')); }
    });
    request.on('error', reject);
  });
}

async function atomicJson(file, value) {
  const target = path.join(ROOT, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.incoming`;
  await fs.writeFile(temporary, JSON.stringify(value));
  await fs.rename(temporary, target);
}

async function publish(files, message) {
  const branch = process.env.LIGA_SYNC_BRANCH || 'main';
  const { stdout } = await run('git', ['branch', '--show-current']);
  if (!stdout.trim() || stdout.trim() === 'HEAD') throw new Error('O repositório precisa estar em uma branch para publicar.');
  await run('git', ['pull', '--rebase', '--autostash', 'origin', branch]);
  await run('git', ['add', '--', ...files]);
  const changed = await run('git', ['diff', '--cached', '--name-only']);
  if (!changed.stdout.trim()) return { committed: false, branch };
  await run('git', ['-c', 'user.name=POKECARD Liga Sync', '-c', 'user.email=actions@users.noreply.github.com', 'commit', '-m', message]);
  await run('git', ['push', 'origin', `HEAD:${branch}`]);
  return { committed: true, branch };
}

async function receiveEditionIndex(snapshot) {
  if (snapshot?.schemaVersion !== 1 || snapshot?.source !== 'ligapokemon-browser-edition-index'
    || snapshot.coverage?.complete !== true || snapshot.coverage?.editionCount !== 813
    || snapshot.coverage?.capturedEditionCount !== 813 || snapshot.editions?.length !== 813
    || snapshot.editions.some(item => item.captured !== true || !Array.isArray(item.versions))) {
    throw new Error('O índice não cobre as 813 edições completas; nada foi publicado.');
  }
  await atomicJson('data/ligapokemon-edition-index.json', snapshot);
  const catalogPath = path.join(ROOT, 'work', 'catalog.json');
  try { await fs.access(catalogPath); }
  catch { throw new Error('Catálogo local ausente. Gere o catálogo antes de iniciar o coletor automático.'); }
  await runNode('scripts/import-liga-version-index.mjs', 'data/ligapokemon-edition-index.json');
  await runNode('scripts/build-catalog.mjs');
  await runNode('scripts/prepare-liga-browser-queue.mjs');
  const queuePath = path.join(ROOT, 'work', 'liga-browser-queue.json');
  const queue = JSON.parse(await fs.readFile(queuePath, 'utf8'));
  await atomicJson('data/ligapokemon-browser-queue.json', queue);
  const result = await publish(
    ['data/ligapokemon-edition-index.json', 'data/ligapokemon-browser-queue.json'],
    `Salvar índice Liga Pokémon (${snapshot.coverage.capturedEditionCount} edições)`,
  );
  const resume = await remoteResumeState();
  return {
    ok: true,
    message: `Índice salvo no GitHub: ${snapshot.coverage.capturedEditionCount} edições. Fila com ${queue.cards.length} cartas pronta.`,
    queue,
    progress: resume.queue.catalogHash === queue.catalogHash ? resume.progress : null,
    committed: result.committed,
  };
}

async function receivePriceCapture(snapshot) {
  const capturePath = path.join(ROOT, 'work', 'ligapokemon-browser-capture-incoming.json');
  await fs.mkdir(path.dirname(capturePath), { recursive: true });
  await fs.writeFile(capturePath, JSON.stringify(snapshot));
  await runNode('scripts/import-liga-browser-capture.mjs', 'work/ligapokemon-browser-capture-incoming.json');
  const result = await publish(
    ['data/ligapokemon-offers.json'],
    `Salvar anúncios da Liga Pokémon ${new Date().toISOString().slice(0, 10)}`,
  );
  return {
    ok: true,
    message: result.committed
      ? 'Anúncios enviados ao pokemon-price-database. O GitHub Actions vai processar e publicar os preços.'
      : 'Os anúncios já estavam salvos no pokemon-price-database.',
  };
}

async function receivePriceCheckpoint(checkpoint) {
  if (checkpoint?.schemaVersion !== 1 || checkpoint?.source !== 'ligapokemon-browser-checkpoint'
    || !/^[a-f0-9]{64}$/i.test(String(checkpoint.catalogHash || ''))
    || typeof checkpoint.queueId !== 'string' || !Array.isArray(checkpoint.cards)
    || typeof checkpoint.complete !== 'boolean') {
    throw new Error('Checkpoint da Liga inválido.');
  }
  const resume = await remoteResumeState();
  const queue = resume.queue;
  if (checkpoint.catalogHash !== queue.catalogHash || checkpoint.queueId !== queueId(queue)) {
    throw new Error('A fila local não corresponde à fila atual publicada no pokemon-price-database.');
  }
  const queueIndexById = new Map(queue.cards.map((card, index) => [String(card.cardId), index]));
  const previous = await remoteJson(PROGRESS_FILE);
  const previousIsCurrent = previous?.source === 'ligapokemon-crawl-progress'
    && previous.queueId === queueId(queue) && previous.catalogHash === queue.catalogHash;
  const completedIndices = new Set(previousIsCurrent && Array.isArray(previous.completedIndices)
    ? previous.completedIndices.filter(index => Number.isInteger(index) && index >= 0 && index < queue.cards.length) : []);
  const batchCards = [];
  for (const item of checkpoint.cards) {
    const cardId = String(item?.cardId || '');
    const index = queueIndexById.get(cardId);
    const card = Number.isInteger(index) ? queue.cards[index] : null;
    if (!card || !item?.captured || !Array.isArray(item.offers)
      || !Number.isFinite(Date.parse(String(item.capturedAt || '')))) {
      throw new Error(`Carta inválida ou fora da fila no checkpoint: ${cardId || '(sem ID)'}.`);
    }
    if (completedIndices.has(index)) continue;
    completedIndices.add(index);
    batchCards.push({ ...card, captured: true, capturedAt: item.capturedAt,
      rowCount: Number(item.rowCount) || 0, unpricedRowCount: Number(item.unpricedRowCount) || 0,
      offers: item.offers });
  }
  if (checkpoint.complete && completedIndices.size !== queue.cards.length) {
    throw new Error(`Não posso fechar a coleta: checkpoint tem ${completedIndices.size}/${queue.cards.length} cartas.`);
  }
  const progress = {
    schemaVersion: 1,
    source: 'ligapokemon-crawl-progress',
    queueId: queueId(queue),
    catalogHash: queue.catalogHash,
    complete: checkpoint.complete || Boolean(previousIsCurrent && previous.complete),
    completedIndices: [...completedIndices].sort((a, b) => a - b),
    checkpointFiles: [...(previousIsCurrent && Array.isArray(previous.checkpointFiles) ? previous.checkpointFiles : [])],
    updatedAt: new Date().toISOString(),
  };
  const files = [PROGRESS_FILE];
  if (batchCards.length) {
    const checkpointFile = `${CHECKPOINT_DIR}/${queueStorageId(queue)}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.json`;
    await atomicJson(checkpointFile, { schemaVersion: 1, queueId: queueId(queue),
      catalogHash: queue.catalogHash, capturedCount: completedIndices.size, capturedAt: new Date().toISOString(), cards: batchCards });
    progress.checkpointFiles.push(checkpointFile);
    files.push(checkpointFile);
  }
  await atomicJson(PROGRESS_FILE, progress);
  const published = await publish(files,
    `Checkpoint Liga Pokémon ${completedIndices.size}/${queue.cards.length}`);
  return { ok: true, capturedCount: completedIndices.size, total: queue.cards.length,
    complete: checkpoint.complete, committed: published.committed,
    message: checkpoint.complete
      ? `Coleta concluída e publicada (${completedIndices.size} cartas).`
      : `Checkpoint salvo no GitHub (${completedIndices.size}/${queue.cards.length}); processamento dos preços iniciado.` };
}

const server = http.createServer(async (request, response) => {
  const origin = String(request.headers.origin || '');
  if (allowedOrigin(origin)) {
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader('vary', 'Origin');
    response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    response.setHeader('access-control-allow-headers', 'content-type');
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.socket.remoteAddress !== '127.0.0.1' && request.socket.remoteAddress !== '::1'
    && request.socket.remoteAddress !== '::ffff:127.0.0.1') {
    send(response, 403, { ok: false, error: 'A sincronização aceita apenas conexões locais.' });
    return;
  }
  if (request.method === 'GET' && request.url === '/health') {
    send(response, 200, { ok: true, service: 'pokecard-liga-sync' });
    return;
  }
  if (request.method === 'GET' && request.url === '/sync/resume') {
    if (!allowedOrigin(origin)) {
      send(response, 403, { ok: false, error: 'Origem não autorizada para o coletor POKECARD.' });
      return;
    }
    if (syncLock) {
      send(response, 409, { ok: false, error: 'Uma sincronização já está em andamento.' });
      return;
    }
    try { send(response, 200, { ok: true, ...(await remoteResumeState()) }); }
    catch (error) { send(response, 400, { ok: false, error: error.message }); }
    return;
  }
  if (request.method !== 'POST' || !['/sync/editions', '/sync/prices', '/sync/checkpoint'].includes(request.url)) {
    send(response, 404, { ok: false, error: 'Rota não encontrada.' });
    return;
  }
  if (!allowedOrigin(origin)) {
    send(response, 403, { ok: false, error: 'Origem não autorizada para o coletor POKECARD.' });
    return;
  }
  if (syncLock) {
    send(response, 409, { ok: false, error: 'Uma sincronização já está em andamento.' });
    return;
  }
  syncLock = true;
  try {
    const snapshot = await readBody(request);
    const result = request.url === '/sync/editions' ? await receiveEditionIndex(snapshot)
      : request.url === '/sync/checkpoint' ? await receivePriceCheckpoint(snapshot)
        : await receivePriceCapture(snapshot);
    send(response, 200, result);
  } catch (error) {
    send(response, 400, { ok: false, error: error.message || 'Falha ao salvar no pokemon-price-database.' });
  } finally {
    syncLock = false;
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`POKECARD Liga Sync ativo em http://${HOST}:${PORT}\n`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
