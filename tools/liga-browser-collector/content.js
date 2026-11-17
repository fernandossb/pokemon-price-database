const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function visible(element) {
  if (!element) return false;
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
}

function findLoadMoreControl() {
  const matches = [...document.querySelectorAll('.card-load-more-button, button, a, [role="button"], [onclick]')]
    .filter(element => normalizeText(element.textContent).toLocaleLowerCase('pt-BR') === 'mostrar mais');
  return matches.find(element => element.matches('button, a, [role="button"], [onclick]')) || matches[0] || null;
}

async function expandListings(container) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const rowsBefore = container.querySelectorAll('[id^="mpline_1_"]').length;
    const more = [...container.querySelectorAll('button,a,[role="button"],div,span')]
      .find(element => visible(element) && normalizeText(element.textContent).toLocaleUpperCase('pt-BR') === 'VER MAIS');
    if (!more) break;
    more.click();
    for (let wait = 0; wait < 20; wait += 1) {
      await sleep(250);
      if (container.querySelectorAll('[id^="mpline_1_"]').length > rowsBefore) break;
    }
    if (container.querySelectorAll('[id^="mpline_1_"]').length <= rowsBefore) break;
  }
}

async function materializeOfferRows(container) {
  // Liga lazy-loads part of each seller row only after it enters the viewport.
  // Bring small batches into view so price, language flag and stock are ready
  // before parsing; this uses the same rendered page as a human visitor.
  for (let index = 0; index < 4000; index += 4) {
    const rows = container.querySelectorAll('[id^="mpline_1_"]');
    if (index >= rows.length) break;
    rows[Math.min(index + 3, rows.length - 1)]?.scrollIntoView({ block: 'center', behavior: 'instant' });
    await sleep(180);
  }
}

