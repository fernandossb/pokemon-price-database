const DB_NAME = 'pokecard-liga-browser-collector';
const DB_VERSION = 5;
// Randomized pacing: wait 3–5 seconds between successfully captured pages.
const MIN_PAGE_DELAY_MS = 3_000;
const MAX_PAGE_DELAY_MS = 5_000;
const PAGE_RETRY_DELAY_MS = 60_000;
const MAX_PAGE_RETRIES = 6;
const MAX_RETRY_DELAY_MS = 30 * 60_000;
const MAX_RETRY_AFTER_MS = 30 * 24 * 60 * 60_000;
const CHECKPOINT_SIZE = 100;
const CHECKPOINT_INTERVAL_MS = 10 * 60_000;
const PAGE_RETRY_ALARM = 'liga-page-retry';
const NEXT_PAGE_ALARM = 'liga-next-page';
const PERIODIC_CHECKPOINT_ALARM = 'liga-periodic-checkpoint';
const EDITIONS_URL = 'https://www.ligapokemon.com.br/?view=cards/edicoes';
const EDITION_SYNC_URL = 'http://127.0.0.1:17835/sync/editions';
const CHECKPOINT_SYNC_URL = 'http://127.0.0.1:17835/sync/checkpoint';
const RESUME_SYNC_URL = 'http://127.0.0.1:17835/sync/resume';
let captureLock = false;
let checkpointChain = Promise.resolve();
let dbPromise = null;
let queueCache = { queueId: '', queue: null };

function openDb() {
  if (dbPromise) return dbPromise;
  const pending = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const state = db.objectStoreNames.contains('state')
        ? request.transaction.objectStore('state')
        : db.createObjectStore('state', { keyPath: 'key' });
      const cards = db.objectStoreNames.contains('cards')
        ? request.transaction.objectStore('cards')
        : db.createObjectStore('cards', { keyPath: 'cardId' });
      const queues = db.objectStoreNames.contains('queues')
        ? request.transaction.objectStore('queues')
        : db.createObjectStore('queues', { keyPath: 'queueId' });
      if (!cards.indexNames.contains('pendingCheckpoint')) {
        cards.createIndex('pendingCheckpoint', 'pendingCheckpoint');
        const cursorRequest = cards.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const record = cursor.value;
          if (!record.checkpointed && !record.remoteCheckpoint
            && Number.isFinite(Date.parse(String(record.capturedAt || '')))
            && Array.isArray(record.offers)) {
            cursor.update({ ...record, pendingCheckpoint: 'pending' });
          }
          cursor.continue();
        };
      }
      // IndexedDB keys cannot be booleans. Migrate the v4 boolean marker to a
      // string key so IDBIndex.getAll() can safely query pending captures.
      if (request.oldVersion < 5) {
        const cursorRequest = cards.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const record = cursor.value;
          const isPending = !record.checkpointed && !record.remoteCheckpoint
            && Number.isFinite(Date.parse(String(record.capturedAt || '')))
            && Array.isArray(record.offers);
          if (isPending) record.pendingCheckpoint = 'pending';
          else delete record.pendingCheckpoint;
          cursor.update(record);
          cursor.continue();
        };
      }
      if (!db.objectStoreNames.contains('editions')) db.createObjectStore('editions', { keyPath: 'editionId' });
      if (request.oldVersion < 4) {
        const cursorRequest = state.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const job = cursor.value;
          const queue = job.key === 'job' ? job.queue : null;
          if (queue?.catalogHash && (job.queueId || queue.generatedAt)) {
            const queueId = job.queueId || `${queue.catalogHash}:${queue.generatedAt}`;
            queues.put({ queueId, queue });
            const migratedJob = { ...job, queueId, queueStored: true };
            delete migratedJob.queue;
            cursor.update(migratedJob);
          }
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        if (dbPromise === pending) dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      if (dbPromise === pending) dbPromise = null;
      reject(request.error);
    };
    request.onblocked = () => {
      if (dbPromise === pending) dbPromise = null;
      reject(new Error('A atualização do banco local aguarda o fechamento de outra conexão.'));
    };
  });
  dbPromise = pending;
  return pending;
}

async function readRecord(storeName, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function writeRecord(storeName, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function writeRecords(storeName, values) {
  if (!values.length) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const value of values) store.put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('A gravação do checkpoint foi cancelada.'));
  });
}

async function allRecords(storeName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function pendingCardCaptures() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('cards', 'readonly');
    const request = tx.objectStore('cards').index('pendingCheckpoint').getAll('pending');
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

function storedJob(job) {
  // Keep the large, mostly immutable catalog out of the status row written
  // after every page. The queue is persisted separately and cached per worker.
  const value = { ...job, key: 'job' };
  if (job.queue) {
    value.queueId = job.queueId || currentQueueId(job.queue);
    value.queueStored = true;
    delete value.queue;
  }
  return value;
}

async function getJob() {
  const job = await readRecord('state', 'job');
  if (!job?.queueStored || !job.queueId) return job;
  let queue = queueCache.queueId === job.queueId ? queueCache.queue : null;
  if (!queue) {
    const stored = await readRecord('queues', job.queueId);
    if (!stored?.queue) throw new Error('A fila salva localmente não foi encontrada.');
    queue = stored.queue;
    queueCache = { queueId: job.queueId, queue };
  }
  return { ...job, queue };
}

async function saveJob(job) {
  if (job.queue) {
    const queueId = job.queueId || currentQueueId(job.queue);
    if (queueCache.queueId !== queueId || queueCache.queue !== job.queue) {
      await writeRecord('queues', { queueId, queue: job.queue });
      queueCache = { queueId, queue: job.queue };
    }
    job.queueId = queueId;
    job.queueStored = true;
  }
  return writeRecord('state', storedJob(job));
}

async function replaceCollectionData(job, remoteIds = new Set(), preservedCaptures = []) {
  const db = await openDb();
  const value = storedJob(job);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['state', 'cards', 'editions', 'queues'], 'readwrite');
    tx.objectStore('cards').clear();
    tx.objectStore('editions').clear();
    tx.objectStore('queues').clear();
    for (const cardId of remoteIds) {
      tx.objectStore('cards').put({ cardId, checkpointed: true, remoteCheckpoint: true });
    }
    for (const record of preservedCaptures) {
      if (remoteIds.has(String(record.cardId))) continue;
      tx.objectStore('cards').put({ ...record, checkpointed: false, remoteCheckpoint: false,
        pendingCheckpoint: 'pending' });
    }
    if (job.queue) {
      tx.objectStore('queues').put({ queueId: value.queueId, queue: job.queue });
    }
    tx.objectStore('state').put(value);
    tx.oncomplete = () => {
      queueCache = job.queue
        ? { queueId: value.queueId, queue: job.queue }
        : { queueId: '', queue: null };
      resolve();
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('A atualização local da fila foi cancelada.'));
  });
}

