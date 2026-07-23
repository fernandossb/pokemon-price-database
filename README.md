# Pokémon Price Database Brasil v0.3

Central externa de preços do Fichário Pokémon.

## Como funciona

1. Um job gera o catálogo consolidado em português, inglês e japonês.
2. O catálogo é dividido de forma determinística em 12 lotes.
3. Doze trabalhadores processam os lotes em paralelo.
4. Um job final consolida os resultados e publica um único banco.
5. Os preços anteriores são preservados caso uma fonte deixe de responder temporariamente.
6. Um arquivo diário registra apenas os preços que mudaram, evitando histórico gigantesco.

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

- TCGdex para catálogo e dados estruturados de Cardmarket/TCGplayer.
- `data/br-prices.csv` para referências brasileiras verificadas.
- Frankfurter para conversão de EUR/USD para BRL.

## Observação

A primeira execução ainda consulta todas as cartas, mas agora faz isso em 12 lotes paralelos. As execuções posteriores reaproveitam os preços existentes e preservam valores antigos quando uma consulta falha.