function normalizeLanguage(row) {
  const labels = [...row.querySelectorAll('img')].map(image => [
    image.alt, image.title, image.getAttribute('aria-label'), image.src,
  ].join(' ')).join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/portugues.{0,15}ingles|ingles.{0,15}portugues|pt.?en|pten/.test(labels)) return 'PTEN';
  if (/japones|nihongo|\/ja\//.test(labels)) return 'JP';
  if (/ingles|english|\/en\//.test(labels)) return 'EN';
  if (/portugues|brazil|brasil|\/pt\//.test(labels)) return 'PT';
  return '';
}

function parsePrice(row) {
  const prices = [...normalizeText(row.innerText).matchAll(/R\$\s*([\d.]+,\d{2})/g)];
  if (!prices.length) return null;
  // Quando há promoção, a Liga mostra o valor antigo riscado antes do atual.
  const value = prices.at(-1)[1].replaceAll('.', '').replace(',', '.');
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function sellerFromRow(row, listingId) {
  const link = [...row.querySelectorAll('a[href]')].find(anchor => anchor.querySelector('img'))
    || row.querySelector('a[href]');
  const image = link?.querySelector('img');
  const name = normalizeText([
    link?.getAttribute('aria-label'), link?.title, image?.alt, image?.title, image?.getAttribute('aria-label'), link?.innerText,
  ].find(value => normalizeText(value)));
  const href = link?.href || '';
  let sellerId = '';
  try {
    const url = new URL(href);
    if (url.hostname === location.hostname) {
      sellerId = url.searchParams.get('id') || `${url.pathname}${url.search}`;
    }
  } catch {}
  if (!sellerId) sellerId = `listing:${listingId}`;
  return { seller: name || `Loja ${sellerId.slice(0, 96)}`, sellerId };
}

function extractOffers(container, card, observedAt) {
  const rows = [...container.querySelectorAll('[id^="mpline_1_"]')];
  const offers = [];
  const issues = [];
  let unpricedRowCount = 0;
  for (const row of rows) {
    const listingId = row.id.match(/^mpline_1_(.+)$/)?.[1] || '';
    const text = normalizeText(row.innerText);
    const priceBrl = parsePrice(row);
    const language = normalizeLanguage(row);
    const condition = text.match(/(?:^|\s)(NM|SP|MP|HP|M|D)(?:\s|$)/i)?.[1]?.toUpperCase() || '';
    // Liga can render a seller row before its price is available (for example,
    // the row contains only the currency label). Such a row is not an offer
    // we can publish; skip it without discarding the other valid listings.
    if (!priceBrl) {
      unpricedRowCount += 1;
      continue;
    }
    if (!listingId || !language || !condition) {
      issues.push({ listingId, text: text.slice(0, 180), missing: [!listingId && 'listingId', !language && 'language', !condition && 'condition'].filter(Boolean) });
      continue;
    }
    const extras = [...row.querySelectorAll('span,small,label,[class*="extra"],[class*="foil"]')]
      .map(element => normalizeText(element.textContent)).filter(Boolean);
    const finish = extras.join(' ') || text;
    const isFoil = /foil|holo|brilh/i.test(finish);
    const seller = sellerFromRow(row, listingId);
    const quantityInput = row.querySelector(`#mpitem_${CSS.escape(listingId)}`);
    const stock = [...text.matchAll(/\bde\s+(\d+)\b/gi)].map(match => Number(match[1])).at(-1) || null;
    offers.push({
      cardId: card.cardId,
      listingId,
      seller: seller.seller,
      sellerId: seller.sellerId,
      condition,
      priceBrl,
      language,
      finish,
      extras,
      is_foil: isFoil,
      stock: stock || (quantityInput ? Number(quantityInput.value) || null : null),
      url: location.href,
      observedAt,
    });
  }
  return { offers, issues, rowCount: rows.length, unpricedRowCount };
}

function parseEditionLink(anchor) {
  let url;
  try { url = new URL(anchor.href, location.href); } catch { return null; }
  const cardQuery = url.searchParams.get('card') || '';
  const match = cardQuery.match(/edid=(\d+)\s+ed=([a-z0-9_.-]+)/i);
  if (!match) return null;
  return {
    editionId: match[1],
    code: match[2],
    name: normalizeText(anchor.innerText),
    url: url.href,
  };
}

function captureEditionIndex() {
  if (new URLSearchParams(location.search).get('view') !== 'cards/edicoes') {
    return { ok: false, reason: 'open_liga_editions_page' };
  }
  const pageText = `${document.title} ${document.body?.innerText?.slice(0, 1200) || ''}`.toLowerCase();
  if (/just a moment|captcha|verifique se voce|cloudflare/.test(pageText)) {
    return { ok: false, reason: 'challenge_or_interstitial' };
  }
  const editions = [...document.querySelectorAll('a[href*="edid="]')]
    .map(parseEditionLink).filter(Boolean);
  const unique = [...new Map(editions.map(item => [`${item.editionId}::${item.code}`, item])).values()];
  if (!unique.length) return { ok: false, reason: 'liga_edition_index_missing' };
  return { ok: true, editions: unique, capturedAt: new Date().toISOString() };
}

function editionFromSearchQuery() {
  const value = new URLSearchParams(location.search).get('card') || '';
  return value.match(/edid=(\d+)\s+ed=([a-z0-9_.-]+)/i);
}

async function captureSetVersions(edition) {
  const current = editionFromSearchQuery();
  if (!current || current[1] !== String(edition.editionId) || current[2].toUpperCase() !== String(edition.code).toUpperCase()) {
    return { ok: false, reason: 'edition_mismatch', currentUrl: location.href };
  }
  const title = `${document.title} ${document.body?.innerText?.slice(0, 1200) || ''}`.toLowerCase();
  if (/just a moment|captcha|verifique se voce|cloudflare/.test(title)) {
    return { ok: false, reason: 'challenge_or_interstitial' };
  }

  const editionSummary = document.querySelector('.nav-editions_middle')?.innerText || '';
  const expectedCountMatch = editionSummary.match(/\b(\d+)\s+(?:cards?|cartas?)\b/i);
  const expectedCount = expectedCountMatch ? Number(expectedCountMatch[1]) : null;
  const startedAt = Date.now();
  let noGrowthAttempts = 0;
  let stableCompleteSince = 0;
  let previousCount = -1;
  let loadMorePresent = false;
  // Liga's edition pages render an initial batch and append later batches via
  // Mostrar mais. Keep asking for batches until the advertised total exists;
  // a few unchanged DOM reads are not evidence that the list is complete.
  while (Date.now() - startedAt < 180_000) {
    const currentCount = document.querySelectorAll('.card-item').length;
    if (currentCount !== previousCount) {
      previousCount = currentCount;
      noGrowthAttempts = 0;
    }

    if (expectedCount === null || currentCount >= expectedCount) {
      if (!stableCompleteSince) stableCompleteSince = Date.now();
      if (Date.now() - stableCompleteSince >= 1200) break;
      await sleep(250);
      continue;
    }
    stableCompleteSince = 0;
    [...document.querySelectorAll('.card-item')].at(-1)
      ?.scrollIntoView({ block: 'end', behavior: 'instant' });
    await sleep(350);

    const more = findLoadMoreControl();
    loadMorePresent = Boolean(more);
    if (!more) {
      noGrowthAttempts += 1;
      if (noGrowthAttempts >= 12) break;
      await sleep(750);
      continue;
    }

    // The control's inline handler is reliable only when it is in the viewport.
    more.scrollIntoView({ block: 'center', behavior: 'instant' });
    await sleep(250);
    const beforeClick = document.querySelectorAll('.card-item').length;
    more.click();
    let expanded = false;
    for (let wait = 0; wait < 60; wait += 1) {
      await sleep(250);
      if (document.querySelectorAll('.card-item').length > beforeClick) {
        expanded = true;
        break;
      }
    }
    if (expanded) {
      noGrowthAttempts = 0;
      previousCount = document.querySelectorAll('.card-item').length;
    } else {
      noGrowthAttempts += 1;
      // Retry transient page-handler delays several times; stop only after a
      // bounded wait, and return counts so the user can see the actual failure.
      if (noGrowthAttempts >= 8) break;
      await sleep(Math.min(1500, 300 * noGrowthAttempts));
    }
  }

  const cardItems = [...document.querySelectorAll('.card-item')];
  // Do not read the whole document here: the global navigation includes deck
  // links such as “60 cartas”, which is unrelated to the selected edition.
  const versions = cardItems.flatMap(item => {
    const anchor = item.querySelector('a.main-link-card[href*="view=cards/card"]');
    if (!anchor) return [];
    let url;
    try { url = new URL(anchor.href, location.href); } catch { return []; }
    const cardLabel = url.searchParams.get('card') || '';
    const print = cardLabel.match(/^(.*?)\s*\(([^()]*)\)$/);
    const printedParts = print?.[2]?.split('/').map(value => value.trim()) || [];
    const editionCode = url.searchParams.get('ed') || '';
    const number = url.searchParams.get('num') || print?.[2]?.split('/')[0]?.trim() || '';
    if (!editionCode || !number) return [];
    const prices = [...(item.innerText || '').matchAll(/R\$\s*([\d.]+,\d{2})/g)]
      .map(match => Number(match[1].replaceAll('.', '').replace(',', '.'))).filter(value => value > 0);
    return [{
      ligaName: normalizeText(print?.[1] || cardLabel),
      displayNames: [
        anchor.getAttribute('aria-label'), anchor.title,
        ...[...anchor.querySelectorAll('img')].map(image => image.alt || image.title),
        ...(item.innerText || '').split(/\r?\n/),
      ].map(normalizeText).filter(value => value && value.length <= 80 && !/R\$|\b\d+\s*\/\s*\d+\b/.test(value)),
      displayText: normalizeText(item.innerText),
      number,
      setTotal: printedParts[1] || '',
      editionCode,
      editionId: edition.editionId,
      editionName: edition.name,
      detailUrl: url.href,
      priceHintsBrl: prices,
    }];
  });
  if (!versions.length && cardItems.length === 0 && expectedCount === 0) {
    return {
      ok: true,
      editionId: String(edition.editionId),
      editionCode: edition.code,
      editionName: edition.name,
      expectedCount: 0,
      capturedAt: new Date().toISOString(),
      versions: [],
      skippedReason: 'empty_edition',
    };
  }
  if (!versions.length) return { ok: false, reason: 'liga_cards_missing', expectedCount, cardItemCount: cardItems.length };
  if (expectedCount !== null && versions.length < expectedCount) {
    const cardItemCount = cardItems.length;
    const loadMore = findLoadMoreControl();
    loadMorePresent = Boolean(loadMore);
    return {
      ok: false,
      reason: 'edition_list_incomplete',
      expectedCount,
      cardItemCount,
      capturedCount: versions.length,
      loadMorePresent,
      loadMoreVisible: Boolean(loadMore && visible(loadMore)),
      waitedMs: Date.now() - startedAt,
    };
  }
  return {
    ok: true,
    editionId: edition.editionId,
    editionCode: edition.code,
    editionName: edition.name,
    expectedCount,
    capturedAt: new Date().toISOString(),
    versions,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'CAPTURE_LIGA_EDITION_INDEX') {
    try { sendResponse(captureEditionIndex()); }
    catch (error) { sendResponse({ ok: false, reason: 'capture_error', message: error.message }); }
    return false;
  }
  if (message?.type === 'CAPTURE_LIGA_SET_VERSIONS') {
    captureSetVersions(message.edition).then(sendResponse)
      .catch(error => sendResponse({ ok: false, reason: 'capture_error', message: error.message }));
    return true;
  }
  if (message?.type !== 'CAPTURE_LIGA_CARD') return;
  (async () => {
    const card = message.card;
    const params = new URLSearchParams(location.search);
    const title = `${document.title} ${document.body?.innerText?.slice(0, 1200) || ''}`.toLowerCase();
    if (/just a moment|captcha|verifique se voce|cloudflare/.test(title)) {
      return { ok: false, reason: 'challenge_or_interstitial' };
    }
    if (params.get('ed')?.toUpperCase() !== String(card.edition).toUpperCase()
      || String(params.get('num') || '').replace(/^0+(?=\d)/, '') !== String(card.number).replace(/^0+(?=\d)/, '')) {
      return { ok: false, reason: 'print_mismatch', currentUrl: location.href };
    }
    if (card.detailUrl) {
      let expected;
      try { expected = new URL(card.detailUrl); } catch { return { ok: false, reason: 'invalid_detail_url' }; }
      const expectedCard = normalizeText(expected.searchParams.get('card')).toLocaleLowerCase('pt-BR');
      const currentCard = normalizeText(params.get('card')).toLocaleLowerCase('pt-BR');
      if (!/(^|\.)ligapokemon\.com\.br$/i.test(expected.hostname)
        || expected.searchParams.get('view') !== 'cards/card'
        || expected.searchParams.get('ed')?.toUpperCase() !== params.get('ed')?.toUpperCase()
        || String(expected.searchParams.get('num') || '').replace(/^0+(?=\d)/, '') !== String(params.get('num') || '').replace(/^0+(?=\d)/, '')
        || (expectedCard && currentCard !== expectedCard)) {
        return { ok: false, reason: 'detail_url_mismatch', currentUrl: location.href };
      }
    }
    const container = document.querySelector('.container-buy-mkp') || document.querySelector('#container-buy-mkp');
    if (!container) {
      if (/nenhum anúncio|nenhum anuncio|não há anúncios|nao ha anuncios|sem anúncios|sem anuncios/i.test(document.body?.innerText || '')) {
        return { ok: true, cardId: card.cardId, observedAt: new Date().toISOString(), rowCount: 0, offers: [] };
      }
      return { ok: false, reason: 'marketplace_container_missing' };
    }
    await expandListings(container);
    await materializeOfferRows(container);
    const observedAt = new Date().toISOString();
    const result = extractOffers(container, card, observedAt);
    if (result.issues.length) return { ok: false, reason: 'unparsed_rows', ...result };
    return { ok: true, cardId: card.cardId, observedAt, ...result };
  })().then(sendResponse).catch(error => sendResponse({ ok: false, reason: 'capture_error', message: error.message }));
  return true;
});
