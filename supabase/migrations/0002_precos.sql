-- =============================================================================
-- Lista de Compras — migration 0002 (Fases 2/3): histórico de preços
-- Espelha src/lib/database.types.ts e SPEC-fase2.md. Idempotente onde é barato.
-- Pré-requisito: 0001_init.sql aplicada.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Extensões (no schema `extensions`, como o Supabase faz)
-- -----------------------------------------------------------------------------

create schema if not exists extensions;
create extension if not exists unaccent with schema extensions;
create extension if not exists pg_trgm  with schema extensions;

-- Colunas generated e a RPC best_prices chamam funções desse schema como o
-- usuário logado. No Supabase esse grant já existe; aqui é só garantia.
grant usage on schema extensions to authenticated;

-- -----------------------------------------------------------------------------
-- Funções de normalização (antes das colunas generated que as usam)
-- -----------------------------------------------------------------------------

-- unaccent() é STABLE (depende do search_path para achar o dicionário).
-- Fixando o dicionário, o wrapper pode ser IMMUTABLE e usado em generated columns.
create or replace function public.immutable_unaccent(p_text text)
returns text
language sql
immutable
strict
parallel safe
as $$
  select extensions.unaccent('extensions.unaccent'::regdictionary, p_text);
$$;

-- Espelho SQL de src/lib/normalize.ts: sem acentos → lower → tudo que não é
-- [a-z0-9] vira um espaço (colapsa sequências) → trim.
create or replace function public.normalize_name(p_text text)
returns text
language sql
immutable
parallel safe
set search_path = public
as $$
  select trim(
    regexp_replace(
      lower(public.immutable_unaccent(coalesce(p_text, ''))),
      '[^a-z0-9]+', ' ', 'g'
    )
  );
$$;

-- -----------------------------------------------------------------------------
-- households: localização da casa
-- -----------------------------------------------------------------------------

alter table public.households add column if not exists lat     double precision;
alter table public.households add column if not exists lng     double precision;
alter table public.households add column if not exists address text;

-- -----------------------------------------------------------------------------
-- Catálogo compartilhado: stores, products
-- -----------------------------------------------------------------------------

create table if not exists public.stores (
  id          uuid primary key default gen_random_uuid(),
  cnpj        text unique check (cnpj ~ '^[0-9]{14}$'),
  name        text not null check (length(trim(name)) between 1 and 200),
  address     text,
  city        text,
  lat         double precision,
  lng         double precision,
  created_at  timestamptz not null default now()
);

-- Lojas do Preço da Hora podem vir sem CNPJ: dedup por nome + endereço.
create unique index if not exists stores_name_address_no_cnpj_uidx
  on public.stores (lower(name), coalesce(address, ''))
  where cnpj is null;

