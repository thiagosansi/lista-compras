-- =============================================================================
-- Lista de Compras — migration 0003 (Fase 4): correspondência inteligente
-- Espelha src/lib/database.types.ts e SPEC-fase4.md. Idempotente.
-- Pré-requisito: 0001_init.sql e 0002_precos.sql aplicadas.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- item_matches: veredictos (LLM ou usuário) de "esta descrição é este item?"
-- -----------------------------------------------------------------------------

-- item_key        = normalize_name(nome do item da lista)
-- description_key = normalize_name(descrição do Preço da Hora / cupom)
-- Um veredicto vale para o household inteiro, independente da lista.
create table if not exists public.item_matches (
  id               uuid primary key default gen_random_uuid(),
  household_id     uuid not null references public.households (id) on delete cascade,
  item_key         text not null check (item_key <> ''),
  description_key  text not null check (description_key <> ''),
  gtin             text check (gtin ~ '^[0-9]{8,14}$'),
  is_match         boolean not null,
  source           text not null check (source in ('llm', 'user')),
  reason           text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint item_matches_household_item_description_key
    unique (household_id, item_key, description_key)
);

-- Lookup por item (rota /api/precos/atualizar carrega os veredictos do item).
create index if not exists item_matches_household_item_idx
  on public.item_matches (household_id, item_key);

-- -----------------------------------------------------------------------------
-- Triggers
-- -----------------------------------------------------------------------------

create or replace function public.set_item_match_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Veredicto do usuário nunca é sobrescrito pelo LLM: se a linha atual é
-- source='user' e o update chega com source='llm', mantém is_match/source/reason
-- antigos (o restante do update, ex. gtin, passa). Vale também para o
-- `insert ... on conflict do update` (upsert) da rota.
create or replace function public.protect_user_item_match()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.source = 'user' and new.source = 'llm' then
    new.is_match := old.is_match;
    new.source   := old.source;
    new.reason   := old.reason;
  end if;
  return new;
end;
$$;

-- Ordem de disparo é alfabética pelo nome: "protect" roda antes de "set".
drop trigger if exists item_matches_protect_user_verdict on public.item_matches;
create trigger item_matches_protect_user_verdict
  before update on public.item_matches
  for each row execute function public.protect_user_item_match();

drop trigger if exists item_matches_set_updated_at on public.item_matches;
create trigger item_matches_set_updated_at
  before update on public.item_matches
  for each row execute function public.set_item_match_updated_at();

-- Funções de trigger não devem ser expostas via /rest/v1/rpc.
revoke all on function public.set_item_match_updated_at() from public, anon, authenticated;
revoke all on function public.protect_user_item_match() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Grants de tabela + RLS (membros do household fazem tudo)
-- -----------------------------------------------------------------------------

grant select, insert, update, delete on public.item_matches to authenticated;

alter table public.item_matches enable row level security;

drop policy if exists "item_matches_select_member" on public.item_matches;
create policy "item_matches_select_member" on public.item_matches
  for select to authenticated
  using (public.is_household_member(household_id));

drop policy if exists "item_matches_insert_member" on public.item_matches;
create policy "item_matches_insert_member" on public.item_matches
  for insert to authenticated
  with check (public.is_household_member(household_id));

drop policy if exists "item_matches_update_member" on public.item_matches;
create policy "item_matches_update_member" on public.item_matches
  for update to authenticated
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));

drop policy if exists "item_matches_delete_member" on public.item_matches;
create policy "item_matches_delete_member" on public.item_matches
  for delete to authenticated
  using (public.is_household_member(household_id));

-- -----------------------------------------------------------------------------
-- RPC best_prices — "onde comprar", agora com item_matches
-- -----------------------------------------------------------------------------

-- Mesma assinatura/colunas da 0002. Para cada (item não marcado, observação):
--   * veredicto is_match=false  → excluída (mesmo que gtin/product casem);
--   * veredicto is_match=true   → match_kind = source do veredicto ('llm'|'user'),
--                                 score = 1.0;
--   * sem veredicto             → gtin/product = 1.0; nome: similarity >= 0.5
--                                 ou like → score = similarity, match_kind='name'.
-- Uma linha por (item, loja): maior score, depois mais recente.
-- security invoker: RLS de lists/list_items/price_observations/item_matches/
-- stores se aplica, então usuário de outro household recebe 0 linhas.
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
  left join public.item_matches im
    on im.household_id = l.household_id
   and im.item_key = li.normalized_name
   and im.description_key = po.normalized_name
  cross join lateral (
    select
      case
        when im.is_match                                                 then im.source
        when li.gtin is not null and po.gtin = li.gtin                   then 'gtin'
        when li.product_id is not null and po.product_id = li.product_id then 'product'
        else 'name'
      end as match_kind,
      case
        when im.is_match
          or (li.gtin is not null and po.gtin = li.gtin)
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
      im.is_match = true
      or (
        im.id is null
        and (
          (li.gtin is not null and po.gtin = li.gtin)
          or (li.product_id is not null and po.product_id = li.product_id)
          or (
            li.normalized_name <> ''
            and (
              extensions.similarity(po.normalized_name, li.normalized_name) >= 0.5
              or po.normalized_name like '%' || li.normalized_name || '%'
            )
          )
        )
      )
    )
  order by li.id, po.store_id, m.score desc, po.observed_at desc;
$$;

revoke all on function public.best_prices(uuid, int) from public, anon;
grant execute on function public.best_prices(uuid, int) to authenticated;
