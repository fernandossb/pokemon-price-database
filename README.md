# Pokémon Price Database Brasil v0.4

Central externa de preços do Fichário Pokémon.

## Como funciona

1. Um job gera o catálogo consolidado em português, inglês e japonês.
2. O catálogo é dividido de forma determinística em 12 lotes.
3. Doze trabalhadores processam os lotes em paralelo. Para cada carta, buscam os dados completos em **todos** os idiomas disponíveis (não só o primeiro que responder) e calculam um preço por combinação de idioma, variação de impressão, carimbo e acabamento.
4. Um job final consolida os resultados e publica um único banco.
5. Os preços anteriores são preservados caso uma fonte deixe de responder temporariamente.
6. Um arquivo diário registra apenas os preços que mudaram, evitando histórico gigantesco.

## Metodologia de preço

Cada carta é precificada separadamente por **idioma** (pt-br/en/ja), **variação de impressão** (unlimited/1ª edição), **carimbo** (com/sem carimbo promocional) e **acabamento** (normal/holo/reverse) — combinações derivadas das flags estruturadas que o TCGdex expõe para cada carta (`variants.firstEdition`, `variants.wPromo`, `variants.holo`, `variants.reverse`, `variants.normal`).

O preço de cada combinação é a **média aritmética simples** de todos os valores de Cardmarket e TCGplayer disponíveis para o acabamento correspondente (trend, avg30, avg7, avg1, low, average-sell-price no Cardmarket; market/mid/low no TCGplayer, convertidos de EUR/USD para BRL) — **sem remoção de outliers e sem peso maior para nenhuma fonte**.

## Arquivos publicados

- `output/prices-current.json`: banco atual para o aplicativo.
- `output/status.json`: status da última atualização.
- `output/unmatched-cards.json`: cartas/variantes sem preço público.
- `history/YYYY-MM-DD-changes.json`: variações do dia.
- `cache/shards/`: último resultado de cada trabalhador.

## Agendamento

A atualização automática roda todos os dias às 03:00 no horário de Brasília. Também pode ser iniciada manualmente em **Actions → Atualizar tabela de preços em paralelo → Run workflow**.

## Permissão necessária

No GitHub, abra **Settings → Actions → General → Workflow permissions** e marque **Read and write permissions**.

## Fontes

- TCGdex para catálogo, variantes estruturadas (acabamento, 1ª edição, carimbo promocional) e dados de Cardmarket/TCGplayer.
- Frankfurter para conversão de EUR/USD para BRL.

## Observação

A primeira execução ainda consulta todas as cartas, mas agora faz isso em 12 lotes paralelos, buscando cada carta em todos os idiomas disponíveis. As execuções posteriores reaproveitam os preços existentes e preservam valores antigos quando uma consulta falha.
