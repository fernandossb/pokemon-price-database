const $ = id => document.getElementById(id);
const status = $('status');

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'Falha no coletor.');
  return response;
}

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

chrome.runtime.sendMessage({ type: 'STATUS' }).then(result => {
  if (result?.ok && result.message) status.value = result.message;
}).catch(() => {});