function ligaDetailUrl(card) {
  if (!card.detailUrl) throw new Error(`URL da versão observada na Liga ausente para ${card.cardId}.`);
  let url;
  try { url = new URL(card.detailUrl); } catch { throw new Error(`URL Liga inválida para ${card.cardId}.`); }
  if (url.protocol !== 'https:' || !/(^|\.)ligapokemon\.com\.br$/i.test(url.hostname)
    || url.searchParams.get('view') !== 'cards/card'
    || url.searchParams.get('ed')?.toUpperCase() !== String(card.edition).toUpperCase()
    || String(url.searchParams.get('num') || '').replace(/^0+(?=\d)/, '') !== String(card.number).replace(/^0+(?=\d)/, '')) {
    throw new Error(`A impressão Liga de ${card.cardId} não corresponde à URL fornecida.`);
  }
  return url.href;
}

async function setStatus(status, reason = '') {
  const job = await getJob();
  if (!job) return null;
  job.status = status;
  job.reason = reason;
  job.inFlight = false;
  job.retryAt = 0;
  job.retryUrl = '';
  await chrome.alarms.clear(PAGE_RETRY_ALARM);
  await chrome.alarms.clear(NEXT_PAGE_ALARM);
  if (status !== 'running') await chrome.alarms.clear(PERIODIC_CHECKPOINT_ALARM);
  await saveJob(job);
  await chrome.action.setBadgeText({ text: status === 'paused' ? '!' : '' });
  if (status === 'paused') await chrome.action.setBadgeBackgroundColor({ color: '#b42318' });
  return job;
}

function pageLoadError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return /receiving end does not exist|could not establish connection|net::err_|navigation failed|tab crashed|frame was removed/.test(message);
}

