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

## 5. Deteção de Duplicados e Fraude

Cruzamento de dados históricos para detetar submissões duplicadas (mesmo comerciante, data e valor exatos) e identificar valores anómalos (ex: um bife a 450€ num talho) através de regras combinadas com análise contextual da IA.

- **Conceito de IA:** Matching determinístico + análise contextual do modelo.
- **O que aprendes:** Separar o que é regra (chaves de deduplicação, limiares por categoria) do que exige julgamento do modelo, e desenhar uma resposta que justifique cada suspeita em vez de apenas a sinalizar.

## 6. Geração de Insights e Resumos em Texto

Adicionar um endpoint `/insights` que recebe um intervalo de datas e usa a IA para redigir um relatório analítico sobre os hábitos de consumo (ex: "Notou-se um aumento de 30% em transportes devido a viagens em portagens...").

- **Conceito de IA:** Sumarização e geração de texto a partir de dados agregados.
- **O que aprendes:** Agregar os dados em SQL antes de os dar ao modelo (em vez de lhe enviar recibos em bruto), controlar o formato e o tom do relatório por prompt, e evitar que o modelo invente números que não estão nos agregados.
