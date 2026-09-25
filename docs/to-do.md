# To do list

## 1. Deteção de Anomalias e Alertas — ✅ feito

Pede ao modelo para analisar a despesa em relação a um contexto ou conjunto de regras e identificar potenciais irregularidades.

- **Conceito de IA:** Análise de contexto e raciocínio lógico (chain-of-thought leve).
- **O que aprendes:** Adicionar campos no JSON de resposta como `is_suspicious` (boolean) e `flag_reason` (string) — por exemplo, detetar valores atipicamente altos para a categoria, recibos emitidos ao fim de semana ou produtos que não correspondem à categoria habitual.
- **Como ficou implementado:** três campos no fim do `RECEIPT_JSON_SCHEMA` (`anomaly_evidence` → `is_suspicious` → `flag_reason`, por esta ordem, para o modelo raciocinar antes de decidir). As verificações semânticas (preço atípico, item que não encaixa no comerciante, total que não reconcilia, total ou data em falta) estão no prompt; o fim de semana é calculado em `src/claude/anomaly.ts` a partir da data extraída e unido ao veredicto, porque modelos erram aritmética de calendário. Persistido nas colunas `is_suspicious` / `flag_reason` e devolvido pelos dois endpoints. O eval passou a pontuar a flag nos casos com `expected_suspicious`.

## 2. Normalização e Enriquecimento de Dados

Muitas vezes o nome do comerciante no recibo é um nome fiscal obscuro (ex: "SOCIEDADE X LDA" em vez de "Supermercado X").

- **Conceito de IA:** Entity Resolution e uso de ferramentas externas (Function Calling / Tools).
- **O que aprendes:** Permitir que a IA pesquise ou mapeie o nome fiscal para a marca comercial conhecida, identifique o número de contribuinte (NIF/NIPC) e valide a taxa de IVA aplicada.

## 3. Normalização Multi-Moeda — ✅ feito

Se o recibo for de uma viagem e estiver noutra moeda (USD, GBP, JPY), a API pode converter automaticamente o valor para EUR.

- **Conceito de IA:** Function Calling (Chamada de Funções).
- **O que aprendes:** Ensinar o modelo de IA a decidir quando precisa de chamar uma API externa de taxas de câmbio em tempo real para calcular o valor convertido antes de devolver a resposta final.
- **Como ficou implementado:** **sem** function calling, de propósito. Saber se é preciso converter é `currency !== 'EUR'` — uma pergunta que o código responde, e perguntar ao modelo só acrescentava custo e uma forma de errar (a mesma lógica do fim de semana em `anomaly.ts`). `FxService.rateToEur` (`src/receipts/fx.service.ts`) vai buscar a taxa de referência do BCE à Frankfurter (grátis, sem chave, com o `fetch` do Node) **para a data do recibo**, não a de hoje — uma viagem em março converte à taxa de março. Corre em paralelo com as verificações de histórico dentro de `extractInto`, por isso as três vias ficam cobertas. Três colunas novas no bloco `ALTER` (`total_eur`, `fx_rate`, `fx_date`), todas nuláveis: uma falha da API de câmbio deixa-as a `null` em vez de falhar o recibo. `total_eur` é calculado em SQL, em NUMERIC. O `/insights` ganhou `months_eur`, a única soma entre moedas, feita pelo SQL e não pelo modelo. O function calling a sério fica para o #9, onde o modelo tem mesmo de escolher argumentos a partir de linguagem natural.

## 4. Pesquisa Semântica com Embeddings

Gerar vetores a partir da descrição ou notas dos recibos e guardá-los numa base de dados com suporte vetorial (como PostgreSQL com `pgvector`), permitindo consultas em linguagem natural do tipo "quanto é que gastei em jantares de equipa nos últimos 3 meses?".

- **Conceito de IA:** Embeddings e retrieval semântico (RAG).
- **O que aprendes:** Gerar e armazenar embeddings, escolher a métrica de distância e indexação adequadas, e traduzir uma pergunta em linguagem natural numa pesquisa vetorial combinada com filtros SQL (datas, categorias, valores).

## 5. Deteção de Duplicados e Fraude — ✅ feito

Cruzamento de dados históricos para detetar submissões duplicadas (mesmo comerciante, data e valor exatos) e identificar valores anómalos (ex: um bife a 450€ num talho) através de regras combinadas com análise contextual da IA.

