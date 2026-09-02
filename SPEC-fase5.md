# Fase 5 — Escolha assertiva do produto (autocomplete) + modo Compras

Contexto: fases 1–4 em produção (ver SPEC.md, SPEC-fase2.md, SPEC-fase4.md). Problema relatado pelo usuário: "óleo de coco"
virou sachê; ele queria 500 ml. A escolha do produto tem que acontecer na ENTRADA, com base no que existe de fato.
Descoberta: o Preço da Hora expõe `POST https://precodahora.ba.gov.br/sugestao/` (form `item=<termo>`, mesma sessão/CSRF
de `/produtos/`, headers `X-CSRFToken` e `X-Requested-With: XMLHttpRequest`) que devolve
`{ codigo, resultado: [{ gtin: number, descricao: string, foto: string }], totalRegistros }` — produtos reais vendidos
na Bahia com código de barras (testado: "oleo de coco" → 10 produtos). É a base de catálogo. Limite: mesmo bloqueio
(~20 POSTs / 15 min por IP; o segundo bloqueio durou > 35 min), então cada busca é cacheada e reaproveitada.

Segunda parte: modo **Compras** — no mercado, a lista aparece agrupada por tipo; ao pegar um item, escaneia o código de
barras; o produto é salvo, o preço confirmado, e o total da compra é calculado na hora. No caixa já se sabe o gasto.

## Contrato já escrito
- `src/lib/database.types.ts`: `products.category`, `list_items.category`, tabelas `item_categories`, `product_suggestions`,
  `shopping_sessions`, `shopping_session_items`; tipos `ProductSuggestion`, `ProductLookup`.
- `src/lib/categories.ts`: `CATEGORIES` (lista fixa, ordem de percurso), `isCategory`, `DEFAULT_CATEGORY`.

## Migration `supabase/migrations/0004_compras.sql`
- `products`: add `category text` (check: null ou um valor de CATEGORIES).
- `list_items`: add `category text` (idem).
- `item_categories(item_key text pk, category text not null, source text check in ('llm','user'), updated_at)` — cache GLOBAL
  (não por household: "arroz" é Mercearia para todo mundo). RLS: select/insert/update para authenticated.
- `product_suggestions(term_key text pk, gtins text[] not null default '{}', fetched_at timestamptz not null default now())`
  — cache global da resposta do `/sugestao/` por termo normalizado. RLS: select/insert/update para authenticated.
- `shopping_sessions(id uuid pk, household_id fk cascade not null, list_id fk lists set null, store_id fk stores set null,
  store_name text, started_at timestamptz default now(), finished_at timestamptz, total numeric not null default 0,
  created_by uuid default auth.uid() -> auth.users set null, created_at)`. Índice `(household_id, started_at desc)`.
  Único parcial: uma sessão aberta por household (`(household_id) where finished_at is null`).
- `shopping_session_items(id uuid pk, session_id fk cascade not null, list_item_id fk list_items set null, product_id fk products
  set null, gtin text, description text not null, quantity numeric not null default 1 check > 0, unit_price numeric not null check >= 0,
  total numeric generated always as (quantity * unit_price) stored, scanned boolean not null default false, created_at)`.
  Trigger after insert/update/delete que recalcula `shopping_sessions.total = coalesce(sum(total),0)` da sessão afetada.
- RLS de sessions/items por `is_household_member` (items via session → household). Grants para authenticated.
- Realtime: `alter publication supabase_realtime add table shopping_session_items` + `replica identity full` (os dois celulares
  veem o carrinho em tempo real). Também `shopping_sessions` na publication (total e finished_at).

## Rotas (Route Handlers, `runtime = "nodejs"`)
- `POST /api/produtos/sugerir` body `{ termo: string }` (mín. 5 caracteres, contando espaço; 400 abaixo disso).
  `termKey = normalizeName(termo)`. Passos: (1) busca LOCAL em `products` (`normalized_name` ilike `%termKey%` e também cada
  palavra, até 10) — sempre; (2) se `product_suggestions[termKey]` existe e `fetched_at` < 7 dias → usa os gtins cacheados;
  senão chama o Preço da Hora `/sugestao/` (função nova `suggestPrecoDaHora(termo): Promise<{ gtin: string; descricao: string }[]>`
  em `src/lib/precodahora/client.ts`, reaproveitando sessão/CSRF/detecção de bloqueio), faz upsert em `products`
  (`onConflict: "gtin"`, `name = descricao`) e grava `product_suggestions`. Se o PdH bloquear ou falhar: responde só com o local e
  `fonteExterna: false` (nunca 5xx por causa do PdH).
  Resposta: `{ ok: true, sugestoes: ProductSuggestion[], fonteExterna: boolean }`.
  `ultimaCompra` = última `price_observations` do household com esse gtin e `source in ('nfce','manual')` (loja = `stores.name`).
  Ordenação: locais com compra primeiro, depois locais, depois externos; dedup por gtin; máx. 12.
