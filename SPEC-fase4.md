# Fase 4 — Correspondência inteligente (Groq) e cobertura por loja

Problema observado em produção (fase 3): o cruzamento por similaridade de nome é ingênuo
("Arroz 5kg" casou com "ARROZ PARA CAES BONE 5KG"; "Café 500g" com "CAFE DE MILHO 500G") e cada item
ficou com preço de uma loja só (8 resultados/item ordenados por preço), então o resumo por loja não compara a lista.

Solução: um modelo de linguagem (Groq, plano gratuito, `GROQ_API_KEY` já em `.env.local` e na Vercel) faz duas coisas
com descrições REAIS devolvidas pelo Preço da Hora, nunca inventando códigos de barras:
1. **Termo de busca**: dado o item digitado, gera o termo de busca para o Preço da Hora e a lista de palavras que
   desqualificam (ex.: "ração", "cães", "milho" para café). Uma chamada para TODOS os itens da lista de uma vez.
2. **Juiz de correspondência**: dadas as descrições distintas retornadas, diz quais são o mesmo produto que o item
   (mesma categoria e tamanho compatível; marca livre a menos que o usuário tenha especificado). Uma chamada por item.
Os veredictos são cacheados em `item_matches`, e `best_prices` passa a usá-los. O usuário pode corrigir na tela.

Modelo: `openai/gpt-oss-20b` (rápido; suporta `response_format: { type: "json_object" }`). Endpoint OpenAI-compatível
`https://api.groq.com/openai/v1/chat/completions`. Sem SDK: `fetch` nativo. Fallback: se o Groq falhar/limitar,
segue sem juiz (similaridade), sem quebrar a atualização.

## Contrato já escrito
- `src/lib/database.types.ts`: tabela `item_matches` e `best_prices.match_kind` agora inclui `'llm' | 'user'`.

## Migration `supabase/migrations/0003_matches.sql`
- `item_matches(id uuid pk, household_id fk households cascade not null, item_key text not null, description_key text not null,
  gtin text, is_match boolean not null, source text not null check in ('llm','user'), reason text, created_at, updated_at)`.
  `item_key` = `normalize_name(nome do item)`, `description_key` = `normalize_name(descrição do Preço da Hora/cupom)`.
  Único `(household_id, item_key, description_key)`. Índice `(household_id, item_key)`. RLS: membro do household, CRUD.
  Um veredicto `source='user'` nunca é sobrescrito por `'llm'` (regra na rota, mas a migration pode incluir um trigger
  `before update` que ignora a mudança quando `old.source='user' and new.source='llm'`).
- `best_prices(p_list_id, p_max_age_hours)` recriada (mesma assinatura/colunas): para cada (item, observação):
  - se existe `item_matches` com `(household_id, item_key = li.normalized_name, description_key = po.normalized_name)`:
    `is_match=false` → EXCLUI; `is_match=true` → `match_kind = im.source` ('llm' ou 'user'), `score = 1.0`;
  - senão, regras atuais: gtin/product = 1.0; nome: `similarity >= 0.5` (subiu de 0.35) ou `like` → score = similarity, `match_kind='name'`.
  Mantém `distinct on (li.id, po.store_id)`, ordenação por score desc, observed_at desc.

## Módulo LLM `src/lib/llm/groq.ts`
- `chatJson<T>(opts: { system: string; user: string; maxTokens?: number; temperature?: number }): Promise<T>`:
  POST com `response_format: {type:"json_object"}`, timeout 20 s (AbortController), 1 retry em 429/5xx com backoff
  (respeitar `retry-after`), lança `LlmError` (`kind`: 'rate_limit'|'timeout'|'network'|'invalid_json'|'api'). Lê `GROQ_API_KEY`
  e opcional `GROQ_MODEL` (default `openai/gpt-oss-20b`). Nunca no client.
- `src/lib/llm/matching.ts`:
  - `planSearches(items: {id, name}[]): Promise<Record<id, { termo: string; excluir: string[]; observacao?: string }>>`
    (uma chamada; prompt em português; saída JSON `{ "itens": [{ "id", "termo", "excluir": [] }] }`).
  - `judgeMatches(item: { name }, candidates: { description: string; gtin: string | null }[]): Promise<{ description: string; isMatch: boolean; reason: string }[]>`
    (uma chamada por item; no máximo 40 descrições distintas; saída `{ "resultados": [{ "descricao", "corresponde", "motivo" }] }`).
  Prompts devem deixar claro: mesmo tipo de produto e tamanho/embalagem compatível com o que o usuário escreveu; marca só importa se o usuário escreveu marca;
  "leite integral" NÃO corresponde a leite em pó, condensado ou de coco; "arroz 5kg" NÃO é ração; "café 500g" é café torrado/moído, não café de milho nem cápsulas, a menos que dito.

## Rota `POST /api/precos/atualizar` (reescrever o miolo)
1. Carrega household (lat/lng), itens não marcados, e `item_matches` existentes do household.
2. `planSearches(itens)` (se falhar: termo = nome do item, excluir = []).
3. Para cada item (pool de 3): `searchPrecoDaHora({ termo (ou gtin do item se houver), lat, lng, raioKm 10, horas 72, maxResultados: 60 })`.
   Descarta resultados cuja descrição normalizada contenha alguma palavra de `excluir`.
4. Descrições distintas (por `normalize_name`) sem veredicto cacheado → `judgeMatches` (se falhar: sem veredicto, segue).
   Upsert em `item_matches` (`onConflict: "household_id,item_key,description_key"`, sem sobrescrever `source='user'`).
5. Insere `price_observations` para TODOS os resultados (como hoje; dedup por 23505), inclusive os não correspondentes
   (são dados válidos de preço, só não casam com este item).
6. Resposta: `{ ok, itens, observacoes, correspondencias: number, semJuiz: boolean, falhas: string[] }`. `maxDuration = 120`.

## Rota `POST /api/precos/match`
Body `{ itemName: string; description: string; gtin?: string | null; isMatch: boolean }` → upsert em `item_matches` com
`source='user'` para o household do usuário. Resposta `{ ok: true }`. Usada pelo botão "Não é esse produto" / "É esse sim".

## Tela `/onde-comprar` (ajustes)
- Badge por fonte do match: `user` → "confirmado por você", `llm` → "verificado por IA", `gtin`/`product` → "código de barras", `name` → "por nome (conferir)".
- Na linha expandida de cada loja: botão "Não é esse produto" (chama `/api/precos/match` com `isMatch:false`, depois `router.refresh()`).
  Em itens "Sem preço ainda" não há ação.
- Resumo por loja: soma = preço × quantidade do item (`list_items.quantity`), com legenda "estimativa pela quantidade da lista".
- Resultado do botão "Atualizar preços" mostra também `correspondencias` e um aviso se `semJuiz`.

## Regras
- Só editar a própria área. Validar com `pnpm exec next typegen && pnpm exec tsc --noEmit && pnpm lint`. Sem `pnpm build`/`next dev` no projeto.
- Sem dependências novas. Chave do Groq só no servidor.
