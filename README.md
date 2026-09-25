# Pokémon Price Database Brasil v0.9

Central externa de preços usada pelo POKECARD Brasil.

## Enums dinâmicos por carta

O banco não usa uma lista fechada de variantes. Para cada carta e idioma, ele preserva exatamente todos os valores encontrados em:

- `card.variants` do TCGdex;
- chaves de `card.pricing.tcgplayer`;
- variantes identificáveis no bloco `card.pricing.cardmarket`.

Qualquer enum novo publicado futuramente entra automaticamente no catálogo da carta. Ele não é descartado, traduzido ou convertido para um nome antigo.

## Chave exata de preço

Cada preço usa:

`cardId::language::variantEnum::condition`

Exemplos:

- `sv03.5-001::pt-br::reverse-holofoil::mercado`
- `base1-4::en::1st-edition-holofoil::mercado`
- `sv3pt5-199::pt-br::holo::M`

A string de `variantEnum` é sensível à nomenclatura. `reverse-holofoil` não é igual a `Reverse Holofoil`, `reversa` ou qualquer alias. `condition` segue a mesma regra: é a string exata cadastrada em `data/br-prices.csv`, sem tradução ou normalização.

`condition` é `"mercado"` quando o preço não tem recorte de condição específica — é o caso do preço internacional (TCGplayer/Cardmarket) e do preço nacional automático (ver abaixo), que reportam um valor de mercado, não o anúncio de um lojista específico. Qualquer outra string em `condition` (`"M"`, `"SM"`, etc.) vem exclusivamente de `data/br-prices.csv` — conferida por uma pessoa, nunca inferida.

## Catálogo mesmo sem preço

Cada shard publica também `variantCatalog`. Assim, um enum confirmado pelas fontes continua aparecendo no cadastro do aplicativo mesmo quando ainda não existe valor exato para ele. Nessa situação, `priced` fica como `false` e nenhum preço de outra variante é reutilizado.

## Fontes e cálculo

Ordem de prioridade — a primeira fonte com valor para a chave exata (`cardId::language::variantEnum::condition`) decide o preço, sem misturar com as outras (ver `SOURCE_PRIORITY` em `scripts/lib.mjs`):

1. **`br-manual`** (`data/br-prices.csv`): preço conferido por uma pessoa direto na Liga Pokémon, como qualquer cliente — sem automação. É a única fonte que preenche uma `condition` específica (`"M"`, `"SM"`, etc.); cobre só as cartas cadastradas manualmente ali.
2. **`ligapokemon`**: preço nacional automático, buscado num endpoint público de busca da Liga (sem login, sem navegador, sem burlar nenhuma proteção do site). Só é aplicado à `condition` `"mercado"`, porque esse endpoint devolve um valor agregado por carta, sem recorte por condição/lojista. Melhor esforço, com interruptor em `config.json` (`ligaPokemon.enabled`) — qualquer falha (endpoint fora do ar, carta não encontrada) cai silenciosamente para as fontes abaixo.
3. **TCGplayer**: para uma variante, somente o objeto cuja chave seja exatamente igual ao `variantEnum`.
4. **Cardmarket**: os grupos explícitos `normal` e `holo`, além de futuros objetos de variante caso sejam publicados.

Conversão de EUR e USD para BRL pelo Frankfurter — não se aplica a `br-manual` nem a `ligapokemon`, que já são preços nacionais. Dentro da fonte escolhida, o preço final é a média aritmética simples dos valores positivos disponíveis para o enum exato.

Este banco **não** faz scraping do marketplace completo da Liga Pokémon nem tenta contornar proteções antibot do site — isso violaria os Termos de Uso deles. A precisão por condição/idioma/acabamento vem do cadastro manual (`data/br-prices.csv`), não de automação em massa.

## Cadastro manual (`data/br-prices.csv`)

Colunas: `card_id,language,finish,condition,source,price_brl,url,observed_at`.

- `card_id`, `language`, `finish`: os mesmos valores exatos que aparecem na chave de preço (`cardId`, `language`, `variantEnum`).
- `condition`: a condição exata anunciada (ex: `M`, `SM`). Vazio publica em `"mercado"`.
- `price_brl`: o menor preço visto para aquela condição exata, em reais.

Uma linha por card+idioma+acabamento+condição. Mais de uma linha para a mesma combinação faz a média entre elas.

## Arquivos publicados

- `output/status.json`: schema 5, formato `sharded-v3`;
- `output/card-shard-index.json`: formato `card-shard-index-v3`;
- `output/shards/shard-00.json` até `shard-11.json`: formato `price-shard-v3`, com `prices` e `variantCatalog`;
- `output/unmatched-cards.json`: enums sem preço em nenhuma fonte (considerando só a condição `"mercado"` — a ausência de uma condição específica não é tratada como pendência);
- `history/YYYY-MM-DD-changes.json`: alterações de preço.

> **Mudança de schema (v0.9):** a chave de preço ganhou o quarto segmento `condition`. Um consumidor deste banco que dependia do formato antigo (`cardId::language::variantEnum`, schema 4) precisa ser atualizado antes de ler os arquivos publicados a partir desta versão.

## Publicação

A atualização automática roda diariamente às 03:00 no horário de Brasília e também pode ser iniciada em **Actions → Atualizar tabela de preços em paralelo → Run workflow**.
