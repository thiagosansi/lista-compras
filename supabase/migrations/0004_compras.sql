-- =============================================================================
-- Lista de Compras — migration 0004 (Fase 5): categorias, sugestões e modo Compras
-- Espelha src/lib/database.types.ts e SPEC-fase5.md. Idempotente.
-- Pré-requisito: 0001_init.sql, 0002_precos.sql e 0003_matches.sql aplicadas.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Categorias em products / list_items
-- -----------------------------------------------------------------------------

-- O check repete literalmente a lista CATEGORIES de src/lib/categories.ts.
-- Se a lista mudar lá, mude aqui (e em item_categories) na mesma migration.
alter table public.products add column if not exists category text;

alter table public.products drop constraint if exists products_category_check;
alter table public.products add constraint products_category_check
  check (category is null or category in (
    'Hortifruti', 'Açougue e peixaria', 'Frios e laticínios', 'Padaria',
    'Mercearia', 'Bebidas', 'Congelados', 'Limpeza', 'Higiene e beleza',
    'Bebê', 'Pet', 'Outros'
  ));

alter table public.list_items add column if not exists category text;

alter table public.list_items drop constraint if exists list_items_category_check;
alter table public.list_items add constraint list_items_category_check
  check (category is null or category in (
    'Hortifruti', 'Açougue e peixaria', 'Frios e laticínios', 'Padaria',
    'Mercearia', 'Bebidas', 'Congelados', 'Limpeza', 'Higiene e beleza',
    'Bebê', 'Pet', 'Outros'
  ));

-- -----------------------------------------------------------------------------
-- item_categories: cache GLOBAL de categoria por nome normalizado
-- -----------------------------------------------------------------------------

-- item_key = normalize_name(nome do item). Não é por household: "arroz" é
-- Mercearia para todo mundo. source='user' não deve ser sobrescrito por 'llm'
-- (regra aplicada na rota /api/itens/categorizar).
create table if not exists public.item_categories (
  item_key    text primary key check (item_key <> ''),
  category    text not null check (category in (
    'Hortifruti', 'Açougue e peixaria', 'Frios e laticínios', 'Padaria',
    'Mercearia', 'Bebidas', 'Congelados', 'Limpeza', 'Higiene e beleza',
    'Bebê', 'Pet', 'Outros'
  )),
  source      text not null check (source in ('llm', 'user')),
  updated_at  timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- product_suggestions: cache GLOBAL da resposta do Preço da Hora /sugestao/
-- -----------------------------------------------------------------------------

-- term_key = normalize_name(termo digitado). gtins = produtos sugeridos
-- (já upsertados em products). fetched_at controla a validade (7 dias na rota).
create table if not exists public.product_suggestions (
  term_key    text primary key check (term_key <> ''),
  gtins       text[] not null default '{}',
  fetched_at  timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- shopping_sessions: uma ida ao mercado
-- -----------------------------------------------------------------------------

create table if not exists public.shopping_sessions (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  list_id       uuid references public.lists (id) on delete set null,
  store_id      uuid references public.stores (id) on delete set null,
  store_name    text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  total         numeric not null default 0,
  created_by    uuid default auth.uid() references auth.users (id) on delete set null,
  created_at    timestamptz not null default now()
);

-- Histórico: últimas compras do household.
create index if not exists shopping_sessions_household_started_at_idx
  on public.shopping_sessions (household_id, started_at desc);

-- No máximo uma sessão aberta por household (o app reabre a existente).
create unique index if not exists shopping_sessions_one_open_per_household_uidx
  on public.shopping_sessions (household_id) where finished_at is null;

create index if not exists shopping_sessions_list_id_idx
  on public.shopping_sessions (list_id);

-- -----------------------------------------------------------------------------
-- shopping_session_items: o carrinho
-- -----------------------------------------------------------------------------

create table if not exists public.shopping_session_items (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references public.shopping_sessions (id) on delete cascade,
  list_item_id  uuid references public.list_items (id) on delete set null,
  product_id    uuid references public.products (id) on delete set null,
  gtin          text,
  description   text not null,
  quantity      numeric not null default 1 check (quantity > 0),
  unit_price    numeric not null check (unit_price >= 0),
  total         numeric not null generated always as (quantity * unit_price) stored,
  scanned       boolean not null default false,
  created_at    timestamptz not null default now()
);

create index if not exists shopping_session_items_session_id_created_at_idx
  on public.shopping_session_items (session_id, created_at);

-- FKs "on delete set null" precisam de índice do lado referenciador.
create index if not exists shopping_session_items_list_item_id_idx
  on public.shopping_session_items (list_item_id);

create index if not exists shopping_session_items_product_id_idx
  on public.shopping_session_items (product_id);

-- -----------------------------------------------------------------------------
-- Triggers
-- -----------------------------------------------------------------------------

create or replace function public.set_item_category_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists item_categories_set_updated_at on public.item_categories;
create trigger item_categories_set_updated_at
  before update on public.item_categories
  for each row execute function public.set_item_category_updated_at();

-- shopping_sessions.total = coalesce(sum(items.total), 0) da(s) sessão(ões)
-- afetada(s). Num update que troca session_id, recalcula a antiga e a nova.
-- security definer: o total é dado derivado e deve ficar certo independente de
-- quem tocou nos itens (a RLS de shopping_session_items já limitou o acesso).
create or replace function public.recalc_shopping_session_total()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old uuid := case when tg_op in ('UPDATE', 'DELETE') then old.session_id end;
  v_new uuid := case when tg_op in ('INSERT', 'UPDATE') then new.session_id end;
begin
  update public.shopping_sessions s
     set total = coalesce((
       select sum(i.total)
       from public.shopping_session_items i
       where i.session_id = s.id
     ), 0)
   where s.id = v_old or s.id = v_new;
  return null;
end;
$$;

drop trigger if exists shopping_session_items_recalc_total on public.shopping_session_items;
create trigger shopping_session_items_recalc_total
  after insert or update or delete on public.shopping_session_items
  for each row execute function public.recalc_shopping_session_total();

-- Funções de trigger não devem ser expostas via /rest/v1/rpc.
revoke all on function public.set_item_category_updated_at() from public, anon, authenticated;
revoke all on function public.recalc_shopping_session_total() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Grants de tabela
-- -----------------------------------------------------------------------------

-- Caches globais: qualquer autenticado lê/insere/atualiza; ninguém apaga.
grant select, insert, update on public.item_categories, public.product_suggestions
  to authenticated;

grant select, insert, update, delete on public.shopping_sessions,
  public.shopping_session_items to authenticated;

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------

alter table public.item_categories        enable row level security;
alter table public.product_suggestions    enable row level security;
alter table public.shopping_sessions      enable row level security;
alter table public.shopping_session_items enable row level security;

-- item_categories: cache compartilhado.
drop policy if exists "item_categories_select_authenticated" on public.item_categories;
create policy "item_categories_select_authenticated" on public.item_categories
  for select to authenticated
  using (true);

drop policy if exists "item_categories_insert_authenticated" on public.item_categories;
create policy "item_categories_insert_authenticated" on public.item_categories
  for insert to authenticated
  with check (true);

drop policy if exists "item_categories_update_authenticated" on public.item_categories;
create policy "item_categories_update_authenticated" on public.item_categories
  for update to authenticated
  using (true)
  with check (true);

-- product_suggestions: cache compartilhado.
drop policy if exists "product_suggestions_select_authenticated" on public.product_suggestions;
create policy "product_suggestions_select_authenticated" on public.product_suggestions
  for select to authenticated
  using (true);

drop policy if exists "product_suggestions_insert_authenticated" on public.product_suggestions;
create policy "product_suggestions_insert_authenticated" on public.product_suggestions
  for insert to authenticated
  with check (true);

drop policy if exists "product_suggestions_update_authenticated" on public.product_suggestions;
create policy "product_suggestions_update_authenticated" on public.product_suggestions
  for update to authenticated
  using (true)
  with check (true);

-- shopping_sessions: membros do household fazem tudo.
drop policy if exists "shopping_sessions_select_member" on public.shopping_sessions;
create policy "shopping_sessions_select_member" on public.shopping_sessions
  for select to authenticated
  using (public.is_household_member(household_id));

drop policy if exists "shopping_sessions_insert_member" on public.shopping_sessions;
create policy "shopping_sessions_insert_member" on public.shopping_sessions
  for insert to authenticated
  with check (public.is_household_member(household_id));

drop policy if exists "shopping_sessions_update_member" on public.shopping_sessions;
create policy "shopping_sessions_update_member" on public.shopping_sessions
  for update to authenticated
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));