function retryAfterDelay(responseHeaders = []) {
  const raw = responseHeaders.find(header => header.name?.toLowerCase() === 'retry-after')?.value?.trim();
  if (!raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.ceil(Number(raw) * 1000);
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}

function retryWaitLabel(milliseconds) {
  const minutes = Math.max(1, Math.ceil(milliseconds / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} h`;
}

async function scheduleNextPage() {
  const delay = MIN_PAGE_DELAY_MS + Math.floor(Math.random() * (MAX_PAGE_DELAY_MS - MIN_PAGE_DELAY_MS + 1));
  await chrome.alarms.create(NEXT_PAGE_ALARM, { when: Date.now() + delay });
}

async function schedulePeriodicCheckpoint(job) {
  if (job?.mode === 'card-prices' && job.status === 'running') {
    await chrome.alarms.create(PERIODIC_CHECKPOINT_ALARM, {
      when: Date.now() + CHECKPOINT_INTERVAL_MS,
      periodInMinutes: 10,
    });
  }
}

function currentPageUrl(job) {
  if (job?.mode === 'edition-index') return EDITIONS_URL;
  if (job?.mode === 'edition-discovery') return job.editions?.[job.index]?.url || '';
  const card = job?.queue?.cards?.[job.index];
  return card ? ligaDetailUrl(card) : '';
}

async function editionIndexSnapshot(job) {
  const editions = await allRecords('editions');
  const capturedIds = new Set(editions.map(item => String(item.editionId)));
  const capturesById = new Map(editions.map(item => [String(item.editionId), item]));
  return {
    schemaVersion: 1,
    source: 'ligapokemon-browser-edition-index',
    capturedAt: new Date().toISOString(),
    coverage: {
      editionCount: job.editions.length,
      capturedEditionCount: editions.length,
      complete: job.status === 'complete' && job.index === job.editions.length && editions.length === job.editions.length,
    },
    editions: job.editions.map(item => {
      const capture = capturesById.get(String(item.editionId));
      return { ...item, captured: capturedIds.has(String(item.editionId)), ...(capture || {}) };
    }),
  };
}

async function postSnapshot(url, snapshot) {
  const response = await fetch(url, {
    method: 'POST', headers: {
      'content-type': 'application/json',
      'x-pokecard-extension-id': chrome.runtime.id,
    }, body: JSON.stringify(snapshot),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok !== true) throw new Error(payload.error || `Servidor local respondeu HTTP ${response.status}.`);
  return payload;
}

function currentQueueId(queue) {
  return `${queue.catalogHash}:${queue.generatedAt}`;
}

async function getOwnedPriorityIds() {
  const stored = await readRecord('state', 'owned-priority');
  return new Set(Array.isArray(stored?.cardIds) ? stored.cardIds.map(String) : []);
}

function prioritizeQueue(queue, priorityIds, completedIds = new Set()) {
  const completed = [];
  const owned = [];
  const remaining = [];
  for (const card of queue.cards) {
    const id = String(card.cardId);
    if (completedIds.has(id)) completed.push(card);
    else if (priorityIds.has(id)) owned.push(card);
    else remaining.push(card);
  }
  return { ...queue, cards: [...completed, ...owned, ...remaining] };
}

function sameLigaPrintQueue(previousQueue, currentQueue) {
  if (!Array.isArray(previousQueue?.cards) || !Array.isArray(currentQueue?.cards)
    || previousQueue.catalogHash !== currentQueue.catalogHash
    || previousQueue.cards.length !== currentQueue.cards.length) return false;
  const previousById = new Map(previousQueue.cards.map(card => [String(card.cardId), card]));
  return currentQueue.cards.every(card => {
    const previous = previousById.get(String(card.cardId));
    return previous && previous.edition === card.edition
      && String(previous.number) === String(card.number)
      && previous.detailUrl === card.detailUrl;
  });
}

async function getRemoteResume() {
  const response = await fetch(RESUME_SYNC_URL, {
    cache: 'no-store',
    headers: { 'x-pokecard-extension-id': chrome.runtime.id },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok !== true) throw new Error(payload.error || `Servidor local respondeu HTTP ${response.status}.`);
  return payload;
}

async function installAndStartQueue(queue, tabId, progress = null) {
  if (queue?.source !== 'ligapokemon-version-map'
    || queue?.schemaVersion !== 1
    || !Array.isArray(queue.cards) || !Array.isArray(queue.excluded)
    || !/^[a-f0-9]{64}$/i.test(String(queue.catalogHash || ''))
    || queue.cards.length + queue.excluded.length !== Number(queue.catalogCardCount)) {
    throw new Error('O Price Database devolveu uma fila incompleta ou incompatível.');
  }
  const queueIdentity = currentQueueId(queue);
  const previousJob = await getJob();
  const remoteIds = new Set(progress?.queueId === queueIdentity
    && progress?.catalogHash === queue.catalogHash && Array.isArray(progress.cardIds)
    ? progress.cardIds.map(String) : []);
  const resetAt = Date.parse(String(queue.resetAt || queue.generatedAt || ''));
  const canRebaseLocalCaptures = previousJob?.mode === 'card-prices'
    && previousJob.queueId === queue.supersedesQueueId
    && sameLigaPrintQueue(previousJob.queue, queue)
    && Number.isFinite(resetAt);
  const preservedCaptures = canRebaseLocalCaptures
    ? (await allRecords('cards')).filter(record => !record.remoteCheckpoint
      && !remoteIds.has(String(record.cardId))
      && Number.isFinite(Date.parse(String(record.capturedAt || '')))
      && Date.parse(record.capturedAt) >= resetAt && Array.isArray(record.offers))
    : [];
  const preservedIds = new Set(preservedCaptures.map(record => String(record.cardId)));
  const completedIds = new Set([...remoteIds, ...preservedIds]);
  queue = prioritizeQueue(queue, await getOwnedPriorityIds(), completedIds);
  const index = queue.cards.findIndex(card => !completedIds.has(String(card.cardId)));
  const job = {
    mode: 'card-prices', queue, queueId: queueIdentity, status: 'running',
    index: index < 0 ? queue.cards.length : index, tabId,
    inFlight: false, retryCount: 0, remoteCapturedCount: remoteIds.size, pendingRemoteCount: preservedCaptures.length,
    reason: preservedCaptures.length
      ? `Fila atualizada; preservando ${preservedCaptures.length} capturas locais feitas após o reset.`
      : remoteIds.size ? `Retomando do checkpoint remoto: ${remoteIds.size} cartas já salvas.`
        : 'Fila atualizada do GitHub; iniciando a leitura dos anúncios.', importedAt: new Date().toISOString(),
  };
  await replaceCollectionData(job, remoteIds, preservedCaptures);
  await chrome.action.setBadgeText({ text: '' });
  if (job.index >= queue.cards.length) {
    job.status = 'complete';
    job.inFlight = false;
    job.reason = 'A fila remota já está completa; vou confirmar e atualizar os preços publicados.';
    await saveJob(job);
    void syncCompletedSearch(job);
  } else {
    await schedulePeriodicCheckpoint(job);
    await navigateToCurrent(job);
  }
}

async function performPriceCheckpoint(job, complete = false, allowQueueRecovery = true) {
  const queueCards = new Map(job.queue.cards.map(card => [String(card.cardId), card]));
  const captures = await pendingCardCaptures();
  if (!captures.length && !complete) {
    return { ok: true, capturedCount: Number(job.remoteCapturedCount || 0), committed: false,
      message: 'Nenhuma carta nova aguardando publicação no GitHub.' };
  }
  const payload = {
    schemaVersion: 1,
    source: 'ligapokemon-browser-checkpoint',
    queueId: job.queueId || currentQueueId(job.queue),
    catalogHash: job.queue.catalogHash,
    complete,
    cards: captures.map(record => {
      if (!queueCards.has(String(record.cardId))) throw new Error(`Captura fora da fila: ${record.cardId}.`);
      return { cardId: record.cardId, captured: true, capturedAt: record.capturedAt,
        rowCount: record.rowCount || 0, unpricedRowCount: record.unpricedRowCount || 0,
        unparsedRowCount: record.unparsedRowCount || 0, unparsedRows: record.unparsedRows || [],
        offers: record.offers };
    }),
  };
  let result;
  try {
    result = await postSnapshot(CHECKPOINT_SYNC_URL, payload);
  } catch (error) {
    if (!allowQueueRecovery || !/fila local não corresponde à fila atual/i.test(String(error?.message || error))) throw error;
    const remote = await getRemoteResume();
    await installAndStartQueue(remote.queue, job.tabId, remote.progress);
    const refreshedJob = await getJob();
    if (!refreshedJob) throw error;
    let message = refreshedJob.reason || 'Fila local atualizada a partir do GitHub.';
    if (refreshedJob.pendingRemoteCount > 0) {
      const migrated = await performPriceCheckpoint(refreshedJob, false, false);
      message = `${migrated.message || message} A fila antiga foi substituída pela atual.`;
    }
    const currentJob = await getJob();
    return { ok: true, recoveredQueue: true,
      capturedCount: Number(currentJob?.remoteCapturedCount) || 0,
      total: Number(currentJob?.queue?.cards?.length) || 0,
      complete: false, committed: false, message };
  }
  for (const record of captures) {
    record.checkpointed = true;
    delete record.pendingCheckpoint;
  }
  await writeRecords('cards', captures);
  const latest = await getJob();
  if (latest?.queueId === payload.queueId) {
    latest.remoteCapturedCount = result.capturedCount;
    latest.pendingRemoteCount = Math.max(0, Number(latest.pendingRemoteCount || 0) - captures.length);
    latest.lastCheckpointAt = new Date().toISOString();
    latest.lastCheckpointError = '';
    latest.reason = result.message || 'Checkpoint enviado ao pokemon-price-database.';
    await saveJob(latest);
    await schedulePeriodicCheckpoint(latest);
  }
  return result;
}

function syncPriceCheckpoint(job, complete = false) {
  const operation = checkpointChain.catch(() => {}).then(() => performPriceCheckpoint(job, complete));
  checkpointChain = operation;
  return operation.finally(() => {
    if (checkpointChain === operation) checkpointChain = Promise.resolve();
  });
}

async function flushPeriodicCheckpoint() {
  const job = await getJob();
  if (job?.mode !== 'card-prices' || job.status !== 'running') return;
  try {
    const result = await syncPriceCheckpoint(job, false);
    const latest = await getJob();
    if (latest?.queueId === job.queueId) {
      latest.lastPeriodicCheckpointAt = new Date().toISOString();
      latest.lastCheckpointError = '';
      if (result.message) latest.reason = result.message;
      await saveJob(latest);
      await schedulePeriodicCheckpoint(latest);
    }
  } catch (error) {
    const latest = await getJob();
    if (latest?.queueId === job.queueId) {
      latest.lastCheckpointError = `Falha no envio periódico ao GitHub: ${error.message}`;
      latest.reason = latest.lastCheckpointError;
      await saveJob(latest);
    }
  }
}

async function mergeRemoteProgress(job, progress) {
  if (progress?.queueId !== (job.queueId || currentQueueId(job.queue))
    || progress?.catalogHash !== job.queue.catalogHash || !Array.isArray(progress.cardIds)) return false;
  const completedIds = new Set(progress.cardIds.map(String));
  const records = await allRecords('cards');
  const recordsById = new Map(records.map(record => [String(record.cardId), record]));
  for (const cardId of completedIds) {
    if (!recordsById.has(cardId)) {
      await writeRecord('cards', { cardId, checkpointed: true, remoteCheckpoint: true });
      recordsById.set(cardId, { cardId, checkpointed: true, remoteCheckpoint: true });
    }
  }
  const firstMissing = job.queue.cards.findIndex(card => !recordsById.has(String(card.cardId)));
  job.index = firstMissing < 0 ? job.queue.cards.length : firstMissing;
  job.remoteCapturedCount = progress.capturedCount || completedIds.size;
  return true;
}

async function syncCompletedSearch(job) {
  if (job?.status !== 'complete') return;
  await chrome.alarms.clear(PERIODIC_CHECKPOINT_ALARM);
  try {
    if (job.mode === 'edition-discovery') {
      job.syncState = 'uploading';
      job.reason = 'Edições encontradas; salvando no pokemon-price-database…';
      await saveJob(job);
      const snapshot = await editionIndexSnapshot(job);
      if (!snapshot.coverage.complete) throw new Error('Índice de edições incompleto; envio cancelado.');
      const result = await postSnapshot(EDITION_SYNC_URL, snapshot);
      const latest = await getJob();
      if (!latest || latest.status !== 'complete' || latest.mode !== 'edition-discovery') return;
      await installAndStartQueue(result.queue, latest.tabId, result.progress);
      return;
    }
    if (job.queue?.cards?.length) {
      job.syncState = 'uploading';
      job.reason = 'Finalizando o último checkpoint no pokemon-price-database…';
      await saveJob(job);
      const result = await syncPriceCheckpoint(job, true);
      const latest = await getJob();
      if (!latest || latest.status !== 'complete') return;
      latest.syncState = 'published';
      latest.reason = result.message || 'Checkpoint final enviado; o GitHub atualizará os preços.';
      await saveJob(latest);
    }
  } catch (error) {
    const latest = await getJob();
    if (!latest || latest.status !== 'complete') return;
    latest.syncState = 'error';
    latest.reason = `Busca concluída, mas o envio ao Price Database falhou: ${error.message}`;
    await saveJob(latest);
  }
}

async function retryFailedPage() {
  const job = await getJob();
  if (!job || job.status !== 'running' || job.inFlight || !job.retryAt) return;
  const remaining = job.retryAt - Date.now();
  if (remaining > 0) {
    await chrome.alarms.create(PAGE_RETRY_ALARM, { when: job.retryAt });
    return;
  }
  const url = job.retryUrl || currentPageUrl(job);
  if (!url || !job.tabId) return;
  await chrome.alarms.clear(NEXT_PAGE_ALARM);
  job.retryAt = 0;
  job.retryUrl = '';
  job.inFlight = true;
  job.reason = 'Nova tentativa da página da Liga após o intervalo de espera.';
  await saveJob(job);
  await chrome.alarms.clear(PAGE_RETRY_ALARM);
  try {
    await chrome.tabs.update(job.tabId, { url });
  } catch (error) {
    job.inFlight = false;
    await saveJob(job);
    await schedulePageRetry(job, url, error);
  }
}

async function schedulePageRetry(job, url, error, requestedDelayMs = null) {
  if (!job || job.status !== 'running' || job.retryAt) return;
  const retryCount = (Number(job.retryCount) || 0) + 1;
  if (retryCount > MAX_PAGE_RETRIES) {
    await setStatus('paused', `Parei após ${MAX_PAGE_RETRIES} falhas seguidas ao carregar a Liga. Confira a conexão e retome manualmente mais tarde.`);
    return;
  }
  const backoff = Math.min(PAGE_RETRY_DELAY_MS * (2 ** (retryCount - 1)), MAX_RETRY_DELAY_MS);
  const delay = requestedDelayMs == null ? backoff : Math.max(MIN_PAGE_DELAY_MS, requestedDelayMs);
  if (!Number.isFinite(delay) || delay < 0 || delay > MAX_RETRY_AFTER_MS) {
    await setStatus('paused', 'A Liga pediu uma espera longa demais para retomar automaticamente. A coleta foi pausada para proteger este IP.');
    return;
  }
  job.inFlight = false;
  job.retryCount = retryCount;
  job.retryAt = Date.now() + delay;
  job.retryUrl = url || currentPageUrl(job);
  job.reason = `Falha ao carregar a página da Liga; tentativa ${retryCount}/${MAX_PAGE_RETRIES} em ${retryWaitLabel(delay)}. ${String(error?.message || error || '').slice(0, 160)}`;
  await saveJob(job);
  await chrome.alarms.clear(NEXT_PAGE_ALARM);
  await chrome.alarms.create(PAGE_RETRY_ALARM, { when: job.retryAt });
}

async function capturePriceSnapshot(job) {
  if (!job?.queue?.cards?.length) throw new Error('Fila de preços ausente.');
  const captures = (await allRecords('cards')).filter(record => !record.remoteCheckpoint
    && Number.isFinite(Date.parse(String(record.capturedAt || ''))) && Array.isArray(record.offers));
  const capturedIds = new Set(captures.map(record => record.cardId));
  const captureById = new Map(captures.map(record => [record.cardId, record]));
  return {
    schemaVersion: 1,
    source: 'ligapokemon-browser-capture',
    capturedAt: new Date().toISOString(),
    coverage: {
      catalogHash: job.queue.catalogHash,
      cardCount: job.queue.catalogCardCount,
      eligibleCardCount: job.queue.eligibleCardCount,
      excludedCardCount: job.queue.excludedCardCount,
      capturedCardCount: capturedIds.size,
      complete: job.status === 'complete' && job.index === job.queue.cards.length
        && capturedIds.size === job.queue.cards.length
        && job.queue.excluded.every(item => ['digital_only_tcg_pocket', 'liga_print_unmatched', 'multiple_liga_prints_for_card_id'].includes(item.reason)),
    },
    excluded: job.queue.excluded,
    cards: job.queue.cards.map(card => {
      const result = captureById.get(card.cardId);
      return { ...card, captured: Boolean(result), ...(result || {}) };
    }),
  };
}

async function createBackgroundTab() {
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  if (!tab?.id) throw new Error('Não foi possível abrir a aba de coleta em segundo plano.');
  return tab.id;
}

async function closeOldScannerTab(oldTabId, newTabId, sourceTabId) {
  if (!oldTabId || oldTabId === newTabId || oldTabId === sourceTabId) return;
  try { await chrome.tabs.remove(oldTabId); } catch {}
}

async function navigateToCurrent(job) {
  if (!job || job.status !== 'running') return;
  job.retryAt = 0;
  job.retryUrl = '';
  await chrome.alarms.clear(PAGE_RETRY_ALARM);
  await chrome.alarms.clear(NEXT_PAGE_ALARM);
  if (job.mode === 'edition-index') {
    job.inFlight = true;
    await saveJob(job);
    try { await chrome.tabs.update(job.tabId, { url: EDITIONS_URL }); }
    catch (error) { await schedulePageRetry(job, EDITIONS_URL, error); }
    return;
  }
  const items = job.mode === 'edition-discovery' ? job.editions : job.queue.cards;
  if (job.index >= items.length) {
    job.status = 'complete';
    job.inFlight = false;
    job.reason = '';
    await saveJob(job);
    return;
  }
  job.inFlight = true;
  await saveJob(job);
  const url = job.mode === 'edition-discovery' ? items[job.index].url : ligaDetailUrl(items[job.index]);
  try { await chrome.tabs.update(job.tabId, { url }); }
  catch (error) { await schedulePageRetry(job, url, error); }
}

async function sendPageMessage(tabId, message) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
      lastError = error;
      const messageText = String(error?.message || error);
      if (!/receiving end does not exist|could not establish connection/i.test(messageText)) throw error;
      if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw new Error(`A página da Liga não iniciou o coletor após 6 tentativas: ${lastError?.message || lastError}`);
}

async function captureLoadedPage(tabId) {
  if (captureLock) return;
  captureLock = true;
  try {
    let job = await getJob();
    if (!job || job.status !== 'running' || job.tabId !== tabId || !job.inFlight) return;
    if (job.mode === 'edition-index') {
      let index;
      try {
        index = await sendPageMessage(tabId, { type: 'CAPTURE_LIGA_EDITION_INDEX' });
      } catch (error) {
        if (pageLoadError(error)) await schedulePageRetry(job, EDITIONS_URL, error);
        else await setStatus('paused', `A página Edições da Liga não respondeu: ${error.message}`);
        return;
      }
      if (!index?.ok || !Array.isArray(index.editions) || !index.editions.length) {
        await setStatus('paused', `Descoberta pausada: ${index?.reason || 'lista de edições vazia'}`);
        return;
      }

      // Preserve captured editions that remain in the fresh Liga index. If
      // the job record was lost, this recovers the useful local progress.
      const captured = await allRecords('editions');
      const currentIds = new Set(index.editions.map(item => String(item.editionId)));
      const retained = captured.filter(item => currentIds.has(String(item.editionId)));
      const retainedIds = new Set(retained.map(item => String(item.editionId)));
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('editions', 'readwrite');
        const store = tx.objectStore('editions');
        store.clear();
        for (const item of retained) store.put(item);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });

      job = {
        mode: 'edition-discovery', editions: index.editions, status: 'running',
        index: index.editions.findIndex(item => !retainedIds.has(String(item.editionId))), retryCount: 0,
        tabId, inFlight: false, reason: '', startedAt: job.startedAt || new Date().toISOString(),
      };
      if (job.index < 0) {
        job.index = job.editions.length;
        job.status = 'complete';
      }
      await saveJob(job);
      if (job.status === 'running') {
        await scheduleNextPage();
      } else if (job.status === 'complete') {
        void syncCompletedSearch(job);
      }
      return;
    }
    if (job.mode === 'edition-discovery') {
      const edition = job.editions[job.index];
      if (!edition) return;
      let result;
      try {
        result = await sendPageMessage(tabId, { type: 'CAPTURE_LIGA_SET_VERSIONS', edition });
      } catch (error) {
        if (pageLoadError(error)) await schedulePageRetry(job, edition.url, error);
        else await setStatus('paused', `A edição ${edition.code} não respondeu ao coletor: ${error.message}`);
        return;
      }
      if (!result?.ok) {
        if (result?.reason === 'challenge_or_interstitial') {
          await setStatus('paused', 'A Liga/Cloudflare apresentou uma verificação. Parei a coleta; resolva-a manualmente e retome depois.');
          return;
        }
        const details = result?.reason === 'edition_list_incomplete'
          ? ` (esperadas ${result.expectedCount}, itens carregados ${result.cardItemCount}, versões lidas ${result.capturedCount}, botão Mostrar mais ${result.loadMorePresent ? (result.loadMoreVisible ? 'visível' : 'presente, porém oculto') : 'ausente'}, espera ${Math.round((result.waitedMs || 0) / 1000)}s)`
          : '';
        await setStatus('paused', `Descoberta pausada em ${edition.code}: ${result?.reason || 'erro sem detalhe'}${details}`);
        return;
      }
      await writeRecord('editions', result);
      job = await getJob();
      if (!job || job.status !== 'running' || job.index >= job.editions.length) return;
      job.index += 1;
      job.inFlight = false;
      job.retryCount = 0;
      job.reason = '';
      if (job.index >= job.editions.length) job.status = 'complete';
      await saveJob(job);
      if (job.status === 'running') {
        await scheduleNextPage();
      } else if (job.status === 'complete') void syncCompletedSearch(job);
      return;
    }
    const card = job.queue.cards[job.index];
    if (!card) return;
    let result;
    try {
      result = await sendPageMessage(tabId, { type: 'CAPTURE_LIGA_CARD', card });
    } catch (error) {
      if (pageLoadError(error)) await schedulePageRetry(job, ligaDetailUrl(card), error);
      else await setStatus('paused', `A página não respondeu ao coletor: ${error.message}`);
      return;
    }
    if (!result?.ok) {
      if (result?.reason === 'challenge_or_interstitial') {
        await setStatus('paused', 'A Liga/Cloudflare apresentou uma verificação. Parei a coleta; resolva-a manualmente e retome depois.');
        return;
      }
      const details = result?.reason === 'unparsed_rows'
        ? ` (${result.issues?.length || 0} linhas com dados incompletos; faltando: ${(result.issues?.[0]?.missing || []).join(', ') || 'campo não identificado'})`
        : '';
      await setStatus('paused', `Coleta pausada em ${card.cardId}: ${result?.reason || 'erro sem detalhe'}${details}`);
      return;
    }
    await writeRecord('cards', {
      cardId: card.cardId,
      captured: true,
      pendingCheckpoint: 'pending',
      capturedAt: result.observedAt,
      rowCount: result.rowCount,
      unpricedRowCount: result.unpricedRowCount || 0,
      unparsedRowCount: result.unparsedRowCount || 0,
      unparsedRows: result.unparsedRows || [],
      offers: result.offers,
    });
    job = await getJob();
    if (!job || job.status !== 'running' || job.index >= job.queue.cards.length) return;
    job.index += 1;
    job.pendingRemoteCount = Number(job.pendingRemoteCount || 0) + 1;
    job.inFlight = false;
    job.retryCount = 0;
    job.reason = '';
    if (job.index >= job.queue.cards.length) job.status = 'complete';
    await saveJob(job);
    if (job.status === 'running') {
      // pendingRemoteCount is updated with this capture and reconciled from
      // IndexedDB when resuming after a worker restart. Avoid getAll() here:
      // scanning an ever-growing card store after every page made long queues
      // progressively slower even though the 100-card checkpoint is enough.
      const pending = Number(job.pendingRemoteCount || 0);
      if (pending >= CHECKPOINT_SIZE) {
        try {
          await syncPriceCheckpoint(job, false);
        } catch (error) {
          await setStatus('paused', `Checkpoint de ${pending} cartas não foi salvo no GitHub. As capturas locais foram preservadas; retome para tentar novamente. ${error.message}`);
          return;
        }
      }
      await scheduleNextPage();
    } else if (job.status === 'complete') {
      void syncCompletedSearch(job);
    }
  } finally {
    captureLock = false;
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') void captureLoadedPage(tabId);
});

chrome.webNavigation.onErrorOccurred.addListener(details => {
  if (details.frameId !== 0 || details.error === 'net::ERR_ABORTED') return;
  void (async () => {
    const job = await getJob();
    if (job?.status === 'running' && job.tabId === details.tabId) {
      await schedulePageRetry(job, details.url, new Error(details.error || 'Falha de navegação.'));
    }
  })();
});

// Observe only top-level Liga responses. Honor an explicit Retry-After for
// HTTP 429; stop on access denial or Cloudflare challenges rather than retrying.
chrome.webRequest.onHeadersReceived.addListener(details => {
  if (details.frameId !== 0 || details.type !== 'main_frame') return;
  const headers = details.responseHeaders || [];
  const cloudflareChallenge = headers.some(header =>
    header.name?.toLowerCase() === 'cf-mitigated' && header.value?.toLowerCase() === 'challenge');
  if (!cloudflareChallenge && details.statusCode !== 403 && details.statusCode !== 429) return;
  void (async () => {
    const job = await getJob();
    if (!job || job.status !== 'running' || job.tabId !== details.tabId) return;
    if (cloudflareChallenge || details.statusCode === 403) {
      await setStatus('paused', 'A Liga/Cloudflare apresentou um desafio ou negou o acesso. Parei sem tentar contornar; retome só depois que o acesso normal voltar.');
      return;
    }
    const retryAfter = retryAfterDelay(headers);
    if (retryAfter == null) {
      await setStatus('paused', 'A Liga respondeu HTTP 429 sem informar Retry-After. Pausei a coleta para proteger este IP; não vou insistir automaticamente.');
      return;
    }
    await schedulePageRetry(job, details.url, new Error(`HTTP 429; Retry-After ${retryWaitLabel(retryAfter)}.`), retryAfter);
  })();
}, { urls: ['https://www.ligapokemon.com.br/*', 'https://ligapokemon.com.br/*'], types: ['main_frame'] }, ['responseHeaders']);

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === PAGE_RETRY_ALARM) void retryFailedPage();
  if (alarm.name === PERIODIC_CHECKPOINT_ALARM) void flushPeriodicCheckpoint();
  if (alarm.name === NEXT_PAGE_ALARM) {
    void (async () => {
      const job = await getJob();
      if (job?.status === 'running' && !job.inFlight && !job.retryAt) await navigateToCurrent(job);
    })();
  }
});

async function restoreScheduledWork() {
  const job = await getJob();
  if (!job || job.status !== 'running') return;
  await schedulePeriodicCheckpoint(job);
  if (job.mode === 'card-prices' && job.inFlight) {
    const currentCard = job.queue?.cards?.[job.index];
    const savedCapture = currentCard ? await readRecord('cards', String(currentCard.cardId)) : null;
    if (savedCapture?.captured === true && Array.isArray(savedCapture.offers)) {
      job.index = Math.min(job.index + 1, job.queue.cards.length);
      job.reason = `Retomando após reinício; captura local de ${currentCard.cardId} preservada.`;
    } else {
      job.reason = 'Retomando a página atual após reinício da extensão.';
    }
    job.inFlight = false;
    job.pendingRemoteCount = (await pendingCardCaptures()).length;
    await saveJob(job);
  }
  if (job.mode === 'card-prices' && !Number.isInteger(job.pendingRemoteCount)) {
    job.pendingRemoteCount = (await pendingCardCaptures()).length;
    await saveJob(job);
  }
  if (job.retryAt) {
    await chrome.alarms.create(PAGE_RETRY_ALARM, { when: Math.max(Date.now(), job.retryAt) });
  } else if (!job.inFlight) {
    if (job.mode === 'card-prices') {
      const pending = (await pendingCardCaptures()).length;
      if (pending >= CHECKPOINT_SIZE) {
        try { await syncPriceCheckpoint(job, false); }
        catch (error) {
          await setStatus('paused', `Checkpoint de ${pending} cartas não foi salvo no GitHub. As capturas locais foram preservadas; retome para tentar novamente. ${error.message}`);
          return;
        }
      }
    }
    await scheduleNextPage();
  }
}

chrome.runtime.onInstalled.addListener(() => void restoreScheduledWork());
chrome.runtime.onStartup.addListener(() => void restoreScheduledWork());

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === 'SET_OWNED_PRIORITY') {
      if (!Array.isArray(message.cardIds) || message.cardIds.length > 100_000) {
        throw new Error('A lista de cartas do backup é inválida.');
      }
      const cardIds = [...new Set(message.cardIds.map(value => String(value || '').trim())
        .filter(value => value && value.length <= 100))];
      if (!cardIds.length) throw new Error('Não encontrei cartas possuídas no backup.');
      const priorityIds = new Set(cardIds);
      await writeRecord('state', { key: 'owned-priority', cardIds });

      let job = await getJob();
      const wasRunning = job?.mode === 'card-prices' && job.status === 'running';
      if (wasRunning) await setStatus('paused', 'Coleta pausada para priorizar as cartas da sua coleção.');
      job = await getJob();
      let messageText = `Lista privada salva neste computador: ${cardIds.length} cartas suas.`;
      if (job?.mode === 'card-prices' && Array.isArray(job.queue?.cards)) {
        const completedIds = new Set(job.queue.cards.slice(0, Math.max(0, job.index || 0))
          .map(card => String(card.cardId)));
        for (const record of await allRecords('cards')) {
          if (record?.checkpointed || record?.remoteCheckpoint
            || (Number.isFinite(Date.parse(String(record?.capturedAt || ''))) && Array.isArray(record?.offers))) {
            completedIds.add(String(record.cardId));
          }
        }
        job.queue = prioritizeQueue(job.queue, priorityIds, completedIds);
        job.index = job.queue.cards.reduce((count, card) => count + (completedIds.has(String(card.cardId)) ? 1 : 0), 0);
        const matched = job.queue.cards.filter(card => priorityIds.has(String(card.cardId))).length;
        const pendingOwned = job.queue.cards.slice(job.index).filter(card => priorityIds.has(String(card.cardId))).length;
        job.reason = `Prioridade aplicada: ${pendingOwned} cartas suas pendentes vêm primeiro.`;
        await saveJob(job);
        messageText = `Prioridade aplicada: ${pendingOwned} cartas suas ainda pendentes vêm primeiro; ${matched} das ${cardIds.length} cartas do backup estão na fila.${wasRunning ? ' A coleta foi pausada para reorganizar; toque em Iniciar / continuar.' : ''}`;
      } else if (wasRunning) {
        messageText += ' A coleta foi pausada; retome em Iniciar / continuar.';
      }
      sendResponse({ ok: true, message: messageText });
      return;
    }
    if (message?.type === 'IMPORT_QUEUE') {
      let queue = message.queue;
      const currentJob = await getJob();
      if (currentJob?.mode === 'edition-discovery' && currentJob.status === 'running') {
        throw new Error('A descoberta das versões ainda está em andamento. Aguarde terminar e exporte o snapshot antes de carregar a fila de preços.');
      }
      if (queue?.source !== 'ligapokemon-version-map') {
        throw new Error('Este arquivo de fila é antigo ou incompatível. A fila correta só pode ser gerada depois de exportar e integrar o índice completo de versões da Liga.');
      }
      if (queue?.schemaVersion !== 1
        || !Array.isArray(queue.cards) || !Array.isArray(queue.excluded)
        || !/^[a-f0-9]{64}$/i.test(String(queue.catalogHash || ''))
        || queue.cards.length + queue.excluded.length !== Number(queue.catalogCardCount)) {
        throw new Error('Fila inválida ou incompleta; nada foi carregado.');
      }
      queue = prioritizeQueue(queue, await getOwnedPriorityIds());
      const job = {
        mode: 'card-prices', queue, queueId: currentQueueId(queue), status: 'ready', index: 0, tabId: null,
        inFlight: false, reason: '', remoteCapturedCount: 0, pendingRemoteCount: 0,
        importedAt: new Date().toISOString(), retryCount: 0,
      };
      await replaceCollectionData(job);
      sendResponse({ ok: true, total: queue.cards.length, excluded: queue.excluded.length });
      return;
    }
    if (message?.type === 'RESUME_REMOTE' || message?.type === 'RESTART_REMOTE') {
      let remote = await getRemoteResume();
      const restarting = message.type === 'RESTART_REMOTE';
      if (restarting) {
        remote = await postSnapshot(new URL('/sync/restart', RESUME_SYNC_URL), {
          expectedQueueId: currentQueueId(remote.queue),
        });
      }
      if (remote.progress?.complete) {
        sendResponse({ ok: true, message: `A coleta desta fila já está completa (${remote.progress.capturedCount}/${remote.queue.cards.length}).` });
        return;
      }
      const previous = await getJob();
      const backgroundTabId = await createBackgroundTab();
      await installAndStartQueue(remote.queue, backgroundTabId, remote.progress);
      await closeOldScannerTab(previous?.tabId, backgroundTabId, message.tabId);
      const latest = await getJob();
      sendResponse({ ok: true, message: latest.status === 'complete'
        ? `Fila restaurada: ${latest.queue.cards.length} cartas já salvas; confirmando a publicação final.`
        : restarting ? `Nova rodada iniciada em 0/${latest.queue.cards.length} cartas salvas.`
          : `Fila restaurada do GitHub; retomando em ${latest.index + 1}/${latest.queue.cards.length}, com ${latest.remoteCapturedCount || 0} cartas já salvas remotamente.` });
      return;
    }
    if (message?.type === 'START_EDITION_DISCOVERY') {
      const existingJob = await getJob();
      if (existingJob?.mode === 'edition-discovery') {
        if (existingJob.status === 'running') {
          sendResponse({ ok: true, message: `A descoberta já está em andamento: ${existingJob.index}/${existingJob.editions.length} edições.` });
          return;
        }
        if (existingJob.status === 'paused' && existingJob.index < existingJob.editions.length) {
          const oldTabId = existingJob.tabId;
          const backgroundTabId = await createBackgroundTab();
          existingJob.status = 'running';
          existingJob.tabId = backgroundTabId;
          existingJob.inFlight = false;
          existingJob.reason = '';
          existingJob.retryCount = 0;
          existingJob.retryAt = 0;
          existingJob.retryUrl = '';
          await chrome.alarms.clear(PAGE_RETRY_ALARM);
          await chrome.alarms.clear(NEXT_PAGE_ALARM);
          await saveJob(existingJob);
          await navigateToCurrent(existingJob);
          await closeOldScannerTab(oldTabId, backgroundTabId, message.tabId);
          await chrome.action.setBadgeText({ text: '' });
          sendResponse({ ok: true, message: `Descoberta retomada em segundo plano em ${existingJob.index + 1}/${existingJob.editions.length}; capturas anteriores preservadas.` });
          return;
        }
        if (existingJob.status === 'complete') {
          throw new Error('A descoberta já está completa. Exporte o snapshot antes de iniciar outra coleta.');
        }
      }
      if (existingJob?.queue?.cards?.length) {
        throw new Error('Existe uma fila de preços carregada. Exporte o snapshot antes de iniciar a descoberta de edições.');
      }
      const backgroundTabId = await createBackgroundTab();
      const job = {
        mode: 'edition-index', status: 'running', index: 0,
        tabId: backgroundTabId, inFlight: true, reason: '', startedAt: new Date().toISOString(),
      };
      await saveJob(job);
      await chrome.tabs.update(backgroundTabId, { url: EDITIONS_URL });
      await chrome.action.setBadgeText({ text: '' });
      sendResponse({ ok: true, message: 'Abrindo Edições da Liga em segundo plano; capturas anteriores serão preservadas.' });
      return;
    }
    if (message?.type === 'START') {
      const job = await getJob();
      if (!job?.queue?.cards?.length) throw new Error('Carregue primeiro a fila gerada pelo POKECARD.');
      const tab = await chrome.tabs.get(message.tabId);
      if (!/^https:\/\/(www\.)?ligapokemon\.com\.br\//i.test(tab.url || '')) {
        throw new Error('A aba ativa precisa estar aberta em ligapokemon.com.br.');
      }
      job.queueId = job.queueId || currentQueueId(job.queue);
      try {
        const remote = await getRemoteResume();
        await mergeRemoteProgress(job, remote.progress);
      } catch {}
      const localCaptures = (await pendingCardCaptures()).length;
      job.pendingRemoteCount = localCaptures;
      if (localCaptures >= CHECKPOINT_SIZE) {
        const checkpoint = await syncPriceCheckpoint(job, false);
        job.remoteCapturedCount = checkpoint.capturedCount;
        job.pendingRemoteCount = 0;
      }
      const oldTabId = job.tabId;
      job.tabId = await createBackgroundTab();
      job.status = 'running';
      job.reason = '';
      job.inFlight = false;
      job.retryCount = 0;
      job.retryAt = 0;
      job.retryUrl = '';
      await chrome.alarms.clear(PAGE_RETRY_ALARM);
      await chrome.alarms.clear(NEXT_PAGE_ALARM);
      await saveJob(job);
      await schedulePeriodicCheckpoint(job);
      await navigateToCurrent(job);
      await closeOldScannerTab(oldTabId, job.tabId, message.tabId);
      await chrome.action.setBadgeText({ text: '' });
      sendResponse({ ok: true, message: `Coleta iniciada em segundo plano em ${job.index + 1}/${job.queue.cards.length}. Uma página por vez.` });
      return;
    }
    if (message?.type === 'PAUSE') {
      const job = await setStatus('paused', 'Pausado pelo usuário.');
      const total = job?.mode === 'edition-discovery' ? job.editions.length : job?.queue?.cards?.length;
      sendResponse({ ok: true, message: job ? `Pausado em ${job.index}/${total ?? 'preparação'}.` : 'Nenhuma fila carregada.' });
      return;
    }
    if (message?.type === 'STATUS') {
      const job = await getJob();
      const total = job?.mode === 'edition-discovery' ? job.editions.length : job?.queue?.cards.length;
      const label = job?.mode === 'edition-index' ? 'preparando índice de edições' : job?.mode === 'edition-discovery' ? 'edições da Liga' : 'cartas';
      const checkpointAlarm = job?.mode === 'card-prices' && job.status === 'running'
        ? await chrome.alarms.get(PERIODIC_CHECKPOINT_ALARM) : null;
      const githubMessage = job?.mode === 'card-prices'
        ? `No GitHub: ${Number(job.remoteCapturedCount || 0)}/${Number(total || 0)} cartas verificadas · ${Number(job.pendingRemoteCount || 0)} aguardando envio.`
        : '';
      sendResponse({ ok: true, githubMessage, nextCheckpointAt: checkpointAlarm?.scheduledTime || null, message: job
        ? job.mode === 'edition-index'
          ? `${job.status}: ${label}. ${job.reason || ''}`.trim()
          : `${job.status}: ${job.index}/${total} ${label}. ${job.reason || ''}`.trim()
        : 'Aguardando uma fila ou a descoberta das edições.' });
      return;
    }
    if (message?.type === 'EXPORT_SNAPSHOT') {
      const job = await getJob();
      if (!job) throw new Error('Nenhuma fila carregada.');
      if (job.mode === 'edition-discovery') {
        const snapshot = await editionIndexSnapshot(job);
        const editions = await allRecords('editions');
        const complete = snapshot.coverage.complete;
        sendResponse({ ok: true, snapshot, captured: editions.length, total: job.editions.length, complete });
        return;
      }
      const snapshot = await capturePriceSnapshot(job);
      const captures = await allRecords('cards');
      const complete = snapshot.coverage.complete;
      sendResponse({ ok: true, snapshot, captured: captures.length, total: job.queue.catalogCardCount, complete });
      return;
    }
    if (message?.type === 'SYNC_COMPLETE') {
      const job = await getJob();
      if (!job?.queue?.cards?.length) {
        if (job?.mode === 'edition-discovery' && job.status === 'complete') {
          await syncCompletedSearch(job);
          const latest = await getJob();
          sendResponse({ ok: true, message: latest?.reason || 'Índice enviado; fila de preços preparada.' });
          return;
        }
        throw new Error('Nenhuma fila de preços está carregada.');
      }
      if (job.status === 'complete') {
        await syncCompletedSearch(job);
        const latest = await getJob();
        sendResponse({ ok: true, message: latest?.reason || 'Busca final enviada ao pokemon-price-database.' });
        return;
      }
      const result = await syncPriceCheckpoint(job, false);
      const latest = await getJob();
      const stateMessage = latest?.status === 'running' ? 'A coleta continua.'
        : latest?.status === 'paused' ? 'A coleta permanece pausada.'
          : latest?.status === 'ready' ? 'A fila continua pronta para iniciar.' : '';
      sendResponse({ ok: true, message: `${result.message || 'Checkpoint sincronizado.'}${stateMessage ? ` ${stateMessage}` : ''}` });
      return;
    }
    sendResponse({ ok: false, error: 'Ação desconhecida.' });
  })().catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});
