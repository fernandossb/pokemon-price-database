const API = 'https://api.tcgdex.net/v2';

async function fetchJson(url, retries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': 'FicharioPokemonPriceBot/0.1' } });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }
  throw lastError;
}

export async function listCards(language) {
  return fetchJson(`${API}/${language}/cards`);
}

export async function getCard(language, id) {
  return fetchJson(`${API}/${language}/cards/${encodeURIComponent(id)}`);
}
