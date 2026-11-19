# Pokémon Price Database Brasil v0.7

Central externa de preços usada pelo POKECARD Brasil.

## Enums dinâmicos por carta

O banco preserva os enums de acabamento por carta e idioma para continuar compatível com os registros existentes no POKECARD. Eles são usados somente para traduzir anúncios da Liga para as variantes que o aplicativo já conhece; não fornecem nomes de edição, numeração nem preços.

- `card.variants` e `variants_detailed` do TCGdex, somente como vocabulário de acabamento/idioma do aplicativo.

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

## Fonte e cálculo de preço

- Edições, nomes e números das impressões vêm do índice e das páginas normais da Liga Pokémon. O TCGdex serve apenas para preservar os IDs já usados pelo aplicativo e fazer a ponte entre idioma/acabamento e os enums existentes.
- Todo preço publicado vem de anúncios individuais visíveis na Liga. Cada anúncio é conferido pela URL da impressão, idioma e acabamento; aceitamos condição M/NM e usamos no máximo o menor anúncio de cada vendedor.
- A referência publicada é a mediana do menor anúncio elegível de cada vendedor distinto. Uma oferta M/NM já basta para vincular o preço; sem anúncio elegível, a variante fica sem preço e aparece em `unmatched-cards.json`.
- Uma captura sem preço de vendedor, com correspondência incerta ou vencida não substitui o preço anterior publicado; as variantes sem anúncio elegível ficam pendentes.
- Cada oferta guarda o anúncio, a loja, a condição, o idioma, o acabamento e o horário em que a página foi lida.

## Variantes especiais

Acabamentos da Liga são relacionados aos enums existentes do app. Se não houver vínculo exato de impressão, idioma ou acabamento, a variante fica sem preço e aparece em `unmatched-cards.json`; o POKECARD a mostra em **Preços pendentes**. Preço ligado à Liga com correspondência exata remove a pendência mesmo quando o campo manual está vazio. Nenhuma variante herda o preço de outra.

## Arquivos publicados

- `output/status.json`: schema 4, formato `sharded-v2`;
- `output/card-shard-index.json`: formato `card-shard-index-v2`;
- `output/shards/shard-00.json` até `shard-11.json`: formato `price-shard-v2`, com `prices` e `variantCatalog`;
- `output/unmatched-cards.json`: enums encontrados sem preço exato;
- `history/YYYY-MM-DD-changes.json`: alterações de preço.

## Publicação

A atualização validada é publicada automaticamente a cada checkpoint enviado ao repositório e ao concluir a fila. Durante a coleta, o coletor envia checkpoints a cada 100 cartas ou 10 minutos, o que ocorrer primeiro. O workflow também pode ser iniciado manualmente em **Actions → Atualizar preços pelos anúncios da Liga → Run workflow**.


## Preços brasileiros da Liga Pokémon

Os preços são valores pedidos pelos vendedores, não vendas concluídas, e não incluem frete. O coletor trabalha nas páginas normais da Liga, e não usa serviço de raspagem, API paga ou fonte alternativa para preencher preços ausentes.

### Importar um snapshot local de anúncios

O pipeline aceita snapshots de **anúncios individuais** no schema [`docs/liga-offer-snapshot-v2.schema.json`](docs/liga-offer-snapshot-v2.schema.json). Cada linha associa o ID já usado pelo aplicativo a um anúncio individual da Liga, com idioma, acabamento, vendedor, condição, valor em BRL, URL da impressão e horário observado. A integração por navegador publica checkpoints durante a coleta e aceita anúncios observados nos últimos 30 dias; registros inválidos são rejeitados.

### Captura pela página normal da Liga

O coletor local em [`tools/liga-browser-collector`](tools/liga-browser-collector) percorre a interface normal da Liga, carrega os anúncios com **Ver Mais**, rola as linhas para acionar o carregamento visual e lê os dados renderizados. Ele trabalha em uma aba por vez, grava o progresso localmente no IndexedDB do Chrome e pausa se encontrar uma página que não consiga ler com segurança. Não usa proxy, solucionador de desafio ou alteração de identidade do navegador. A extensão pede acesso apenas ao domínio da Liga e guarda as capturas localmente.

