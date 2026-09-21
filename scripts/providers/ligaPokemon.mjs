const LIGA_AJAX = 'https://www.ligapokemon.com.br/ajax/cards/main.php';
const HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'X-Requested-With': 'XMLHttpRequest',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'pt-BR,pt;q=0.9',
};

function parsePrice(raw) {
  const match = String(raw ?? '').trim().match(/[\d.,]+/);
  if (!match) return null;
  const value = Number.parseFloat(match[0].replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeNum(value) {
  return String(value).replace(/^0+(\d)/, '$1');
}

// O resultado de busca da Liga é uma lista de cartas em HTML; cada bloco traz
// "nome (num/total)" seguido dos três preços do mercado (menor/médio/maior).
// Não há como saber pelo texto se a linha é normal ou holo — por isso quem
// chama isto só aplica o preço quando a carta tem uma única variante possível.
const CARD_BLOCK_RE = /card=[^&"]+\(([^)]+)\)[^"]*"[\s\S]*?price-min">([^<]*)[\s\S]*?price-avg">([^<]*)[\s\S]*?price-max">([^<]*)/g;

function parseSearchHtml(html) {
  const cards = [];
  CARD_BLOCK_RE.lastIndex = 0;
  let match;
  while ((match = CARD_BLOCK_RE.exec(html)) !== null) {
    const [num, total] = match[1].split('/');
    if (!num || !total) continue;
    cards.push({
      num: num.trim(),
      total: total.trim(),
      min: parsePrice(match[2]),
      avg: parsePrice(match[3]),
      max: parsePrice(match[4]),
    });
  }
  return cards;
}

async function postSearch(body, attempts, retryDelayMs) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(LIGA_AJAX, { method: 'POST', headers: HEADERS, body: body.toString() });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
    }
  }
  throw lastError;
}

/**
 * Busca o menor/médio/maior preço de uma impressão específica (nome + número
 * do card) no marketplace da Liga Pokémon, via o mesmo endpoint AJAX que a
 * busca do site usa. Best-effort: qualquer falha de rede, resposta inesperada
 * ou ausência de match retorna null — quem chama deve tratar isso como "sem
 * preço nacional desta vez" e cair para as fontes internacionais.
 */
export async function searchCardPrice({ name, num, total }, options = {}) {
  if (!name || !num || !Number.isFinite(Number(total)) || Number(total) <= 0) return null;

  const attempts = options.attempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 500;
  const maxPages = options.maxPages ?? 3;
  const numPad = String(num).padStart(3, '0');
  const search = `${String(name).split(/[\s-]/)[0]} ${numPad}/${total}`;
  const numNorm = normalizeNum(num);

  let key = 'init';
  for (let page = 1; page <= maxPages; page += 1) {
    const body = new URLSearchParams({
      opc: 'nextPage',
      page: String(page),
      totalReg: '0',
      tipo: '1',
      search,
      orderBy: '',
      fav: '0',
      iTCG: '2',
      idPokemon: '0',
      key,
    });

    let json;
    try {
      json = await postSearch(body, attempts, retryDelayMs);
    } catch {
      return null;
    }

    key = json?.key ?? key;
    const cards = parseSearchHtml(json?.html ?? '');
    const found = cards.find(card => normalizeNum(card.num) === numNorm);
    if (found?.min != null) {
      return { min: found.min, avg: found.avg, max: found.max };
    }
    if (!json?.nextPage) break;
  }
  return null;
}