create table if not exists public.products (
  id               uuid primary key default gen_random_uuid(),
  gtin             text unique check (gtin ~ '^[0-9]{8,14}$'),
  name             text not null check (length(trim(name)) between 1 and 200),
  normalized_name  text not null generated always as (public.normalize_name(name)) stored,
  brand            text,
  created_at       timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- list_items: vínculo com produto + nome normalizado (depende de products)
-- -----------------------------------------------------------------------------

alter table public.list_items
  add column if not exists product_id uuid references public.products (id) on delete set null;
alter table public.list_items
  add column if not exists gtin text;
alter table public.list_items
  add column if not exists normalized_name text not null
    generated always as (public.normalize_name(name)) stored;

create index if not exists list_items_product_id_idx
  on public.list_items (product_id);

-- -----------------------------------------------------------------------------
-- Cupons (NFC-e)
-- -----------------------------------------------------------------------------

create table if not exists public.receipts (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  store_id      uuid not null references public.stores (id),
  access_key    text not null unique check (access_key ~ '^[0-9]{44}$'),
  issued_at     timestamptz,
  total         numeric,
  item_count    int,
  source_url    text,
  created_by    uuid default auth.uid() references auth.users (id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists receipts_household_id_issued_at_idx
  on public.receipts (household_id, issued_at desc);

create table if not exists public.receipt_items (
  id          uuid primary key default gen_random_uuid(),
  receipt_id  uuid not null references public.receipts (id) on delete cascade,
  product_id  uuid references public.products (id) on delete set null,
  description text not null,
  gtin        text,
  quantity    numeric not null default 1,
  unit        text,
  unit_price  numeric not null,
  total       numeric not null,
  position    int not null default 0
);

create index if not exists receipt_items_receipt_id_idx
  on public.receipt_items (receipt_id, position);

-- -----------------------------------------------------------------------------
-- Observações de preço (NFC-e, Preço da Hora, encarte, manual)
-- -----------------------------------------------------------------------------

create table if not exists public.price_observations (
  id               uuid primary key default gen_random_uuid(),
  household_id     uuid not null references public.households (id) on delete cascade,
  store_id         uuid not null references public.stores (id),
  product_id       uuid references public.products (id) on delete set null,
  receipt_item_id  uuid references public.receipt_items (id) on delete set null,
  gtin             text,
  description      text not null,
  normalized_name  text not null generated always as (public.normalize_name(description)) stored,
  price            numeric not null check (price > 0),
  unit             text,
  observed_at      timestamptz not null,
  valid_until      timestamptz,
  source           text not null check (source in ('nfce', 'precodahora', 'encarte', 'manual')),
  created_at       timestamptz not null default now()
);

create index if not exists price_observations_household_store_observed_idx
  on public.price_observations (household_id, store_id, observed_at desc);

create index if not exists price_observations_household_gtin_idx
  on public.price_observations (household_id, gtin);

create index if not exists price_observations_normalized_name_trgm_idx
  on public.price_observations using gin (normalized_name extensions.gin_trgm_ops);

create index if not exists price_observations_receipt_item_id_idx
  on public.price_observations (receipt_item_id);

create index if not exists price_observations_product_id_idx
  on public.price_observations (product_id);

-- Evita duplicar a mesma leitura do Preço da Hora ao "Atualizar preços" de novo.
-- Parcial só para precodahora: num cupom o mesmo produto pode aparecer em duas
-- linhas com a mesma data, e isso é legítimo.
create unique index if not exists price_observations_precodahora_dedup_uidx
  on public.price_observations (
    household_id, store_id, coalesce(gtin, ''), normalized_name, observed_at, source
  )
  where source = 'precodahora';

-- -----------------------------------------------------------------------------
-- Grants de tabela
-- -----------------------------------------------------------------------------

grant select, insert, update on public.stores, public.products to authenticated;
grant select, insert, update, delete on public.receipts, public.receipt_items,
  public.price_observations to authenticated;

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------

alter table public.stores             enable row level security;
alter table public.products           enable row level security;
alter table public.receipts           enable row level security;
alter table public.receipt_items      enable row level security;
alter table public.price_observations enable row level security;

-- stores / products: catálogo compartilhado entre todos os households.
-- Qualquer autenticado lê, insere e atualiza; ninguém apaga.
drop policy if exists "stores_select_authenticated" on public.stores;
create policy "stores_select_authenticated" on public.stores
  for select to authenticated
  using (true);

drop policy if exists "stores_insert_authenticated" on public.stores;
create policy "stores_insert_authenticated" on public.stores
  for insert to authenticated
  with check (true);

drop policy if exists "stores_update_authenticated" on public.stores;
create policy "stores_update_authenticated" on public.stores
  for update to authenticated
  using (true)
  with check (true);

drop policy if exists "products_select_authenticated" on public.products;
create policy "products_select_authenticated" on public.products
  for select to authenticated
  using (true);

drop policy if exists "products_insert_authenticated" on public.products;
create policy "products_insert_authenticated" on public.products
  for insert to authenticated
  with check (true);

drop policy if exists "products_update_authenticated" on public.products;
create policy "products_update_authenticated" on public.products
  for update to authenticated
  using (true)
  with check (true);

-- receipts: membros do household fazem tudo.
drop policy if exists "receipts_select_member" on public.receipts;
create policy "receipts_select_member" on public.receipts
  for select to authenticated
  using (public.is_household_member(household_id));

drop policy if exists "receipts_insert_member" on public.receipts;
create policy "receipts_insert_member" on public.receipts
  for insert to authenticated
  with check (public.is_household_member(household_id));

drop policy if exists "receipts_update_member" on public.receipts;
create policy "receipts_update_member" on public.receipts
  for update to authenticated
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));

drop policy if exists "receipts_delete_member" on public.receipts;
create policy "receipts_delete_member" on public.receipts
  for delete to authenticated
  using (public.is_household_member(household_id));

-- receipt_items: via receipt → household.
drop policy if exists "receipt_items_select_member" on public.receipt_items;
create policy "receipt_items_select_member" on public.receipt_items
  for select to authenticated
  using (exists (
    select 1 from public.receipts r
    where r.id = receipt_items.receipt_id and public.is_household_member(r.household_id)
  ));

drop policy if exists "receipt_items_insert_member" on public.receipt_items;
create policy "receipt_items_insert_member" on public.receipt_items
  for insert to authenticated
  with check (exists (
    select 1 from public.receipts r
    where r.id = receipt_items.receipt_id and public.is_household_member(r.household_id)
  ));

drop policy if exists "receipt_items_update_member" on public.receipt_items;
create policy "receipt_items_update_member" on public.receipt_items
  for update to authenticated
  using (exists (
    select 1 from public.receipts r
    where r.id = receipt_items.receipt_id and public.is_household_member(r.household_id)
  ))
  with check (exists (
    select 1 from public.receipts r
    where r.id = receipt_items.receipt_id and public.is_household_member(r.household_id)
  ));

drop policy if exists "receipt_items_delete_member" on public.receipt_items;
create policy "receipt_items_delete_member" on public.receipt_items
  for delete to authenticated
  using (exists (
    select 1 from public.receipts r
    where r.id = receipt_items.receipt_id and public.is_household_member(r.household_id)
  ));

-- price_observations: membros do household fazem tudo.
drop policy if exists "price_observations_select_member" on public.price_observations;
create policy "price_observations_select_member" on public.price_observations
  for select to authenticated
  using (public.is_household_member(household_id));

drop policy if exists "price_observations_insert_member" on public.price_observations;
create policy "price_observations_insert_member" on public.price_observations
  for insert to authenticated
  with check (public.is_household_member(household_id));

drop policy if exists "price_observations_update_member" on public.price_observations;
create policy "price_observations_update_member" on public.price_observations
  for update to authenticated
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));

