import fs from 'node:fs/promises';

const apiKey = process.env.REEF_API_KEY;
if (!apiKey) throw new Error('REEF_API_KEY ausente; pré-verificação concluída sem chamadas pagas.');

const catalog = JSON.parse(await fs.readFile('work/catalog.json', 'utf8'));
if (!Array.isArray(catalog.cards) || catalog.cards.length < 1) {
  throw new Error('Catálogo vazio; atualização cancelada antes da consulta de saldo.');
}

const response = await fetch('https://api.reefapi.com/account/v1/credits', {
  headers: { 'x-api-key': apiKey },
  signal: AbortSignal.timeout(30000),
});
let body;
try {
  body = await response.json();
} catch (error) {
  throw new Error(`Resposta inválida na leitura de saldo ReefAPI (HTTP ${response.status}): ${error.message}`);
}
if (!response.ok || body?.ok !== true) {
  throw new Error(`Não foi possível confirmar o saldo ReefAPI (HTTP ${response.status}); nenhuma coleta iniciada.`);
}

const remaining = Number(body.data?.remaining ?? body.remaining);
if (!Number.isFinite(remaining) || remaining < 0) {
  throw new Error('A resposta de saldo ReefAPI não contém `remaining`; nenhuma coleta iniciada.');
}

// O endpoint card custa 4 créditos por impressão. Dez por cento de margem
// cobre paginações ocasionais sem iniciar uma coleta que já nasce subfinanciada.
const baseCredits = catalog.cards.length * 4;
const reserveCredits = Math.ceil(baseCredits * 0.10);
const minimumCredits = baseCredits + reserveCredits;
console.log(JSON.stringify({
  cards: catalog.cards.length,
  baseCredits,
  reserveCredits,
  minimumCredits,
  remainingCredits: remaining,
  sufficient: remaining >= minimumCredits,
}, null, 2));

if (remaining < minimumCredits) {
  throw new Error(`Saldo insuficiente: são necessários ao menos ${minimumCredits} créditos para iniciar a coleta; disponíveis ${remaining}.`);
}
