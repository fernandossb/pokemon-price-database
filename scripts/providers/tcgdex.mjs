const API = 'https://api.tcgdex.net/v2';

async function fetchJson(url, retries = 5) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': 'FicharioPokemonPriceBot/0.1' } });
      if (!response.ok) {
        const error = new Error(`${response.status} ${response.statusText}`);
        if ((response.status === 429 || response.status >= 500) && attempt < retries) {
          const retryAfter = Number(response.headers.get('retry-after'));
          const delay = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(30_000, retryAfter * 1000)
            : Math.min(20_000, 1500 * 2 ** (attempt - 1));
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise(resolve => setTimeout(resolve, Math.min(20_000, 1500 * 2 ** (attempt - 1))));
    }
  }
  throw lastError;
}

export async function listCards(language) {
  return fetchJson(`${API}/${language}/cards`);
}

const setInfoCache = new Map();

export async function getSetInfo(language, setId) {
  const key = `${language}::${setId}`;
  if (!setInfoCache.has(key)) {
    const pending = fetchJson(`${API}/${language}/sets/${encodeURIComponent(setId)}`).then(set => ({
      id: set.id,
      name: set.name,
      abbreviation: set.abbreviation || null,
      releaseDate: set.releaseDate || null,
      cardCount: set.cardCount || null,
    }));
    setInfoCache.set(key, pending);
  }
  return setInfoCache.get(key);
}

export async function getCard(language, id) {
  const card = await fetchJson(`${API}/${language}/cards/${encodeURIComponent(id)}`);
  if (card?.set?.id && !card.set.abbreviation?.official) {
    const setInfo = await getSetInfo(language, card.set.id);
    card.set = { ...setInfo, ...card.set, abbreviation: setInfo.abbreviation };
  }
  return card;
}
