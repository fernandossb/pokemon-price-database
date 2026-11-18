const DB_NAME = 'pokecard-liga-browser-collector';
const DB_VERSION = 2;
// Conservative pacing for a long public-site crawl: at most two new pages/minute.
const PAGE_DELAY_MS = 30_000;
const PAGE_RETRY_DELAY_MS = 60_000;
const MAX_PAGE_RETRIES = 6;
const MAX_RETRY_DELAY_MS = 30 * 60_000;
const MAX_RETRY_AFTER_MS = 30 * 24 * 60 * 60_000;
const PAGE_RETRY_ALARM = 'liga-page-retry';
const EDITIONS_URL = 'https://www.ligapokemon.com.br/?view=cards/edicoes';
const EDITION_SYNC_URL = 'http://127.0.0.1:17835/sync/editions';
const PRICE_SYNC_URL = 'http://127.0.0.1:17835/sync/prices';
let captureLock = false;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('state')) db.createObjectStore('state', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('cards')) db.createObjectStore('cards', { keyPath: 'cardId' });
      if (!db.objectStoreNames.contains('editions')) db.createObjectStore('editions', { keyPath: 'editionId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
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

async function allRecords(storeName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

const getJob = () => readRecord('state', 'job');
const saveJob = job => writeRecord('state', { key: 'job', ...job });

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
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snapshot),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok !== true) throw new Error(payload.error || `Servidor local respondeu HTTP ${response.status}.`);
  return payload;
}

async function installAndStartQueue(queue, tabId) {
  if (queue?.source !== 'ligapokemon-version-map'
    || queue?.schemaVersion !== 1
    || !Array.isArray(queue.cards) || !Array.isArray(queue.excluded)
    || !/^[a-f0-9]{64}$/i.test(String(queue.catalogHash || ''))
    || queue.cards.length + queue.excluded.length !== Number(queue.catalogCardCount)) {
    throw new Error('O Price Database devolveu uma fila incompleta ou incompatível.');
  }
  const db = await openDb();
  const job = {
    mode: 'card-prices', queue, status: 'running', index: 0, tabId,
    inFlight: false, retryCount: 0, reason: 'Versões salvas no Price Database; iniciando a leitura de preços.', importedAt: new Date().toISOString(),
  };
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['state', 'cards', 'editions'], 'readwrite');
    tx.objectStore('cards').clear();
    tx.objectStore('editions').clear();
    tx.objectStore('state').put({ key: 'job', ...job });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  await chrome.action.setBadgeText({ text: '' });
  await navigateToCurrent(job);
}

async function syncCompletedSearch(job) {
  if (job?.status !== 'complete') return;
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
      await installAndStartQueue(result.queue, latest.tabId);
      return;
    }
    if (job.queue?.cards?.length) {
      job.syncState = 'uploading';
      job.reason = 'Cartas lidas; salvando os anúncios no pokemon-price-database…';
      await saveJob(job);
      const snapshot = await capturePriceSnapshot(job);
      const result = await postSnapshot(PRICE_SYNC_URL, snapshot);
      const latest = await getJob();
      if (!latest || latest.status !== 'complete') return;
      latest.syncState = 'published';
      latest.reason = result.message || 'Snapshot enviado ao pokemon-price-database; o GitHub atualizará os preços.';
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
    setTimeout(() => void retryFailedPage(), remaining);
    return;
  }
  const url = job.retryUrl || currentPageUrl(job);
  if (!url || !job.tabId) return;
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
  const delay = requestedDelayMs == null ? backoff : Math.max(PAGE_DELAY_MS, requestedDelayMs);
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
  await chrome.alarms.create(PAGE_RETRY_ALARM, { when: job.retryAt });
  setTimeout(() => void retryFailedPage(), delay);
}

async function capturePriceSnapshot(job) {
  if (!job?.queue?.cards?.length) throw new Error('Fila de preços ausente.');
  const captures = await allRecords('cards');
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
      capturedCardCount: captures.length,
      complete: job.status === 'complete' && job.index === job.queue.cards.length
        && captures.length === job.queue.cards.length
        && job.queue.excluded.every(item => ['digital_only_tcg_pocket', 'liga_print_unmatched', 'multiple_liga_prints_for_card_id'].includes(item.reason)),
    },
    excluded: job.queue.excluded,
    cards: job.queue.cards.map(card => {
      const result = captureById.get(card.cardId);
      return { ...card, captured: capturedIds.has(card.cardId), ...(result || {}) };
    }),
  };
}

async function publishPriceSnapshot(job) {
  const snapshot = await capturePriceSnapshot(job);
  if (!snapshot.coverage.complete) throw new Error('A coleta não terminou; snapshot não enviado.');
  const response = await fetch(PRICE_SYNC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(snapshot),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok !== true) throw new Error(payload.error || `Servidor local respondeu HTTP ${response.status}.`);
  return payload;
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
        setTimeout(async () => {
          const next = await getJob();
          if (next?.status === 'running' && !next.inFlight) await navigateToCurrent(next);
        }, PAGE_DELAY_MS);
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
        setTimeout(async () => {
          const next = await getJob();
          if (next?.status === 'running' && !next.inFlight) await navigateToCurrent(next);
        }, PAGE_DELAY_MS);
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
      capturedAt: result.observedAt,
      rowCount: result.rowCount,
      unpricedRowCount: result.unpricedRowCount || 0,
      offers: result.offers,
    });
    job = await getJob();
    if (!job || job.status !== 'running' || job.index >= job.queue.cards.length) return;
    job.index += 1;
    job.inFlight = false;
    job.retryCount = 0;
    job.reason = '';
    if (job.index >= job.queue.cards.length) job.status = 'complete';
    await saveJob(job);
    if (job.status === 'running') {
      setTimeout(async () => {
        const next = await getJob();
        if (next?.status === 'running' && !next.inFlight) await navigateToCurrent(next);
      }, PAGE_DELAY_MS);
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
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === 'IMPORT_QUEUE') {
      const queue = message.queue;
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
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['state', 'cards', 'editions'], 'readwrite');
        tx.objectStore('cards').clear();
        tx.objectStore('editions').clear();
        tx.objectStore('state').put({
          key: 'job', queue, status: 'ready', index: 0, tabId: null,
          inFlight: false, reason: '', importedAt: new Date().toISOString(),
          retryCount: 0,
        });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      sendResponse({ ok: true, total: queue.cards.length, excluded: queue.excluded.length });
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
      const oldTabId = job.tabId;
      job.tabId = await createBackgroundTab();
      job.status = 'running';
      job.reason = '';
      job.inFlight = false;
      job.retryCount = 0;
      job.retryAt = 0;
      job.retryUrl = '';
      await chrome.alarms.clear(PAGE_RETRY_ALARM);
      await saveJob(job);
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
      sendResponse({ ok: true, message: job
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
      if (!job || job.status !== 'complete') throw new Error('A busca ainda não terminou; o envio automático ocorre ao completar.');
      await syncCompletedSearch(job);
      const latest = await getJob();
      sendResponse({ ok: true, message: latest?.reason || 'Sincronização enviada.' });
      return;
    }
    sendResponse({ ok: false, error: 'Ação desconhecida.' });
  })().catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});
