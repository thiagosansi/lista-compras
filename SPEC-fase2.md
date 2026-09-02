# Fases 2 e 3 — Histórico de preços (NFC-e) + Preço da Hora + "Onde comprar"

Contexto: ver `SPEC.md` (fase 1, já em produção). Casal mora em **Salvador, BA**. Custo zero é requisito.
Objetivo desta rodada: para cada item da lista, mostrar onde está mais barato, usando
(a) preços reais dos cupons que eles escaneiam (NFC-e) e (b) o Preço da Hora BA (API privada, não oficial).

## Contrato já escrito (não alterar sem avisar)
- `src/lib/database.types.ts` — inclui as tabelas novas e as funções `best_prices` e `normalize_name`.
- `src/lib/normalize.ts` — `normalizeName()` em TS, espelho da função SQL.
- `src/lib/supabase/{client,server}.ts`, `src/proxy.ts` — como na fase 1. Rotas `/api/**` são protegidas pelo proxy (usuário precisa estar logado; use `createClient()` de server.ts dentro do handler; RLS se aplica).

## Migration `supabase/migrations/0002_precos.sql`
- `create extension if not exists unaccent with schema extensions;` e `pg_trgm` idem.
- `public.immutable_unaccent(text) returns text immutable` (wrapper de `extensions.unaccent('extensions.unaccent'::regdictionary, $1)`),
  `public.normalize_name(text) returns text immutable`: lower → unaccent → troca tudo que não é `[a-z0-9]` por espaço → colapsa espaços → trim.
- `households`: add `lat double precision`, `lng double precision`, `address text`.
- `stores(id uuid pk, cnpj text unique (14 dígitos, nullable), name text not null, address text, city text, lat double precision, lng double precision, created_at)`.
  Índice único parcial em `(lower(name), coalesce(address,''))` where cnpj is null (lojas do Preço da Hora sem CNPJ).
- `products(id uuid pk, gtin text unique (nullable, 8–14 dígitos), name text not null, normalized_name text not null generated (normalize_name(name)), brand text, created_at)`.
- `receipts(id uuid pk, household_id fk households cascade not null, store_id fk stores not null, access_key text unique not null check 44 dígitos, issued_at timestamptz, total numeric, item_count int, source_url text, created_by uuid default auth.uid() references auth.users on delete set null, created_at)`.
- `receipt_items(id uuid pk, receipt_id fk receipts cascade not null, product_id fk products null, description text not null, gtin text, quantity numeric not null default 1, unit text, unit_price numeric not null, total numeric not null, position int not null default 0)`.
- `price_observations(id uuid pk, household_id fk households cascade not null, store_id fk stores not null, product_id fk products null, receipt_item_id fk receipt_items on delete set null, gtin text, description text not null, normalized_name text not null generated (normalize_name(description)), price numeric not null check > 0, unit text, observed_at timestamptz not null, valid_until timestamptz, source text not null check in ('nfce','precodahora','encarte','manual'), created_at)`.
  Índices: `(household_id, store_id, observed_at desc)`, `(household_id, gtin)`, GIN trigram em `normalized_name`.
  Único parcial para evitar duplicar Preço da Hora: `(household_id, store_id, coalesce(gtin,''), normalized_name, observed_at, source)`.
- `list_items`: add `product_id uuid fk products null`, `gtin text`, `normalized_name text generated (normalize_name(name))`.
- RLS: `stores` e `products` = catálogo compartilhado: select/insert/update para `authenticated`, sem delete. `receipts`, `receipt_items` (via receipt→household), `price_observations` = membro do household (`is_household_member`), select/insert/update/delete.
- Função `public.best_prices(p_list_id uuid, p_max_age_hours int default 336)` — `security invoker`, `stable`, `language sql` — retorna, para cada item NÃO marcado da lista, as observações candidatas do household dono da lista:
  colunas `list_item_id uuid, item_name text, store_id uuid, store_name text, store_lat double precision, store_lng double precision, price numeric, description text, gtin text, observed_at timestamptz, source text, match_kind text ('gtin'|'product'|'name'), score real`.
  Regras: match por `gtin` (score 1.0), por `product_id` (1.0) ou por `similarity(po.normalized_name, li.normalized_name) >= 0.35` ou `po.normalized_name like '%' || li.normalized_name || '%'` (score = similarity). Só observações com `observed_at >= now() - p_max_age_hours` ou `valid_until >= now()`. Uma linha por (item, loja): a observação mais recente com maior score (use `distinct on`). Grant execute to authenticated.