drop policy if exists "price_observations_delete_member" on public.price_observations;
create policy "price_observations_delete_member" on public.price_observations
  for delete to authenticated
  using (public.is_household_member(household_id));

-- -----------------------------------------------------------------------------
-- RPC best_prices — "onde comprar"
-- -----------------------------------------------------------------------------

-- Para cada item NÃO marcado da lista, as observações candidatas do household
-- dono da lista, uma linha por (item, loja): maior score, depois mais recente.
-- security invoker: RLS de lists/list_items/price_observations/stores se aplica,
-- então usuário de outro household recebe 0 linhas.
create or replace function public.best_prices(p_list_id uuid, p_max_age_hours int default 336)
returns table (
  list_item_id uuid,
  item_name    text,
  store_id     uuid,
  store_name   text,
  store_lat    double precision,
  store_lng    double precision,
  price        numeric,
  description  text,
  gtin         text,
  observed_at  timestamptz,
  source       text,
  match_kind   text,
  score        real
)
language sql
stable
security invoker
set search_path = public
as $$
  select distinct on (li.id, po.store_id)
    li.id          as list_item_id,
    li.name        as item_name,
    po.store_id,
    s.name         as store_name,
    s.lat          as store_lat,
    s.lng          as store_lng,
    po.price,
    po.description,
    po.gtin,
    po.observed_at,
    po.source,
    m.match_kind,
    m.score
  from public.lists l
  join public.list_items li
    on li.list_id = l.id
   and li.checked = false
  join public.price_observations po
    on po.household_id = l.household_id
  cross join lateral (
    select
      case
        when li.gtin is not null and po.gtin = li.gtin               then 'gtin'
        when li.product_id is not null and po.product_id = li.product_id then 'product'
        else 'name'
      end as match_kind,
      case
        when (li.gtin is not null and po.gtin = li.gtin)
          or (li.product_id is not null and po.product_id = li.product_id)
          then 1.0::real
        else extensions.similarity(po.normalized_name, li.normalized_name)
      end as score
  ) m
  join public.stores s
    on s.id = po.store_id
  where l.id = p_list_id
    and (
      po.observed_at >= now() - make_interval(hours => p_max_age_hours)
      or po.valid_until >= now()
    )
    and (
      (li.gtin is not null and po.gtin = li.gtin)
      or (li.product_id is not null and po.product_id = li.product_id)
      or (
        li.normalized_name <> ''
        and (
          extensions.similarity(po.normalized_name, li.normalized_name) >= 0.35
          or po.normalized_name like '%' || li.normalized_name || '%'
        )
      )
    )
  order by li.id, po.store_id, m.score desc, po.observed_at desc;
$$;

-- -----------------------------------------------------------------------------
-- Grants de função
-- -----------------------------------------------------------------------------

-- immutable_unaccent/normalize_name rodam como o usuário que insere (generated
-- columns), então authenticated precisa de execute. normalize_name também é
-- exposta como RPC (database.types.ts).
revoke all on function public.immutable_unaccent(text) from public, anon;
revoke all on function public.normalize_name(text) from public, anon;
revoke all on function public.best_prices(uuid, int) from public, anon;
grant execute on function public.immutable_unaccent(text) to authenticated;
grant execute on function public.normalize_name(text) to authenticated;
grant execute on function public.best_prices(uuid, int) to authenticated;
