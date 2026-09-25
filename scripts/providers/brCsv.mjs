import fs from 'node:fs/promises';

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { result.push(current.trim()); current = ''; }
    else current += ch;
  }
  result.push(current.trim());
  return result;
}

/**
 * Preços conferidos manualmente — uma pessoa olhando a Liga Pokémon como
 * qualquer cliente, sem automação — para cartas cadastradas no app. Chave
 * exata: cardId::language::finish::condition. `condition` vazio vira
 * "mercado" (mesmo sentido do preço internacional: sem condição específica).
 * Arquivo ausente ou ilegível não deve derrubar o pipeline: retorna vazio.
 */
export async function loadBrazilianPrices(path = 'data/br-prices.csv') {
  let text;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch {
    return new Map();
  }

  const lines = text.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'));
  if (!lines.length) return new Map();
  const [header, ...rows] = lines.map(parseCsvLine);
  const index = Object.fromEntries(header.map((name, i) => [name, i]));
  const map = new Map();
  for (const row of rows) {
    const cardId = row[index.card_id];
    const language = row[index.language];
    const finish = row[index.finish];
    const condition = row[index.condition] || 'mercado';
    const price = Number(String(row[index.price_brl]).replace(',', '.'));
    if (!cardId || !language || !finish || !Number.isFinite(price) || price <= 0) continue;
    const key = `${cardId}::${language}::${finish}::${condition}`;
    const item = {
      source: row[index.source] || 'br-manual',
      priceBrl: price,
      url: row[index.url] || null,
      observedAt: row[index.observed_at] || null,
    };
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}
