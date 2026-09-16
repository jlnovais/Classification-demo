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

## 3. Normalização Multi-Moeda

Se o recibo for de uma viagem e estiver noutra moeda (USD, GBP, JPY), a API pode converter automaticamente o valor para EUR.

- **Conceito de IA:** Function Calling (Chamada de Funções).
- **O que aprendes:** Ensinar o modelo de IA a decidir quando precisa de chamar uma API externa de taxas de câmbio em tempo real para calcular o valor convertido antes de devolver a resposta final.

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

## 7. Recibos em Fotografia (input multimodal)

Hoje só entram dois formatos: texto colado (`raw_text`) e PDF. Falta o caso mais comum na vida real — a fotografia tirada com o telemóvel ao talão de papel. O modelo lê imagens diretamente, sem OCR à parte: a foto segue na chamada como um bloco de conteúdo do tipo `image`, tal como o PDF já segue como `document`.

- **Conceito de IA:** Input multimodal (visão) e robustez a entradas degradadas.
- **O que aprendes:** Que um modelo moderno dispensa uma biblioteca de OCR — a imagem vai em bruto e a extração é a mesma. E, mais importante, aprendes a medir onde é que ela parte: basta acrescentar ao eval casos com talões amarrotados, desfocados, tirados de lado ou com o fim do papel cortado, e comparar com os mesmos recibos em texto limpo. A diferença entre as duas pontuações é o custo real de aceitar fotografias.

## 8. Avaliação do Relatório de Insights

O `/insights` (#6) não tem nenhuma medida de qualidade. Os testes cobrem a renderização dos agregados, mas ninguém verifica o texto que o modelo escreve a partir deles — ou seja, a parte que pode estar errada. Avaliar texto livre é diferente de avaliar categorias: não há uma resposta certa única para comparar.

- **Conceito de IA:** Avaliação de output não-determinístico — verificação de fundamento (*groundedness*) e LLM-as-judge.
- **O que aprendes:** Que a avaliação se faz em duas camadas e a primeira não custa tokens nenhuns. **Camada 1 (determinística):** extrair com uma expressão regular todos os números que aparecem na prosa e confirmar que cada um existe nos agregados que o modelo recebeu; um número inventado é um teste que falha, sem chamar a API. **Camada 2 (LLM-as-judge):** uma segunda chamada ao modelo, com os agregados e o relatório, a pontuar o que a regex não vê — se as conclusões se sustentam, se o tom é adequado, se ficou alguma observação útil por dizer. A lição é a ordem: só se paga um juiz para aquilo que não se consegue verificar de graça.

## 9. Consultas em Linguagem Natural sobre o Histórico

Permitir perguntas como "quanto gastei em jantares nos últimos 3 meses?" sem instalar `pgvector` (#4). Em vez de traduzir a pergunta num vetor, define-se uma *ferramenta* que o modelo pode chamar — por exemplo `query_receipts`, com parâmetros fixos (datas, categorias, intervalo de valores) — e é ele que decide quais os argumentos a preencher a partir da pergunta.

- **Conceito de IA:** Function Calling com uma ferramenta de consulta ao nosso próprio sistema.
- **O que aprendes:** A desenhar a superfície da ferramenta, que é onde está a segurança: o modelo escolhe os *argumentos*, nunca escreve o SQL. A consulta continua a ser a nossa, parametrizada, no `ReceiptsRepository`, e argumentos fora do esperado são rejeitados antes de chegarem à base de dados. Aprendes também a ler o ciclo de tool use (o modelo responde a pedir a ferramenta, nós executamos e devolvemos o resultado, ele escreve a resposta final). Como cobre uma boa parte do que o #4 promete a uma fração do custo, serve de termo de comparação honesto se mais tarde implementares mesmo os embeddings.

## 10. Citações no PDF

Fazer com que cada afirmação da extração aponte para o sítio exato do documento de onde saiu — página e excerto — ativando `citations` no bloco `document` que já enviamos. Encaixa no tema que atravessa o projeto: tudo o que a API afirma deve ser verificável contra o que o modelo viu.

- **Conceito de IA:** *Grounding* — ancorar a resposta em evidência localizável na fonte.
- **O que aprendes:** Que citações e saída estruturada não vêm juntas de graça: ativar `citations` com `output_config.format` devolve erro 400, porque a resposta passa a ser partida em blocos de texto com referências em vez de um JSON único. Obriga a escolher — abdicar do esquema, ou fazer uma segunda chamada só para as citações — e essa escolha, com o custo de cada lado, é a verdadeira lição. Sem isto fica a impressão errada de que se pode acumular funcionalidades da API sem que nenhuma se atrapalhe.

## 11. Redução de Custo: Batch e Cache de Prompt

Duas otimizações que só fazem sentido depois de haver volume, e que se medem em vez de se assumirem. A **Batch API** processa pedidos em lote, de forma assíncrona, por metade do preço — serve para reprocessar recibos antigos ou correr o eval, nunca para responder a um pedido HTTP em tempo real. O **cache de prompt** guarda o prefixo constante da chamada (o nosso `PROMPT_BODY`, que não muda entre recibos) para não voltar a pagá-lo por inteiro.

- **Conceito de IA:** Economia de inferência — processamento assíncrono e reutilização de prefixo.
- **O que aprendes:** No batch, que os resultados chegam **fora de ordem** e têm de ser associados pelo `custom_id` que enviámos, nunca pela posição na lista — assumir a ordem é o erro clássico e só aparece em produção. No cache, que a poupança se confirma olhando para `usage.cache_read_input_tokens` na resposta: se vier a zero em chamadas seguidas, ou algo no prefixo está a variar (uma data, um id), ou o prefixo é simplesmente curto demais — há um mínimo de tokens abaixo do qual o cache não é criado, e o nosso prompt pode ficar aquém dele. Perceber *porque* é que não pegou vale mais do que a poupança em si.