- `GET /api/produtos/[gtin]?storeId=` → `{ ok: true, ...ProductLookup }`. Valida gtin (8–14 dígitos). Procura em `products`; se não
  existir, `searchPrecoDaHora({ gtin, lat/lng do household, raioKm 30, horas 720, maxResultados: 25 })` e cria o produto com a
  descrição do primeiro resultado (e grava as observações como `precodahora`). `precoSugerido`: se `storeId`, a observação mais
  recente desse gtin nessa loja; senão a mais recente em qualquer loja (qualquer fonte). Se nada: `produto: null`.
- `POST /api/itens/categorizar` body `{ nomes: string[] }` (máx. 50) → para cada nome sem `item_categories`, UMA chamada em lote ao
  Groq (`chatJson` de `src/lib/llm/groq.ts`, `reasoning_effort: low`) pedindo uma categoria de `CATEGORIES` por nome (saída JSON
  `{ "itens": [{ "nome", "categoria" }] }`; validar com `isCategory`); grava em `item_categories` (`source='llm'`, sem sobrescrever
  `'user'`) e atualiza `list_items.category` dos itens do household com esse `item_key` (`normalize_name(nome)`).
  Resposta `{ ok: true, categorias: Record<nome, categoria> }`. Se o Groq falhar: `DEFAULT_CATEGORY` para os faltantes, sem gravar cache.

## Telas
### Autocomplete no campo de adicionar (`/lista`)
- Regra do usuário: consulta EXTERNA só quando o texto tem 5, 10, 15… caracteres (espaço conta), via `POST /api/produtos/sugerir`.
  Busca LOCAL (tabela `products` pelo client Supabase: `ilike("normalized_name", `%${normalizeName(texto)}%`)`, limit 8) a cada
  tecla a partir de 3 caracteres, com debounce de 250 ms. As sugestões externas da última consulta ficam em memória e são
  filtradas localmente (por palavras do texto) enquanto o usuário digita entre múltiplos de 5.
- Lista de sugestões acima da barra (máx. 8), cada uma com descrição, categoria e, se houver, "última compra: R$ X em LOJA (data)".
  Toque escolhe: o item é criado com `name = descricao` legível (Title Case simples, preservando siglas curtas como UHT/1L),
  `gtin`, `product_id` (buscar/criar em `products` por gtin), `category`. Enter sem escolher: texto livre como hoje; depois de
  criar, chamar `POST /api/itens/categorizar` com o nome em background e aplicar a categoria retornada no estado local.
- Item com gtin mostra um selo pequeno "código de barras" na linha (`item-row.tsx`).

### Modo Compras (`/compras`)
- Tab bar ganha a aba "Compras" (ícone de carrinho) entre "Lista" e "Onde comprar" (5 abas).
- Sem sessão aberta: tela "Começar compra": escolher a loja (as `stores` das últimas observações/cupons do household, até 8, +
  campo de texto livre + "Loja mais próxima" via `navigator.geolocation` comparando com `stores.lat/lng` por distância haversine)
  → insere `shopping_sessions` (`list_id` = lista default). Se já existir sessão aberta (índice único), reabre-a.
- Com sessão aberta: cabeçalho com loja e TOTAL grande (`shopping_sessions.total`), atualizado em tempo real (assinaturas
  `postgres_changes` em `shopping_session_items` filtrando `session_id=eq.<id>` e em `shopping_sessions` pelo `id`). Lista de itens
  PENDENTES (`checked=false`) agrupada por `list_items.category` na ordem de `CATEGORIES` ("Outros" por último); itens sem
  categoria → chamar `/api/itens/categorizar` uma vez ao abrir e aplicar.
- Ao tocar num item: folha inferior com [Escanear código] [Sem código]. Escanear: câmera `facingMode: "environment"`, `BarcodeDetector`
  (`formats: ["ean_13","ean_8","upc_a","upc_e"]`) quando existir; fallback com `@zxing/browser` (`BrowserMultiFormatReader`,
  import dinâmico) — única dependência nova permitida. GTIN lido → `GET /api/produtos/[gtin]?storeId=` → mostra descrição e preço
  sugerido (editável, teclado numérico `inputMode="decimal"`), quantidade pré-preenchida com a da lista → "Confirmar":
  insere `shopping_session_items` (`scanned=true`), marca o `list_item` (`checked=true`), preenche `list_items.gtin/product_id/name`
  se estavam vazios, e insere `price_observations` (`source='manual'`, `store_id` da sessão se houver, `observed_at=now()`,
  `description`, `gtin`, `price=unit_price`). "Sem código": só preço + quantidade (sem gtin; observação só se `store_id`).
- Seção "No carrinho" com os itens da sessão (toque para editar preço/quantidade ou remover → desmarca o `list_item`).
- Botão "Finalizar compra": confirma (sem `confirm()` nativo), grava `finished_at`, mostra o total e sugere "Escanear cupom" (link `/cupom`).
- Histórico: últimas 5 compras finalizadas (loja, data, total).

## Regras
- Só editar a própria área. Validar com `pnpm exec next typegen && pnpm exec tsc --noEmit && pnpm lint`. Sem `pnpm build`/`next dev` no projeto.
- Dependência nova: apenas `@zxing/browser` (agente do modo Compras). Groq só no servidor.
- IMPORTANTE (hook do projeto): não use redirecionamento de shell para arquivo (`>`/`>>`/heredoc `cat > f`); use as ferramentas Write/Edit.
