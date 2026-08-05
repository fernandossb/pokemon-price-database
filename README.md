# Pokémon Price Database Brasil v0.5

Central externa de preços do POKECARD Brasil.

## Como funciona

1. Um job gera o catálogo consolidado em português, inglês e japonês.
2. O catálogo é dividido de forma determinística em 12 lotes.
3. Doze trabalhadores processam os lotes em paralelo.
4. Cada carta é consultada em todos os idiomas disponíveis.
5. Um job final consolida os resultados, preserva preços anteriores em falhas temporárias e publica o banco atual.
6. Um arquivo diário registra somente os preços alterados.

## Chave das variações

Cada registro usa a chave:

`cardId::language::printVariation::stamp::finish`

Exemplo:

`base1-4::en::firstEdition::unstamped::holo`

Dimensões:

- idioma: `pt-br`, `en` ou `ja`;
- edição: `unlimited` ou `firstEdition`;
- carimbo: `unstamped` ou `stamped`;
- acabamento: `normal`, `holo` ou `reverse`.

## Proteção contra mistura de versões

A versão 0.5 não reutiliza automaticamente o preço unlimited para 1ª edição. A 1ª edição só recebe preço quando o TCGplayer expõe uma chave própria, como `1st-edition` ou `1st-edition-holofoil`.

O TCGdex informa a existência de uma versão com carimbo promocional, mas os campos públicos de preço nem sempre identificam o carimbo em cada valor. Nesses casos o banco mantém o registro separado com:

- `matchLevel: "estimated"`;
- `estimatedDimensions: ["stamp"]`;
- confiança limitada a no máximo 34%.

O POKECARD Brasil mostra esse preço para revisão, mas não o inclui automaticamente no valor da coleção.

## Metodologia de preço

Para uma combinação suportada, o preço é a média aritmética simples dos valores públicos disponíveis:

- Cardmarket: tendência, médias de 30, 7 e 1 dia, preço médio de venda e menor oferta;
- TCGplayer: market, mid e low;
- conversão de EUR/USD para BRL pelo Frankfurter.

Cardmarket só participa da edição unlimited, pois os campos expostos não separam 1ª edição. Nenhum outlier é removido e nenhuma fonte recebe peso maior.

## Arquivos publicados

- `output/prices-current.json`: banco atual para o aplicativo;
- `output/status.json`: status e versão do esquema;
- `output/unmatched-cards.json`: cartas/variações sem preço estruturado;
- `history/YYYY-MM-DD-changes.json`: mudanças do dia;
- `cache/shards/`: último resultado dos trabalhadores.

O esquema atual é `schemaVersion: 2`.

## Agendamento

A atualização automática roda todos os dias às 03:00 no horário de Brasília. Também pode ser iniciada manualmente em **Actions → Atualizar tabela de preços em paralelo → Run workflow**.

## Permissão necessária

No GitHub, abra **Settings → Actions → General → Workflow permissions** e marque **Read and write permissions**.
