# Pokémon Price Database Brasil

Central externa de preços para o Fichário Pokémon. O GitHub Actions atualiza os dados diariamente e publica:

- `output/prices-current.json`: tabela atual consumida pelo app.
- `output/unmatched-cards.json`: cartas/variantes sem preço público.

## Fontes iniciais

- Cardmarket e TCGplayer via TCGdex.
- Preços brasileiros adicionados em `data/br-prices.csv`.

O cálculo dá prioridade aos preços brasileiros. Quando eles não existem, utiliza referências internacionais com peso menor. Valores claramente fora do conjunto são removidos como outliers.

## Como instalar

1. Crie um repositório novo no GitHub, por exemplo `pokemon-price-database`.
2. Copie todo o conteúdo deste projeto para ele.
3. Em **Settings → Actions → General**, permita `Read and write permissions` para workflows.
4. Abra **Actions → Atualizar tabela de preços → Run workflow**.
5. Após terminar, o arquivo estará em `output/prices-current.json`.

## Adicionar preços brasileiros

Edite `data/br-prices.csv`:

```csv
card_id,finish,source,price_brl,url,observed_at
sv3pt5-199,holo,liga,999.90,https://...,2026-07-23
```

É possível adicionar várias fontes para a mesma carta. O agregador usa mediana, pesos e remoção de valores muito discrepantes.

## Próximos provedores brasileiros

Liga Pokémon e MYP Cards devem entrar como coletores separados somente depois de validar estabilidade e termos de uso. Não coloque senhas ou tokens dentro do aplicativo.
