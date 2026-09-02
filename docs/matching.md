# Correspondência inteligente (fase 4) — Groq + Preço da Hora

Referência de `src/lib/llm/**`, `POST /api/precos/atualizar`, `POST /api/precos/match` e do script de avaliação
`scripts/match-eval.mjs`. Contrato em `SPEC-fase4.md`; tabela `item_matches` e `best_prices` na migration 0003.

## TL;DR

- Duas chamadas ao Groq por atualização: `planSearches` (uma para todos os itens: termo de busca + palavras que
  desqualificam) e `judgeMatches` (uma por item: quais descrições devolvidas pelo Preço da Hora são o produto).
  Veredictos ficam em `item_matches` (`source='llm'`); o usuário corrige pela tela (`source='user'`, prevalece).
- **Modelo default: `openai/gpt-oss-120b` com `reasoning_effort: low`** (não o `gpt-oss-20b` do SPEC). Na avaliação
  real, o 20b em `low` aceitou leite em pó e "ADICIONAL LEITE 200ML" como "leite integral" e, em `medium`, gastou
  4 194 tokens de raciocínio num item só — inviável no plano gratuito. O 120b em `low` acertou os casos difíceis com
  ~700 tokens de saída. `GROQ_MODEL` e `GROQ_REASONING_EFFORT` (`none|default|low|medium|high|model`) sobrescrevem.
- **Restrição dura do plano gratuito do Groq: 8 000 tokens/min por modelo, contando `prompt + max_tokens`** (o 413
  "Request too large" aparece quando `max_tokens` é alto demais, mesmo sem uso). Uma chamada do juiz custa ~2 000 de
  entrada + ~700 de saída ⇒ **2 a 3 itens julgados por minuto**. A rota serializa as chamadas do juiz, respeita
  `retry-after` (até 30 s) e, se estourar, segue sem juiz (`semJuiz: true`); o que já foi julgado fica cacheado e a
  próxima atualização só julga descrições novas.
- **Restrição dura do Preço da Hora: bloqueio (captcha) após ~20 POSTs em ~10–15 min do mesmo IP.** Com
  `maxResultados: 60` cada item custa 3 POSTs (páginas de 25). Uma lista com mais de ~6 itens vai ser bloqueada no
  meio da atualização (a rota para e reporta em `falhas`). Ver "Pendências".
- Parte da inteligência é determinística (não depende do modelo): exclusões universais de uso animal, sanitização
  das exclusões, propagação de rejeição por GTIN, filtro por palavra excluída.

## Módulos

### `src/lib/llm/groq.ts`
`chatJson<T>()` / `chatJsonWithMeta<T>()` — POST em `https://api.groq.com/openai/v1/chat/completions` com
`response_format: {type:"json_object"}`, `temperature` 0, timeout 20 s (AbortController), **1 retry em 429/5xx**
esperando `retry-after` (ou 1 s; desiste se pedir > 30 s). `LlmError.kind`: `rate_limit` | `timeout` | `network` |
`invalid_json` (inclui o 400 `json_validate_failed`, cujo `failed_generation` vai na mensagem) | `api`.
`retryAfterMs` fica no erro. O `fetch` nativo; `GROQ_API_KEY` só no servidor.

Detalhes observados na API: os gpt-oss devolvem o raciocínio em `message.reasoning` (fora do `content`, que é JSON
puro), mas **os tokens de raciocínio contam em `completion_tokens` e no `max_tokens`** — por isso o `max_tokens`
baixo demais trunca o JSON (400 `json_validate_failed`) e alto demais dá 413 pelo TPM.

### `src/lib/llm/similarity.ts`
`diceSimilarity(a, b)` — Dice de bigramas de caracteres sobre `normalizeName`, com espaço nas bordas como o pg_trgm.
Só para priorizar candidatos quando há mais de 40 (não replica o `similarity()` do Postgres).

### `src/lib/llm/matching.ts`
- `planSearches(items)` → `Record<id, { termo, excluir[], observacao? }>`. Uma chamada; `reasoning_effort: low`;
  itens que o modelo não devolver ficam de fora (a rota usa `termo = nome`, `excluir = []`).
  Pós-processamento determinístico:
  - `sanitizeExclusions`: descarta exclusões que compartilham palavra com o termo ou com o nome do item (o 120b
    devolveu `"papel higienico"` e `"papel toalha"` como exclusões de "Papel higiênico 12 rolos" — teria zerado
    a busca) e acrescenta `UNIVERSAL_EXCLUDE` (`racao caes cao cachorro(s) gato(s) pet puppy canino felino`) a menos
    que o item mesmo seja de pet. Motivo: o 20b/120b às vezes "esquecem" as palavras de ração para arroz (saída
    varia entre chamadas mesmo com `temperature: 0`).
