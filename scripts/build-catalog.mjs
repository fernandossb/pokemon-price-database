import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { getSetInfo, listCards } from './providers/tcgdex.mjs';
import { config, nowIso, readJson } from './lib.mjs';

// Mapping-only bridge from existing TCGdex IDs to known Liga code variants.
// It never supplies the edition name, card number, URL, or prices.
const ligaCodeHints = new Map([
  ['basep', 'WPR'], ['bog', 'BG'], ['dpp', 'DPPR'], ['hgssp', 'HSPR'],
  ['neo1', 'N1'], ['neo2', 'N2'], ['neo3', 'N3'], ['neo4', 'N4'],
  ['np', 'NBSP'], ['sma', 'HIF'], ['swshp', 'SSPR'],
]);

await fs.mkdir('work', { recursive: true });
const cardsById = new Map();
for (const language of config.languages) {
  const cards = await listCards(language);
  console.log(`${language}: ${cards.length} registros`);
  for (const card of cards) {
    const current = cardsById.get(card.id);
    const separator = String(card.id).lastIndexOf('-');
    const setId = separator > 0 ? String(card.id).slice(0, separator) : '';
    if (!current) cardsById.set(card.id, {
      id: card.id,
      localId: card.localId,
      name: card.name || '',
      namesByLanguage: { [language]: card.name || '' },
      setId,
      availableLanguages: [language],
    });
    else {
      if (!current.name && card.name) current.name = card.name;
      current.namesByLanguage ||= {};
      current.namesByLanguage[language] = card.name || '';
      if (!current.setId && setId) current.setId = setId;
      if (!current.availableLanguages.includes(language)) current.availableLanguages.push(language);
    }
  }
}
const cards = [...cardsById.values()].sort((a, b) => a.id.localeCompare(b.id));
const setIds = [...new Set(cards.map(card => card.setId).filter(Boolean))].sort();
const setInfoById = new Map();
const representativeBySet = new Map();
for (const card of cards) if (!representativeBySet.has(card.setId)) representativeBySet.set(card.setId, card);
let nextSetIndex = 0;
let enrichedSetCount = 0;
const setWorker = async () => {
  while (true) {
    const index = nextSetIndex++;
    if (index >= setIds.length) return;
    const setId = setIds[index];
    const card = representativeBySet.get(setId);
    let setInfo = null;
    const languages = [...new Set([...(card?.availableLanguages || []), ...config.languages])];
    for (const language of languages) {
      try {
        setInfo = await getSetInfo(language, setId);
        if (setInfo?.id) break;
      } catch {}
    }
    if (!setInfo?.id || !Number.isFinite(Number(setInfo?.cardCount?.official))) {
      throw new Error(`TCGdex não forneceu identidade/total para a coleção ${setId}; catálogo de coleta não foi gerado.`);
    }
    setInfoById.set(setId, setInfo);
    enrichedSetCount += 1;
    if (enrichedSetCount % 25 === 0 || enrichedSetCount === setIds.length) {
      console.log(`Coleções enriquecidas: ${enrichedSetCount}/${setIds.length}`);
    }
  }
};
await Promise.all(Array.from({ length: 4 }, () => setWorker()));
for (const card of cards) {
  const setInfo = setInfoById.get(card.setId);
  card.tcgdexSetName = setInfo.name;
  card.tcgdexSetCodeHint = String(setInfo.abbreviation?.official || '').trim();
  card.tcgdexLigaCodeHint = ligaCodeHints.get(card.setId) || '';
  card.setName = setInfo.name;
  const pocketSet = /^(?:A|B)\d+[a-z]?$/i.test(card.setId);
  card.edition = null;
  card.editionSource = null;
  card.marketplaceEligible = false;
  card.marketplaceExclusionReason = pocketSet ? 'digital_only_tcg_pocket' : 'liga_print_unmatched';
  card.setTotal = setInfo.cardCount.official;
}
const ligaMap = await readJson('work/liga-version-map.json', null);
if (ligaMap) {
  const idHash = createHash('sha256').update(cards.map(card => card.id).join('\n')).digest('hex');
  if (ligaMap.cardIdHash !== idHash || !Array.isArray(ligaMap.matches)) {
    throw new Error('Mapeamento da Liga não corresponde aos IDs atuais; catálogo não gerado.');
  }
  const byId = new Map(ligaMap.matches.map(item => [item.cardId, item]));
  for (const card of cards) {
    const match = byId.get(card.id);
    if (!match || !match.editionCode || !match.number || !match.detailUrl) continue;
    card.setName = match.editionName;
    card.ligaName = match.ligaName;
    card.ligaEditionId = match.editionId;
    card.edition = match.editionCode;
    card.editionSource = 'ligapokemon-browser';
    card.localId = String(match.number);
    card.setTotal = match.setTotal || null;
    card.detailUrl = match.detailUrl;
    card.marketplaceEligible = true;
    card.marketplaceExclusionReason = null;
  }
}
const hash = createHash('sha256').update(cards.map(card => `${card.id}::${card.edition || ''}::${card.localId || ''}`).join('\n')).digest('hex');
const catalog = { generatedAt: nowIso(), hash, languages: config.languages, setCount: setIds.length, count: cards.length, cards };
await fs.writeFile('work/catalog.json', JSON.stringify(catalog));
console.log(`Catálogo consolidado: ${cards.length} cartas | hash ${hash.slice(0, 12)}`);