Para instalar localmente: no Chrome, abra **Extensões → Gerenciar extensões**, ative **Modo do desenvolvedor**, escolha **Carregar sem compactação** e selecione a pasta `tools/liga-browser-collector`. Se a Liga apresentar sua verificação de segurança, conclua-a manualmente na página normal antes de iniciar a coleta.

Fluxo automático: mantenha o serviço local `npm run liga:sync-server` ativo no computador onde o Chrome e a extensão estão instalados. Quando a descoberta das edições terminar, a extensão envia o índice ao serviço; ele atualiza o repositório `pokemon-price-database`, monta e devolve a fila de cartas, e o coletor inicia a leitura dos anúncios. A cada 100 cartas ou 10 minutos, o que ocorrer primeiro, a extensão publica as capturas pendentes e o progresso no GitHub. O popup mostra quantas cartas estão confirmadas no GitHub e quantas aguardam envio. O GitHub Actions combina os lotes com o snapshot anterior e atualiza `output/status.json` e os shards. Ao concluir a fila, `data/ligapokemon-offers.json` é atualizado como base da próxima coleta. O POKECARD lê `generatedAt` do status e mostra a data da última atualização.

Para priorizar as cartas que você possui, exporte um backup atual no POKECARD em **Mais → Backup da coleção → Exportar backup**, transfira o arquivo para o computador do coletor e carregue-o no popup da extensão em **Priorizar cartas da minha coleção**. A extensão lê somente os IDs e quantidades localmente, mantém essa lista no IndexedDB do Chrome e coloca primeiro as cartas possuídas ainda não coletadas; as demais continuam na fila. O backup completo e a lista de coleção não são enviados ao GitHub. Repita a importação após mudanças importantes na coleção para atualizar a prioridade.

Para iniciar o serviço manualmente: execute `npm run liga:sync-server` na pasta do repositório. O serviço escuta somente em `127.0.0.1`; mantenha o Git configurado com acesso de escrita ao GitHub. A extensão espera um intervalo aleatório de 5 a 10 segundos entre páginas capturadas. Erros transitórios usam espera crescente, limitada a seis tentativas; respostas HTTP 429 respeitam `Retry-After`. Respostas 403, desafios Cloudflare e limites sem prazo informado pausam a coleta sem insistir. A extensão não tenta resolver desafios nem alterar o endereço de rede.

O caminho manual continua disponível: exporte o snapshot completo da extensão e use `npm run liga:import-browser -- <arquivo-exportado>`, `npm run liga:import-snapshot` e `npm run validate`.

A coleta da interface pode levar vários dias porque visita uma impressão por vez; a extensão salva o progresso localmente e no GitHub a cada 100 cartas ou 10 minutos, o que ocorrer primeiro. Em outro computador, atualize o repositório local e reinicie `npm run liga:sync-server`; depois abra a extensão e clique em **Retomar checkpoint do GitHub**. Ela carrega a fila e continua na primeira carta ainda não salva. Os lotes ficam em `data/ligapokemon-browser-checkpoints/` e o índice de retomada em `data/ligapokemon-browser-progress.json`. Ela lê anúncios renderizados na Liga, sem API paga, proxy ou solucionador de desafios. Os anúncios usados podem ter até 30 dias para permitir completar a varredura. Para publicar por GitHub Actions, mantenha os snapshots em `data/ligapokemon-edition-index.json`, os checkpoints e `data/ligapokemon-offers.json`, depois execute **Actions → Atualizar preços pelos anúncios da Liga → Run workflow**. O workflow não usa `REEF_API_KEY` nem fontes de preço alternativas.

O resumo do preço é a mediana do menor anúncio M/NM de cada vendedor distinto; com um único vendedor, o valor publicado é o anúncio dele. Ao finalizar localmente, os shards substituem os preços antigos por dados recém-lidos da Liga; variantes sem vínculo aparecem em `output/unmatched-cards.json` e permanecem sem preço.

**Estado dos dados publicados:** cada checkpoint substitui os anúncios das cartas já relidas, mantém anúncios válidos das demais e atualiza o banco pelo GitHub Actions. A data em `output/status.json` (`generatedAt`) identifica o último processamento publicado; o POKECARD a exibe no painel Pokémon Price Database Brasil.
