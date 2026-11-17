import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const input = path.resolve(process.argv[2] || 'data/ligapokemon-edition-index.json');
const catalogPath = path.resolve('work/catalog.json');
const output = path.resolve('work/liga-version-map.json');
const snapshot = JSON.parse(await fs.readFile(input, 'utf8'));
const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
if (snapshot?.schemaVersion !== 1 || snapshot?.source !== 'ligapokemon-browser-edition-index'
  || snapshot.coverage?.complete !== true
  || snapshot.coverage.editionCount !== snapshot.editions?.length
  || snapshot.coverage.capturedEditionCount !== snapshot.coverage.editionCount
  || !Array.isArray(snapshot.editions)
  || snapshot.editions.some(edition => edition.captured !== true || !Array.isArray(edition.versions))) {
  throw new Error('Índice parcial de versões da Liga; mapeamento anterior preservado.');
}

const norm = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase('pt-BR').replace(/[^a-z0-9]+/g, ' ').trim();
const normCode = value => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const normNumber = value => String(value || '').toUpperCase().replace(/\s+/g, '').replace(/^0+(?=\d)/, '');
const cards = catalog.cards || [];
const cardIdHash = createHash('sha256').update(cards.map(card => card.id).join('\n')).digest('hex');
const byNumberAndName = new Map();
for (const card of cards) {
  const names = [...new Set([card.name, ...Object.values(card.namesByLanguage || {})].map(norm).filter(Boolean))];
  for (const name of names) {
    const key = `${normNumber(card.localId)}::${name}`;
    if (!byNumberAndName.has(key)) byNumberAndName.set(key, []);
    byNumberAndName.get(key).push(card);
  }
}

const candidatesByCardId = new Map();
const unmatchedVersions = [];
for (const edition of snapshot.editions) {
  const editionCode = String(edition.editionCode || edition.code || '').trim();
  const editionName = String(edition.editionName || edition.name || '').trim();
  if (!editionCode || !editionName) {
    unmatchedVersions.push({ editionId: edition.editionId, editionCode, editionName, reason: 'liga_edition_identity_missing' });
    continue;
  }
  for (const version of edition.versions) {
    const number = String(version.number || '').trim();
    const ligaName = String(version.ligaName || '').trim();
    const versionNames = new Set([ligaName, ...(version.displayNames || [])].map(norm).filter(Boolean));
    const possible = new Set();
    for (const name of versionNames) {
      for (const card of byNumberAndName.get(`${normNumber(number)}::${name}`) || []) possible.add(card);
    }
    const code = normCode(editionCode);
    const setName = norm(editionName);
    const exactEdition = [...possible].filter(card =>
      normCode(card.edition) === code
      || normCode(card.setId) === code
      || normCode(card.tcgdexSetCodeHint) === code
      || normCode(card.tcgdexLigaCodeHint) === code
      || setName === norm(card.tcgdexSetName)
      || setName === norm(card.setName)
    );
    if (exactEdition.length !== 1) {
      unmatchedVersions.push({ editionId: edition.editionId, editionCode, editionName, number, ligaName,
        reason: exactEdition.length ? 'ambiguous_tcg_card_id' : 'no_exact_tcg_card_id' });
      continue;
    }
    const card = exactEdition[0];
    const match = {
      cardId: card.id,
      editionId: String(edition.editionId || ''),
      editionCode,
      editionName,
      number,
      ligaName,
      setTotal: String(version.setTotal || ''),
      detailUrl: String(version.detailUrl || ''),
    };
    let url;
    try { url = new URL(match.detailUrl); } catch { url = null; }
    if (!match.detailUrl || !url || url.protocol !== 'https:' || !/(^|\.)ligapokemon\.com\.br$/i.test(url.hostname)
      || url.searchParams.get('ed')?.toUpperCase() !== editionCode.toUpperCase()
      || normNumber(url.searchParams.get('num')) !== normNumber(number)) {
      unmatchedVersions.push({ ...match, reason: 'invalid_liga_detail_url' });
      continue;
    }
    if (!candidatesByCardId.has(card.id)) candidatesByCardId.set(card.id, []);
    candidatesByCardId.get(card.id).push(match);
  }
}

const matches = [];
const conflicts = [];
for (const [cardId, list] of candidatesByCardId) {
  if (list.length !== 1) {
    conflicts.push({ cardId, editionPrints: list.map(item => `${item.editionCode}:${item.number}`) });
    continue;
  }
  matches.push(list[0]);
}
const matchedIds = new Set(matches.map(item => item.cardId));
const unmatchedCardIds = cards.filter(card => !matchedIds.has(card.id)).map(card => ({
  cardId: card.id,
  reason: /^(?:A|B)\d+[a-z]?$/i.test(card.setId) ? 'digital_only_tcg_pocket' : 'liga_print_unmatched',
}));
const result = {
  schemaVersion: 1,
  source: 'ligapokemon-browser-edition-index',
  capturedAt: snapshot.capturedAt,
  cardIdHash,
  catalogCardCount: cards.length,
  ligaEditionCount: snapshot.coverage.editionCount,
  ligaVersionCount: snapshot.editions.reduce((sum, item) => sum + item.versions.length, 0),
  matchedCardCount: matches.length,
  unmatchedCardCount: unmatchedCardIds.length,
  unmatchedLigaVersionCount: unmatchedVersions.length,
  conflicts,
  unmatchedVersions,
  unmatchedCardIds,
  matches,
};
const temporary = `${output}.tmp`;
await fs.writeFile(temporary, JSON.stringify(result));
await fs.rename(temporary, output);
console.log(JSON.stringify({
  output: path.relative(process.cwd(), output),
  catalogCardCount: result.catalogCardCount,
  ligaEditionCount: result.ligaEditionCount,
  ligaVersionCount: result.ligaVersionCount,
  matchedCardCount: result.matchedCardCount,
  unmatchedCardCount: result.unmatchedCardCount,
  unmatchedLigaVersionCount: result.unmatchedLigaVersionCount,
  conflictingIds: conflicts.length,
}, null, 2));