- Realtime: não é necessário nesta rodada.

## Rotas de API (Route Handlers, `src/app/api/**/route.ts`, sempre `export const runtime = "nodejs"`)
- `POST /api/precos/buscar` body `{ termo?: string; gtin?: string; lat: number; lng: number; raioKm?: number (default 10); horas?: number (default 72) }`
  → `200 { ok: true, resultados: PdhResult[] }` ou `{ ok: false, error: string }` (status 502 se o Preço da Hora falhar).
  `PdhResult = { descricao: string; gtin: string | null; preco: number; unidade: string | null; data: string (ISO); loja: { nome: string; cnpj: string | null; endereco: string | null; cidade: string | null; lat: number | null; lng: number | null; distanciaKm: number | null } }`.
- `POST /api/precos/atualizar` body `{ listId: string }` → para cada item não marcado da lista: busca no Preço da Hora (gtin se houver, senão `termo = name`) com lat/lng do household (fallback Salvador centro `-12.9777, -38.5016` se null), faz upsert de `stores` (por cnpj; senão por nome+endereço) e insere `price_observations` (source `precodahora`, `observed_at` = data do resultado, `valid_until` = null). Limite: até 8 resultados por item, e no máximo 3 buscas em paralelo. Resposta `{ ok: true, itens: number, observacoes: number, falhas: string[] }`.
- `POST /api/nfce/importar` body `{ url: string }` (conteúdo do QR code, ou chave de 44 dígitos) → busca a página pública da Sefaz-BA, faz parse, upsert `stores` por CNPJ, insere `receipts` + `receipt_items` + uma `price_observations` por item (source `nfce`, `observed_at` = `issued_at`, `price` = `unit_price`). Se a chave já existir: `409 { ok: false, error: "Cupom já importado" }`. Resposta `{ ok: true, receipt: { id, store: { name, cnpj }, issuedAt, total, items: [{ description, gtin, quantity, unit, unitPrice, total }] } }`.

## Telas
- Barra de navegação inferior (tab bar) em todas as telas logadas: Lista (`/lista`), Onde comprar (`/onde-comprar`), Cupom (`/cupom`), Casa (`/casa`). Ícones inline SVG. Altura ≥ 56px + safe-area.
- `/onde-comprar`: chama `rpc best_prices` para a lista default. Mostra: (1) resumo por loja: nome, itens cobertos (n/total), soma dos preços; ordenado por menor soma entre lojas que cobrem ≥ metade dos itens, depois por cobertura; (2) por item: melhor preço + loja + fonte + "há X dias", e itens sem preço; (3) botão "Atualizar preços (Preço da Hora)" que chama `POST /api/precos/atualizar` e recarrega. Estados: sem localização definida (link para /casa), sem dados, carregando.
- `/cupom`: leitor de QR code pela câmera (usar `BarcodeDetector` quando existir; senão fallback com a lib `jsqr` sobre frames de `<video>` + canvas; pedir permissão com `facingMode: "environment"`). Campo alternativo para colar URL/chave. Ao importar mostra o resumo (loja, data, itens, total). Lista dos últimos cupons importados do household.
- `/casa`: seção "Localização da casa": botão "Usar minha localização" (`navigator.geolocation`), salva lat/lng em `households`; campo de endereço texto opcional; mostra estado atual.

## Regras para os agentes
- Só editar arquivos da própria área (listada na tarefa). Sem `pnpm build`/`next dev` no diretório do projeto; validar com `pnpm exec next typegen && pnpm exec tsc --noEmit && pnpm lint`.
- Dependências novas: apenas `jsqr` (agente NFC-e). Nada mais sem justificativa no relatório.
- Segredos só em variáveis de servidor. `.env.local` já tem `GROQ_API_KEY` (não usar nesta rodada).
- Relatório final: arquivos, decisões, o que não funcionou, e o que o orquestrador precisa fazer.