- `judgeMatches(item, candidates)` → `{ description, isMatch, reason }[]`. `selectCandidates` deduplica por
  `normalizeName` e, acima de 40, fica com os 20 mais baratos + os mais parecidos (Dice). O prompt recebe uma lista
  numerada `n. DESCRIÇÃO — R$ menor preço` (sem GTIN: não ajuda o juiz e custa tokens) e devolve
  `{"resultados":[{"n","corresponde","motivo"}]}` — **desvio deliberado do SPEC** (`descricao` na saída dobraria os
  tokens de saída); a `descricao` é aceita se vier, e o mapeamento é por `n`. Entradas sem `n` válido ou sem booleano
  são descartadas; descrições sem veredicto ficam sem linha em `item_matches` (caem na regra por nome do
  `best_prices`).
- `findExcludedWord(normalizedDescription, excluir)` — casa palavra inteira (`" po "`), não substring (`"pote"` não
  cai em `"po"`); exclusões de mais de uma palavra funcionam como frase.

### Decisões de prompt (o que fez diferença)
1. **Tamanho no termo de busca.** O Preço da Hora casa substrings e devolve os 60 mais baratos: "arroz" traz sachês
   de ração e "cafe" traz balas de café (R$ 0,15) e o produto real nem aparece. `"arroz 5kg"` casa `5KG` (mas
   `"arroz 5 kg"` só casa `5 KG` — 2 resultados); `"papel higienico 12"` casa `12 ROLOS`, `12 RL` e `12/11`. O prompt
   explica isso ao planejador e pede forma compacta (`5kg`, `500g`, `1l`) e só o número para contagens.
2. **Exclusões por família de falso positivo** (uso animal, doces, variantes: milho/cevada/solúvel/cápsula para café;
   pó/condensado/coco para leite; margarina para manteiga), com a contra-regra de não excluir palavras legítimas
   (`parboilizado`, `integral`, `uht`, `1l`).
3. **Juiz com regras por família e sinais textuais**: leite integral em GRAMAS/"sachê"/"lata" = leite em pó; itens
   de serviço (ADICIONAL, PORÇÃO, DOSE, COPO) não correspondem; `FORA DO TIPO`, `QUIRERA`, `P/ CAES`, `PUPPY` e marcas
   regionais de arroz para cães (MATILHA, BONE, AMIGACO, PARBOR) são uso animal; tamanho só reprova se a descrição
   informa um tamanho diferente; marca só importa se o usuário escreveu marca.
4. **Preço como pista.** Cada candidato leva o menor preço; um "arroz 5 kg" a R$ 10,59 ou um "leite 1 L" a R$ 0,50
   é sinal de outro produto. Foi o que fez o 120b rejeitar `ARROZ PARB FORA DO TIPO 5KG` (R$ 10,59).
5. **Saída compacta** (`n`, booleano, motivo ≤ 6 palavras) — cortou ~50 % dos tokens de saída.

### `POST /api/precos/atualizar`
`maxDuration = 120`, orçamento interno de 100 s (não começa item novo depois; não chama o juiz com < 12 s).
1. Lista → household (lat/lng; fallback centro de Salvador), itens não marcados, `item_matches` do household para as
   `item_key`s dos itens (mapa `item_key → description_key → {is_match, source, gtin}`).
2. `planSearches` para itens sem GTIN (falhou ⇒ `semJuiz`, termo = nome). Se `GROQ_API_KEY` não existe: `semJuiz`
   desde o início.
3. Pool de 3: `searchPrecoDaHora({ termo | gtin, raioKm 10, horas 72, maxResultados 60 })`. Bloqueio do Preço da
   Hora (`PdhError.blocked`) interrompe os demais itens.
4. Para itens por termo: descrições distintas (`normalizeName`) **sem veredicto cacheado** são separadas em
   (a) excluídas por palavra → veredicto `is_match=false` com motivo `Contém "x" (palavra excluída…)`;
   (b) mesmo GTIN de uma descrição excluída/já rejeitada → `is_match=false` (`Mesmo código de barras de …`);
   (c) o resto vai ao juiz (chamadas serializadas por um lock; falha ⇒ `semJuiz`, o item fica sem veredicto novo).
   Upsert em `item_matches` com `onConflict: "household_id,item_key,description_key"`, **sem incluir chaves cujo
   veredicto cacheado é `source='user'`** (o trigger do banco também protege). Itens por GTIN não passam pelo juiz
   (`best_prices` já casa por `gtin`/`product`).
