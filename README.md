# Pokémon Price Database Brasil v0.7

Central externa de preços usada pelo POKECARD Brasil.

## Enums dinâmicos por carta

O banco não usa uma lista fechada de variantes. Para cada carta e idioma, ele preserva exatamente todos os valores encontrados em:

- `card.variants` do TCGdex;
- chaves de `card.pricing.tcgplayer`;
- variantes identificáveis no bloco `card.pricing.cardmarket`.

Qualquer enum novo publicado futuramente entra automaticamente no catálogo da carta. Ele não é descartado, traduzido ou convertido para um nome antigo.

## Chave exata de preço

Cada preço usa:

`cardId::language::variantEnum`

Exemplos:

- `sv03.5-001::pt-br::reverse-holofoil`
- `base1-4::en::1st-edition-holofoil`
- `set-x-10::en::future-galaxy-foil`

A string de `variantEnum` é sensível à nomenclatura. `reverse-holofoil` não é igual a `Reverse Holofoil`, `reversa` ou qualquer alias.

## Catálogo mesmo sem preço

Cada shard publica também `variantCatalog`. Assim, um enum confirmado pelas fontes continua aparecendo no cadastro do aplicativo mesmo quando ainda não existe valor exato para ele. Nessa situação, `priced` fica como `false` e nenhum preço de outra variante é reutilizado.

## Fontes e cálculo

- TCGplayer: para uma variante, somente o objeto cuja chave seja exatamente igual ao `variantEnum`.
- Cardmarket: os grupos explícitos `normal` e `holo`, além de futuros objetos de variante caso sejam publicados.
- Conversão de EUR e USD para BRL pelo Frankfurter.
- Média aritmética simples dos valores positivos disponíveis para o enum exato.

## Arquivos publicados

- `output/status.json`: schema 4, formato `sharded-v2`;
- `output/card-shard-index.json`: formato `card-shard-index-v2`;
- `output/shards/shard-00.json` até `shard-11.json`: formato `price-shard-v2`, com `prices` e `variantCatalog`;
- `output/unmatched-cards.json`: enums encontrados sem preço exato;
- `history/YYYY-MM-DD-changes.json`: alterações de preço.

## Publicação

A atualização automática roda diariamente às 03:00 no horário de Brasília e também pode ser iniciada em **Actions → Atualizar tabela de preços em paralelo → Run workflow**.
