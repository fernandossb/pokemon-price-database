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

export async function loadBrazilianPrices(path = 'data/br-prices.csv') {
  const text = await fs.readFile(path, 'utf8');
  const lines = text.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'));
  const [header, ...rows] = lines.map(parseCsvLine);
  const index = Object.fromEntries(header.map((name, i) => [name, i]));
  const map = new Map();
  for (const row of rows) {
    const cardId = row[index.card_id];
    const finish = row[index.finish] || 'normal';
    const price = Number(String(row[index.price_brl]).replace(',', '.'));
    if (!cardId || !Number.isFinite(price) || price <= 0) continue;
    const key = `${cardId}::${finish}`;
    const item = {
      source: row[index.source] || 'br-manual',
      priceBrl: price,
      url: row[index.url] || null,
      observedAt: row[index.observed_at] || null
    };
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}