5. `price_observations` para TODOS os resultados (dedupe por loja+gtin+descrição+data; 23505 ignorado), inclusive os
   não correspondentes — são preços válidos de outros produtos.
6. `{ ok, itens, observacoes, correspondencias, semJuiz, falhas }`. `correspondencias` = nº de pares (item, descrição
   retornada nesta atualização) com veredicto positivo (cacheado ou novo); itens por GTIN contam 1 se acharam preço.

### `POST /api/precos/match`
Body `{ itemName, description, gtin?, isMatch }` (validado; 400 se faltar/for de tipo errado). Exige login; household =
primeiro `household_members` do usuário (mesma regra das páginas). Upsert `source='user'`, `reason='Marcado pelo
usuário'`, `item_key = normalizeName(itemName)`, `description_key = normalizeName(description)`. Resposta `{ ok: true }`.

## Avaliação real — `scripts/match-eval.mjs`

```
pnpm dlx tsx scripts/match-eval.mjs [--items "A,B"] [--raio 10] [--horas 72] [--max 60] [--pausa 3000] [--cache DIR]
GROQ_MODEL=… GROQ_REASONING_EFFORT=… pnpm dlx tsx scripts/match-eval.mjs …   # comparar modelos
```
Sem Next e sem banco: importa os `.ts` via `tsx` (aliases `@/` do tsconfig), lê `.env.local`, busca em Salvador
(-12.9777, -38.5016), 10 km, 72 h, 60 resultados, aplica o mesmo pipeline da rota (plano → filtro por palavra → GTIN →
juiz) e imprime por item: termo, nº de resultados, lojas distintas, 5 correspondentes mais baratas e 3 rejeitadas com
motivo, mais tokens/latência de cada chamada. `--cache DIR` guarda as respostas do Preço da Hora por termo para
iterar nos prompts sem repetir buscas (e sem tomar captcha). Precisa de IP residencial.

### Rodada final (02/09/2026, `openai/gpt-oss-120b`, `reasoning_effort: low`)

Plano (1 chamada, ~1 000 tokens de entrada / ~250 de saída, ~1 s):

| Item | termo | excluir (além das universais de pet) |
|---|---|---|
| Leite integral | `leite integral` | po, condensado, coco, fermentado, soja, achocolatado |
| Arroz 5kg | `arroz 5kg` | farinha, creme (+ bala/caramelo numa das rodadas) |
| Café 500g | `cafe 500g` | soluvel, capsula(s), cappuccino, filtro, milho, cevada, bala(s), caramelo, bombom, biscoito |
| Manteiga | `manteiga` | margarina, cacau, karite, amendoim, bala(s), caramelo, bombom, biscoito, sorvete |
| Papel higiênico 12 rolos | `papel higienico 12` | toalha, guardanapo, lenco (o modelo também mandou "papel higienico"/"papel toalha" — removidas pela sanitização) |

**Leite integral** — 60 resultados, 52 lojas; 5 descrições excluídas por "po"/"condensado"; 38 ao juiz
(2 002 in / 703 out tokens, 1,9 s): 35 correspondem, 3 rejeitadas, 43 lojas com produto correspondente.
```
+ R$ 3,89  LEITE COTOCHES UHT INTEGRAL LONGA VIDA 1LT   ok
+ R$ 4,99  LEITE BETANIA INTEGRAL 1L                    ok
+ R$ 5,00  LEITE VALEDOURADO INTEGRAL 1LT               ok
+ R$ 5,50  LEITE UHT INTEGRAL BETANIA 1LT               ok
+ R$ 5,50  LEITE SABE INTEGRAL                          ok
- R$ 4,99  LEITE INTEGRAL BIG LEITE 120G                leite em pó
- R$ 5,00  ADICIONAL LEITE INTEGRAL 200ML NINHO         adicional
- R$ 5,90  LEITE INTEGRAL PORCAO 200ML                  porção
```
Correto. (O `gpt-oss-20b` aceitou as três rejeitadas em todas as rodadas, em `low` e em `medium`.)

