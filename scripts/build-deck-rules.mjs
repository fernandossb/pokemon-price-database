/**
 * Regras de construção de deck, publicadas todo dia.
 *
 * POR QUE ISTO EXISTE
 *   Há dois tipos de regra. As de construção — 60 cartas, no máximo 4 cópias
 *   pelo mesmo nome, energia básica sem limite — não mudam nunca e podem
 *   viver num arquivo dentro do aplicativo. Já a ROTAÇÃO muda todo ano: no dia
 *   em que ela acontece, qualquer lista embutida no aplicativo passa a mentir,
 *   e só para de mentir quando alguém recompila.
 *
 *   Por isso a rotação vem daqui. O aplicativo baixa este arquivo e guarda,
 *   igual faz com os preços: funciona sem internet usando a última cópia, e
 *   quando a rotação virar, ele se corrige sozinho na próxima abertura.
 *
 * POR QUE O APLICATIVO NÃO CONSULTA A FONTE DIRETO
 *   A pokemontcg.io limita chamadas de quem não tem chave. Um aplicativo
 *   consultando a cada abertura toma bloqueio; um serviço consultando uma vez
 *   por dia, não. E aqui é um lugar só para consertar se a fonte mudar de
 *   formato, em vez de esperar todo mundo recompilar.
 *
 * O QUE ESTE ARQUIVO NÃO É
 *   A pokemontcg.io é um projeto da comunidade, não o regulamento oficial.
 *   O campo `aviso` acompanha o arquivo para que o aplicativo mostre isso ao
 *   usuário em vez de afirmar legalidade como se fosse a regra impressa.
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

const FONTE = 'https://api.pokemontcg.io/v2/sets?pageSize=250';
const SAIDA = path.join('output', 'deck-rules.json');

/* Convenções de construção. Ficam aqui, e não no aplicativo, para que exista
   UMA fonte da verdade — o arquivo local do app passa a ser só a cópia de
   partida para quem nunca conseguiu baixar. */
const CONSTRUCAO = {
  deckSize: 60,
  sameNameLimit: 4,
  basicEnergyUnlimited: true,
  minimumRealEnergy: 8,
  maximumPrimaryEnergyTypes: 2,
};

async function buscarComTentativas(url, tentativas = 4) {
  let ultimoErro;
  for (let tentativa = 1; tentativa <= tentativas; tentativa += 1) {
    try {
      const resposta = await fetch(url, { headers: { accept: 'application/json' } });
      if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
      return await resposta.json();
    } catch (erro) {
      ultimoErro = erro;
      // Espera crescente: a fonte às vezes recusa por excesso de chamadas.
      await new Promise(resolve => setTimeout(resolve, tentativa * 3000));
    }
  }
  throw ultimoErro;
}

/* Os ids das duas fontes não batem: o nosso catálogo é TCGdex ("sv03.5") e a
   fonte de legalidade é pokemontcg.io ("sv3pt5"). Publicar os dois formatos
   evita que o aplicativo tenha de adivinhar a conversão. */
function idsEquivalentes(id) {
  const base = String(id).toLowerCase();
  const variantes = new Set([base]);
  // sv3pt5 → sv3.5 e sv03.5
  const comPonto = base.replace(/pt(\d)/g, '.$1');
  variantes.add(comPonto);
  variantes.add(comPonto.replace(/^([a-z]+)(\d)(?![\d])/, (_, letras, digito) => `${letras}0${digito}`));
  variantes.add(comPonto.replace(/^([a-z]+)(\d)(\.)/, (_, letras, digito, ponto) => `${letras}0${digito}${ponto}`));
  return [...variantes];
}

async function main() {
  console.log('Buscando legalidade das coleções...');
  const dados = await buscarComTentativas(FONTE);
  const colecoes = Array.isArray(dados?.data) ? dados.data : [];
  if (colecoes.length < 50) throw new Error(`Fonte devolveu só ${colecoes.length} coleções — algo está errado.`);

  const padrao = [];
  const expandido = [];
  for (const colecao of colecoes) {
    const legal = colecao?.legalities || {};
    if (legal.standard === 'Legal') padrao.push(...idsEquivalentes(colecao.id));
    if (legal.expanded === 'Legal') expandido.push(...idsEquivalentes(colecao.id));
  }

  /* Guarda a data da coleção mais nova do Padrão. É por ela que o aplicativo
     percebe que a lista envelheceu — uma rotação aconteceu e este serviço
     ainda não rodou. */
  const maisNova = colecoes
    .filter(c => c?.legalities?.standard === 'Legal' && c.releaseDate)
    .map(c => String(c.releaseDate).replace(/\//g, '-'))
    .sort()
    .pop() || null;

  const regras = {
    formato: 'pokecard-deck-rules-v1',
    geradoEm: new Date().toISOString(),
    fonte: 'pokemontcg.io (projeto da comunidade)',
    aviso: 'Legalidade estimada a partir de uma fonte da comunidade, não do regulamento oficial. Confirme no site oficial antes de um campeonato.',
    construcao: CONSTRUCAO,
    colecaoMaisNovaDoPadrao: maisNova,
    padrao: [...new Set(padrao)].sort(),
    expandido: [...new Set(expandido)].sort(),
  };

  // Nunca publicar uma lista vazia por cima de uma boa.
  if (!regras.padrao.length) throw new Error('Nenhuma coleção legal no Padrão — recusando publicar.');
  try {
    const anterior = JSON.parse(await readFile(SAIDA, 'utf8'));
    const antes = (anterior?.padrao || []).length;
    if (antes > 4 && regras.padrao.length < antes / 2) {
      throw new Error(`Lista encolheu demais (${antes} → ${regras.padrao.length}). Recusando publicar.`);
    }
  } catch (erro) {
    if (erro?.code !== 'ENOENT' && !String(erro?.message || '').includes('Unexpected')) throw erro;
  }

  await mkdir(path.dirname(SAIDA), { recursive: true });
  await writeFile(SAIDA, `${JSON.stringify(regras, null, 2)}\n`, 'utf8');
  console.log(`Publicado: ${regras.padrao.length} ids no Padrão, ${regras.expandido.length} no Expandido.`);
  console.log(`Coleção mais nova do Padrão: ${maisNova || 'desconhecida'}`);
}

main().catch(erro => {
  console.error('Falhou:', erro.message);
  process.exit(1);
});
