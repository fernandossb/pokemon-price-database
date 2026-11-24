const $ = id => document.getElementById(id);
const status = $('status');
const githubCount = $('githubCount');
const checkpointTimer = $('checkpointTimer');
let nextCheckpointAt = null;

function renderCheckpointTimer() {
  if (!nextCheckpointAt) {
    checkpointTimer.value = 'Próximo checkpoint: sem envio agendado.';
    return;
  }
  const remainingSeconds = Math.max(0, Math.ceil((nextCheckpointAt - Date.now()) / 1000));
  const minutes = String(Math.floor(remainingSeconds / 60)).padStart(2, '0');
  const seconds = String(remainingSeconds % 60).padStart(2, '0');
  checkpointTimer.value = remainingSeconds === 0
    ? 'Próximo checkpoint: envio em andamento…'
    : `Próximo checkpoint automático em ${minutes}:${seconds}`;
}

async function refreshStatus() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'STATUS' });
    if (!result?.ok) return;
    if (result.message) status.value = result.message;
    githubCount.value = result.githubMessage || 'No GitHub: aguardando fila.';
    nextCheckpointAt = Number.isFinite(result.nextCheckpointAt) ? result.nextCheckpointAt : null;
    renderCheckpointTimer();
  } catch {}
}

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'Falha no coletor.');
  return response;
}

function ownedCardIdsFromBackup(backup) {
  if (backup?.format !== 'fichario-pokemon-br-plus-backup'
    || !backup.state?.entries || typeof backup.state.entries !== 'object'
    || Array.isArray(backup.state.entries)) {
    throw new Error('Este arquivo não parece ser um backup válido do POKECARD.');
  }
  const ids = [];
  for (const [cardId, entry] of Object.entries(backup.state.entries)) {
    const variants = Array.isArray(entry?.variants) ? entry.variants : [];
    const quantity = variants.length
      ? variants.reduce((total, item) => total + Math.max(0, Number(item?.quantity) || 0), 0)
      : Math.max(0, Number(entry?.quantity) || 0);
    if (quantity > 0) ids.push(cardId);
  }
  if (!ids.length) throw new Error('O backup não contém cartas marcadas como “Tenho”.');
  return ids;
}

$('setPriority').addEventListener('click', async () => {
  const output = $('priorityStatus');
  try {
    const file = $('collectionBackup').files?.[0];
    if (!file) throw new Error('Selecione o backup atual do POKECARD.');
    output.value = 'Lendo a coleção localmente…';
    const backup = JSON.parse(await file.text());
    const cardIds = ownedCardIdsFromBackup(backup);
    const result = await send({ type: 'SET_OWNED_PRIORITY', cardIds });
    output.value = result.message;
  } catch (error) { output.value = error.message; }
});

$('resumeRemote').addEventListener('click', async () => {
  try {
    status.value = 'Buscando fila e checkpoint salvos no GitHub…';
    status.value = (await send({ type: 'RESUME_REMOTE' })).message;
  } catch (error) { status.value = error.message; }
});

$('restartRemote').addEventListener('click', async event => {
  if (!confirm('Começar uma nova rodada do zero no GitHub? Todos os computadores passarão a usar a nova fila.')) return;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    status.value = 'Publicando uma nova fila…';
    status.value = (await send({ type: 'RESTART_REMOTE' })).message;
  } catch (error) {
    status.value = error.message;
  } finally {
    button.disabled = false;
  }
});

$('resumeOcr').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https:\/\/(?:www\.)?ligapokemon\.com\.br\//i.test(tab.url || '')) {
      throw new Error('Abra a Liga Pokémon na aba desta janela antes de iniciar.');
    }
    status.value = (await send({ type: 'RESUME_REMOTE', ocrTabId: tab.id })).message;
  } catch (error) { status.value = error.message; }
});

$('discover').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('Abra a página Edições da Liga Pokémon nesta aba.');
    const result = await send({ type: 'START_EDITION_DISCOVERY', tabId: tab.id });
    status.value = result.message;
  } catch (error) { status.value = error.message; }
});

$('import').addEventListener('click', async () => {
  try {
    const file = $('queue').files?.[0];
    if (!file) throw new Error('Selecione work/liga-browser-queue.json.');
    const queue = JSON.parse(await file.text());
    const result = await send({ type: 'IMPORT_QUEUE', queue });
    status.value = `Fila carregada: ${result.total} impressões Liga; ${result.excluded} IDs sem correspondência ficam pendentes.`;
  } catch (error) { status.value = error.message; }
});

$('start').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('Abra a Liga Pokémon nesta aba antes de iniciar.');
    const result = await send({ type: 'START', tabId: tab.id });
    status.value = result.message;
  } catch (error) { status.value = error.message; }
});

$('pause').addEventListener('click', async () => {
  try { status.value = (await send({ type: 'PAUSE' })).message; }
  catch (error) { status.value = error.message; }
});

$('sync').addEventListener('click', async () => {
  try {
    status.value = 'Enviando ao pokemon-price-database…';
    status.value = (await send({ type: 'SYNC_COMPLETE' })).message;
  } catch (error) { status.value = error.message; }
});

$('export').addEventListener('click', async () => {
  try {
    status.value = 'Preparando snapshot local…';
    const result = await send({ type: 'EXPORT_SNAPSHOT' });
    const blob = new Blob([JSON.stringify(result.snapshot)], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    const prefix = result.snapshot.source === 'ligapokemon-browser-edition-index'
      ? 'ligapokemon-edition-index' : 'ligapokemon-browser-capture';
    anchor.download = `${prefix}-${new Date().toISOString().replaceAll(':', '-')}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(href), 30_000);
    const unit = result.snapshot.source === 'ligapokemon-browser-edition-index' ? 'edições descobertas' : 'cartas lidas';
    status.value = `Arquivo exportado: ${result.captured}/${result.total} ${unit}. ${result.complete ? 'Cobertura completa.' : 'Captura parcial.'}`;
  } catch (error) { status.value = error.message; }
});

void refreshStatus();
setInterval(refreshStatus, 15_000);
setInterval(renderCheckpointTimer, 1_000);