**Arroz 5kg** — 60 resultados, 54 lojas; 23 excluídas ("caes", "cao", "puppy", "racao"…); 11 ao juiz
(1 421 in / 419 out): 9 correspondem, 2 rejeitadas.
```
+ R$ 18,90  ARROZ MIROKU CURTO 5KG                        ok
+ R$ 23,80  ARROZ CRAVIL 5KG                              ok
+ R$ 24,49  … (Camil, Tio João etc.)
- R$ 10,59  ARROZ PARB FORA DO TIPO 5KG CRAVIL 1X5KG       fora do tipo
- R$ 63,63  ARROZ PARB FORA DO TIPO 5KG CRAVIL 6X1X5KG     fora do tipo
```
Erro do juiz (todos os modelos): aceitou `ARROZ MATILHA 5KG` / `ARROZ MATILHA PARB 5KG` / `ARROZ PARBO MATILHA 5KG`
(R$ 19,99–23,99), que é arroz para cães — mesmo com a marca citada no prompt. Solução determinística: os três
têm o **mesmo GTIN (7896384100121)** de `ARROZ P/ CAES MATILHA 5KG`, que foi excluída por "caes"; a rota (e o
script) rejeitam por GTIN antes do juiz. Com o termo antigo (`arroz`, sem tamanho) os 60 mais baratos eram sachês
de ração e balas — nenhum arroz de 5 kg aparecia.

**Café 500g, Manteiga, Papel higiênico 12 rolos** — ver seção abaixo (rodada separada por causa do bloqueio do
Preço da Hora).

<!-- RODADA_FINAL_3 -->

### Modelos comparados (mesmos candidatos em cache)

| Modelo / esforço | Leite (38 cand.) | Arroz (11 cand.) | Tokens juiz leite (in/out) |
|---|---|---|---|
| gpt-oss-20b / low | aceita pó 120G, ADICIONAL, PORÇÃO; arroz: rejeitou TODOS com motivo sem sentido numa rodada | ruim | 2 002 / 624 |
| gpt-oss-20b / medium | ainda aceita pó 120G; rejeita ADICIONAL/PORÇÃO | ok | 2 002 / **4 194** (estoura TPM) |
| **gpt-oss-120b / low** | correto | correto (exceto MATILHA, resolvido por GTIN) | 2 002 / 703 |
| qwen/qwen3.8-27b / none | correto | correto (idem) | 2 014 / 617 |
| llama-3.x | não disponível nesta conta (404) | | |

`qwen3.8-27b` com `GROQ_REASONING_EFFORT=none` é uma alternativa equivalente e um pouco mais barata; não é o default
só por ser menos testado aqui (2 itens).

## Custo e latência por atualização

- Plano: ~1 000–1 100 tokens de entrada + 200–500 de saída, 0,6–1,4 s.
- Juiz: ~900 tokens de sistema + ~25 por candidato (≈2 000 para 38) + 400–700 de saída; 1–2 s de geração, mas o
  `queue_time` do plano gratuito chegou a 8–14 s.
- Lista de 5 itens, tudo novo: ~1 300 + 5 × ~2 500 ≈ **14 000 tokens** ⇒ ~2 min no limite de 8 000 TPM. Na prática a
  rota julga 3–4 itens na primeira atualização (os outros ficam `semJuiz`/sem veredicto novo) e completa nas próximas,
  porque só descrições novas voltam ao juiz. Custo em dinheiro: R$ 0 (free tier); no Dev Tier (~US$ 0,15/M in,
  0,60/M out para o 120b) uma atualização de 5 itens custaria ~US$ 0,003.
- Preço da Hora: 2–6 s por item (3 páginas). É o gargalo de tempo e o risco de bloqueio.

## Pendências / riscos
1. **Bloqueio do Preço da Hora por volume.** Observado 3 vezes nesta sessão: após ~12 POSTs em rajada e após ~20 em
   10 min; o bloqueio durou > 15 min. `maxResultados: 60` triplica as chamadas da fase 3. Sugestões (fora da minha
   área/decisão de produto): 25–50 resultados quando o termo já tem tamanho; pausa entre itens; ou uma fila/cron
   que atualiza poucos itens por vez.
2. **TPM do Groq.** Se a lista cresce, considerar Dev Tier, ou reduzir o prompt de sistema do juiz (~900 tokens),
   ou julgar em lotes menores só quando sobrar orçamento.
3. Sem retry em `timeout`/`network` (só 429/5xx), por decisão de orçamento de tempo.
4. `correspondencias` conta pares (item, descrição), não lojas; a tela mostra lojas via `best_prices`.
5. Verificar em produção (Vercel) se o IP de datacenter passa no Preço da Hora — problema já conhecido da fase 3.
