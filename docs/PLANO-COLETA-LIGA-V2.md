# Plano da nova coleta de preços da Liga Pokémon

## Estado inicial

- O catálogo TCGdex contém 37.054 cartas e 101.169 variantes.
- O mapa existente cobre 813 edições e uma fila de 19.748 cartas elegíveis na Liga.
- O snapshot anterior tinha 9.904 anúncios e preços para 895 variantes. Ele foi preservado no tag Git `prices-before-liga-reset-2026-11-23`.
- O reset remove os preços e anúncios ativos, mas mantém o catálogo, o mapa de edições e a fila de cartas. A coleta recomeça na fila existente, sem redescobrir as 813 edições.

## Como a extensão deve coletar

1. Ao retomar do GitHub, baixar a fila e o checkpoint vazios da nova rodada. Importar novamente a fila apaga o estado local de coleta anterior; a lista local de cartas do usuário continua guardada separadamente para priorização.
2. Priorizar as cartas presentes no backup da coleção. Em seguida, percorrer todas as demais cartas elegíveis, sem alterar o identificador ou a numeração da fila.
3. Ler somente páginas normais da Liga, com intervalo aleatório de 5 a 10 segundos entre páginas. Respeitar `Retry-After`. Em bloqueio, desafio, HTTP 403 ou HTTP 429 sem prazo de retomada, parar e aguardar ação manual; não usar proxies, solucionadores, mascaramento ou chamadas a rotas privadas.
4. Classificar cada resultado como: lido com anúncios, lido sem anúncios, falha temporária, bloqueio que exige ação manual ou linha incompleta para revisão. Uma linha incompleta deve ser guardada em quarentena com o texto e os campos presentes, sem interromper o restante da fila nem contar como preço válido.
5. Repetir falhas temporárias com limite e espera crescente. Não repetir automaticamente uma verificação de segurança nem continuar insistindo depois de uma negativa explícita da Liga.
6. Enviar checkpoints idempotentes ao GitHub a cada 100 cartas ou 10 minutos, o que ocorrer primeiro. Reabrir a extensão ou mudar de computador deve retomar pelo último checkpoint confirmado no GitHub; capturas locais ainda não confirmadas ficam preservadas até o envio.
7. Ao receber uma carta novamente, substituir somente os anúncios daquela carta. Não reutilizar anúncios da rodada anterior nem preencher preços por outra fonte.

## Publicação e contadores

O painel da extensão deve distinguir cartas confirmadas no GitHub, cartas lidas com anúncios, cartas lidas sem anúncios, falhas temporárias e linhas em quarentena. O contador de progresso considera uma carta confirmada apenas depois que o checkpoint foi aceito pelo servidor e enviado ao repositório.

O processamento do Pokémon Price Database publica apenas preços que passaram pela correspondência exata de carta, idioma, versão, condição e vendedor. Uma ausência de anúncio permanece sem preço e disponível para filtragem como pendente. Cada snapshot informa a data da última coleta, a quantidade de cartas e anúncios cobertos e o número de linhas aguardando revisão.

## Retomada e validação operacional

- Piloto inicial: 30 cartas, incluindo cartas da coleção do usuário e páginas com idiomas, acabamentos e cartas sem anúncio diferentes.
- Conferir no banco se cada amostra mantém URL da Liga, vendedor, condição, idioma, acabamento e preço observados; confirmar também que uma página sem anúncios não cria preço.
- Só depois do piloto, continuar a fila completa. Os checkpoints incrementais permitem acompanhar o resultado antes do fim das 19.748 cartas.
- No fim, comparar totais da fila, cartas processadas, cartas sem anúncios, linhas em quarentena, anúncios válidos e variantes com preço; revisar manualmente a quarentena sem descartar capturas originais.

## Limite de automação

A extensão automatiza navegação e leitura de páginas acessíveis normalmente. Se a Liga apresentar um desafio ou negar acesso, a coleta pausa para resolução manual e só continua quando a página normal voltar.
