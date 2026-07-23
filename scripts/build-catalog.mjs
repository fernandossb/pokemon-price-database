import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { listCards } from './providers/tcgdex.mjs';
import { config, nowIso } from './lib.mjs';

await fs.mkdir('work', { recursive: true });
const cardsById = new Map();
for (const language of config.languages) {
  const cards = await listCards(language);
  console.log(`${language}: ${cards.length} registros`);
  for (const card of cards) {
    const current = cardsById.get(card.id);
    if (!current) cardsById.set(card.id, { ...card, availableLanguages: [language] });
    else if (!current.availableLanguages.includes(language)) current.availableLanguages.push(language);
  }
}
const cards = [...cardsById.values()].sort((a, b) => a.id.localeCompare(b.id));
const hash = createHash('sha256').update(cards.map(card => card.id).join('\n')).digest('hex');
const catalog = { generatedAt: nowIso(), hash, languages: config.languages, count: cards.length, cards };
await fs.writeFile('work/catalog.json', JSON.stringify(catalog));
console.log(`Catálogo consolidado: ${cards.length} cartas | hash ${hash.slice(0, 12)}`);