- **Conceito de IA:** Matching determinístico + análise contextual do modelo.
- **O que aprendes:** Separar o que é regra (chaves de deduplicação, limiares por categoria) do que exige julgamento do modelo, e desenhar uma resposta que justifique cada suspeita em vez de apenas a sinalizar.
- **Como ficou implementado:** duas consultas SQL em `ReceiptsRepository.findHistory`, corridas entre a extração e a persistência, e avaliadas por funções puras em `src/receipts/history-anomalies.ts`. (1) **Duplicados:** chave exata — comerciante (aparado e sem distinção de maiúsculas), data, total e moeda — sobre as linhas `completed`; o id do recibo anterior fica na nova coluna `duplicate_of` e a frase diz "possible duplicate", não veredicto, porque duas compras legítimas podem partilhar a chave. Chave incompleta → nenhuma pesquisa. (2) **Limiares por categoria:** em vez de uma tabela fixa, o limiar vem do histórico — percentil 90 dos totais por categoria, com mínimo de `MIN_CATEGORY_SAMPLE` recibos anteriores e comparação contra a categoria mais cara do recibo, para que um supermercado com um portátil não seja julgado pelo preço da comida. O julgamento contextual continua no modelo (#1) e os veredictos unem-se em `unionAnomalies`, reaproveitado do teste de fim de semana. Índices para as duas consultas ficaram no bloco `ALTER`/`CREATE INDEX` de `DatabaseService.migrate()`.

## 6. Geração de Insights e Resumos em Texto — ✅ feito

Adicionar um endpoint `/insights` que recebe um intervalo de datas e usa a IA para redigir um relatório analítico sobre os hábitos de consumo (ex: "Notou-se um aumento de 30% em transportes devido a viagens em portagens...").

- **Conceito de IA:** Sumarização e geração de texto a partir de dados agregados.
- **O que aprendes:** Agregar os dados em SQL antes de os dar ao modelo (em vez de lhe enviar recibos em bruto), controlar o formato e o tom do relatório por prompt, e evitar que o modelo invente números que não estão nos agregados.
- **Como ficou implementado:** `GET /api/insights?from=&to=`. Duas consultas agregadas em `ReceiptsRepository.spendingSummary` — totais por categoria e por mês, ambas agrupadas também por moeda para nunca somar EUR com USD — e `renderSummary` em `src/receipts/spending-summary.ts` transforma-as no bloco de texto entregue ao modelo. O modelo nunca vê recibos, só os totais. Duas notas viajam no próprio bloco, porque são propriedades daqueles números e não da tarefa: os totais por mês contam cada recibo uma vez e podem ser somados, os por categoria sobrepõem-se (um recibo com duas categorias conta por inteiro em ambas) e não podem. O prompt proíbe inventar ou extrapolar números e obriga a separar moedas. A resposta devolve o relatório *e* os agregados, para que qualquer frase seja verificável. Um período sem recibos `completed` devolve uma frase fixa sem gastar tokens. Chamada em texto simples (`messages.create`, sem schema), a reutilizar o mesmo mapeamento de erros das extrações.

## 7. Recibos em Fotografia (input multimodal) — ✅ feito

Hoje só entram dois formatos: texto colado (`raw_text`) e PDF. Falta o caso mais comum na vida real — a fotografia tirada com o telemóvel ao talão de papel. O modelo lê imagens diretamente, sem OCR à parte: a foto segue na chamada como um bloco de conteúdo do tipo `image`, tal como o PDF já segue como `document`.

- **Conceito de IA:** Input multimodal (visão) e robustez a entradas degradadas.
- **O que aprendes:** Que um modelo moderno dispensa uma biblioteca de OCR — a imagem vai em bruto e a extração é a mesma. E, mais importante, aprendes a medir onde é que ela parte: basta acrescentar ao eval casos com talões amarrotados, desfocados, tirados de lado ou com o fim do papel cortado, e comparar com os mesmos recibos em texto limpo. A diferença entre as duas pontuações é o custo real de aceitar fotografias.
- **Como ficou implementado:** `POST /api/parse-receipt-image` (multipart `file`, JPEG/PNG/WebP/GIF até 10 MB). A foto segue como bloco `image` em `ClaudeService.extractReceiptFromImage`, construída pelo mesmo `requestExtraction` das outras duas vias — só mudam o prompt e os blocos de conteúdo — e tudo o que vem depois (verificações de histórico, persistência, ligação de categorias, `markFailed`, forma da resposta) é o `extractInto` já existente. O prompt novo é o mesmo `PROMPT_BODY` com um `PROMPT_INTRO.image` que nomeia a degradação esperada (amarrotado, desfocado, de lado, mal iluminado, cortado no fim do rolo) e repete a regra do PDF: ler o que é legível e deixar o campo a `null` em vez de adivinhar. **Não precisou de migração** — `raw_text` já era nulável e `source_type` é `VARCHAR(10)`, pelo que `'image'` cabe; `createPendingPdf` passou a `createPendingUpload`, com o tipo de origem como parâmetro.
  A validação dos dois ficheiros ficou num único `upload.validation.ts` em vez de uma segunda cópia quase igual da do PDF, com uma tabela de assinaturas (JPEG, PNG, GIF87a/89a e WebP, esta última verificada nas duas metades, `RIFF` e `WEBP`, para não confundir um WAV com uma imagem). O detalhe que importa: `validateImageUpload` devolve `{ file, mediaType }` e **o media type é lido dos bytes, nunca do `mimetype` declarado pelo cliente** — é reenviado tal e qual no bloco `image`, e um ficheiro mal rotulado voltaria como um 400 opaco do upstream. O tipo `ImageMediaType` vem do SDK, não de uma união escrita à mão, e `imageMediaType(buffer)` é exportada como função pura para o eval farejar os seus próprios ficheiros com o mesmo código da produção.
  No eval, um caso passou a carregar `raw_text` **ou** `image`, e um caso de imagem com `same_as` a apontar para o caso em texto limpo do mesmo recibo é comparado com ele na secção `=== Photo vs text ===`: exact-set match e micro-F1 de cada lado e o delta entre os dois — que é o número que esta feature existe para produzir. Um caso de imagem sem ficheiro é **ignorado**, não falhado: fica fora de todas as métricas e é contado à parte, pelo que `eval/images/` vai vazia (com um README a explicar o que fotografar e como estragar a foto) e o eval continua verde num clone novo. Fotografias não se inventam: uma imagem renderizada a partir do texto mediria a rasterização das letras, não o que uma câmara faz ao papel térmico, e daria uma pontuação lisonjeira. **O delta só passa a ser real quando houver fotos verdadeiras em `eval/images/`.**

## 8. Avaliação do Relatório de Insights

O `/insights` (#6) não tem nenhuma medida de qualidade. Os testes cobrem a renderização dos agregados, mas ninguém verifica o texto que o modelo escreve a partir deles — ou seja, a parte que pode estar errada. Avaliar texto livre é diferente de avaliar categorias: não há uma resposta certa única para comparar.

- **Conceito de IA:** Avaliação de output não-determinístico — verificação de fundamento (*groundedness*) e LLM-as-judge.
- **O que aprendes:** Que a avaliação se faz em duas camadas e a primeira não custa tokens nenhuns. **Camada 1 (determinística):** extrair com uma expressão regular todos os números que aparecem na prosa e confirmar que cada um existe nos agregados que o modelo recebeu; um número inventado é um teste que falha, sem chamar a API. **Camada 2 (LLM-as-judge):** uma segunda chamada ao modelo, com os agregados e o relatório, a pontuar o que a regex não vê — se as conclusões se sustentam, se o tom é adequado, se ficou alguma observação útil por dizer. A lição é a ordem: só se paga um juiz para aquilo que não se consegue verificar de graça.

## 9. Consultas em Linguagem Natural sobre o Histórico — ✅ feito

Permitir perguntas como "quanto gastei em jantares nos últimos 3 meses?" sem instalar `pgvector` (#4). Em vez de traduzir a pergunta num vetor, define-se uma *ferramenta* que o modelo pode chamar — por exemplo `query_receipts`, com parâmetros fixos (datas, categorias, intervalo de valores) — e é ele que decide quais os argumentos a preencher a partir da pergunta.

- **Conceito de IA:** Function Calling com uma ferramenta de consulta ao nosso próprio sistema.
- **O que aprendes:** A desenhar a superfície da ferramenta, que é onde está a segurança: o modelo escolhe os *argumentos*, nunca escreve o SQL. A consulta continua a ser a nossa, parametrizada, no `ReceiptsRepository`, e argumentos fora do esperado são rejeitados antes de chegarem à base de dados. Aprendes também a ler o ciclo de tool use (o modelo responde a pedir a ferramenta, nós executamos e devolvemos o resultado, ele escreve a resposta final). Como cobre uma boa parte do que o #4 promete a uma fração do custo, serve de termo de comparação honesto se mais tarde implementares mesmo os embeddings.
- **Como ficou implementado:** `POST /api/ask` (JSON `question`). Uma única ferramenta, `query_receipts`, declarada `strict: true` em `claude.service.ts`, com filtros fixos — período, categorias (o próprio `enum` de `CATEGORIES`), parte do nome do comerciante e intervalo de totais — todos obrigatórios e nuláveis, para que "sem filtro" seja um `null` explícito. O ciclo de tool use está escrito à mão em `ClaudeService.answerQuestion` (e não com o tool runner do SDK, porque ler o ciclo é o objetivo): o modelo responde `tool_use`, executamos, devolvemos `tool_result`, repete-se até `end_turn`, com um limite de `MAX_ASK_CALLS` chamadas. O `ClaudeModule` não conhece a base de dados — recebe um callback `runQuery` que o `ReceiptsService.ask` fornece. Aí, `parseQueryArgs` (`src/receipts/receipt-query.ts`) volta a validar os argumentos mesmo com `strict` (datas reais, intervalo ordenado, categorias conhecidas, sem chaves a mais); um argumento inválido volta ao modelo como `tool_result` com `is_error`, para ele se corrigir, e nunca chega ao SQL. A consulta em `ReceiptsRepository.queryReceipts` é uma só instrução fixa, parametrizada, com cada filtro opcional escrito como `$n IS NULL OR ...`; o filtro de categorias é um `EXISTS` e não um join, para um recibo com duas categorias contar uma vez — ao contrário dos totais por categoria do `/insights`. Agrupa por moeda e devolve também `total_eur`. A data de hoje vai na mensagem do utilizador, não no prompt de sistema, para "os últimos 3 meses" se resolver sem que o prefixo varie. A resposta devolve, além do texto, todas as chamadas feitas (argumentos e resultado, ou o erro de validação), para que qualquer número seja verificável.

## 10. Citações no PDF

Fazer com que cada afirmação da extração aponte para o sítio exato do documento de onde saiu — página e excerto — ativando `citations` no bloco `document` que já enviamos. Encaixa no tema que atravessa o projeto: tudo o que a API afirma deve ser verificável contra o que o modelo viu.

- **Conceito de IA:** *Grounding* — ancorar a resposta em evidência localizável na fonte.
- **O que aprendes:** Que citações e saída estruturada não vêm juntas de graça: ativar `citations` com `output_config.format` devolve erro 400, porque a resposta passa a ser partida em blocos de texto com referências em vez de um JSON único. Obriga a escolher — abdicar do esquema, ou fazer uma segunda chamada só para as citações — e essa escolha, com o custo de cada lado, é a verdadeira lição. Sem isto fica a impressão errada de que se pode acumular funcionalidades da API sem que nenhuma se atrapalhe.

## 11. Redução de Custo: Batch e Cache de Prompt

Duas otimizações que só fazem sentido depois de haver volume, e que se medem em vez de se assumirem. A **Batch API** processa pedidos em lote, de forma assíncrona, por metade do preço — serve para reprocessar recibos antigos ou correr o eval, nunca para responder a um pedido HTTP em tempo real. O **cache de prompt** guarda o prefixo constante da chamada (o nosso `PROMPT_BODY`, que não muda entre recibos) para não voltar a pagá-lo por inteiro.

- **Conceito de IA:** Economia de inferência — processamento assíncrono e reutilização de prefixo.
- **O que aprendes:** No batch, que os resultados chegam **fora de ordem** e têm de ser associados pelo `custom_id` que enviámos, nunca pela posição na lista — assumir a ordem é o erro clássico e só aparece em produção. No cache, que a poupança se confirma olhando para `usage.cache_read_input_tokens` na resposta: se vier a zero em chamadas seguidas, ou algo no prefixo está a variar (uma data, um id), ou o prefixo é simplesmente curto demais — há um mínimo de tokens abaixo do qual o cache não é criado, e o nosso prompt pode ficar aquém dele. Perceber *porque* é que não pegou vale mais do que a poupança em si.