drop policy if exists "shopping_sessions_delete_member" on public.shopping_sessions;
create policy "shopping_sessions_delete_member" on public.shopping_sessions
  for delete to authenticated
  using (public.is_household_member(household_id));

-- shopping_session_items: via session → household.
drop policy if exists "shopping_session_items_select_member" on public.shopping_session_items;
create policy "shopping_session_items_select_member" on public.shopping_session_items
  for select to authenticated
  using (exists (
    select 1 from public.shopping_sessions s
    where s.id = shopping_session_items.session_id and public.is_household_member(s.household_id)
  ));

drop policy if exists "shopping_session_items_insert_member" on public.shopping_session_items;
create policy "shopping_session_items_insert_member" on public.shopping_session_items
  for insert to authenticated
  with check (exists (
    select 1 from public.shopping_sessions s
    where s.id = shopping_session_items.session_id and public.is_household_member(s.household_id)
  ));

drop policy if exists "shopping_session_items_update_member" on public.shopping_session_items;
create policy "shopping_session_items_update_member" on public.shopping_session_items
  for update to authenticated
  using (exists (
    select 1 from public.shopping_sessions s
    where s.id = shopping_session_items.session_id and public.is_household_member(s.household_id)
  ))
  with check (exists (
    select 1 from public.shopping_sessions s
    where s.id = shopping_session_items.session_id and public.is_household_member(s.household_id)
  ));

drop policy if exists "shopping_session_items_delete_member" on public.shopping_session_items;
create policy "shopping_session_items_delete_member" on public.shopping_session_items
  for delete to authenticated
  using (exists (
    select 1 from public.shopping_sessions s
    where s.id = shopping_session_items.session_id and public.is_household_member(s.household_id)
  ));

-- -----------------------------------------------------------------------------
-- Realtime: os dois celulares veem o carrinho e o total em tempo real
-- -----------------------------------------------------------------------------

-- replica identity full: o DELETE chega com a linha completa (session_id
-- incluído, que é o filtro da assinatura).
alter table public.shopping_session_items replica identity full;
alter table public.shopping_sessions      replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public' and tablename = 'shopping_session_items'
    ) then
      alter publication supabase_realtime add table public.shopping_session_items;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public' and tablename = 'shopping_sessions'
    ) then
      alter publication supabase_realtime add table public.shopping_sessions;
    end if;
  end if;
end;
$$;
