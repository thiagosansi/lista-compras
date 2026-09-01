-- =============================================================================
-- Lista de Compras — migration inicial (Fase 1)
-- Espelha src/lib/database.types.ts. Idempotente onde é barato.
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

-- -----------------------------------------------------------------------------
-- Funções utilitárias (antes das tabelas: usadas em defaults e triggers)
-- -----------------------------------------------------------------------------

-- Código de convite: 6 chars [A-Z0-9] sem ambíguos (0/O/1/I).
create or replace function public.generate_invite_code()
returns text
language plpgsql
volatile
set search_path = public
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code text := '';
  i int;
begin
  for i in 1..6 loop
    code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return code;
end;
$$;

-- updated_at + manutenção de checked_at/checked_by em list_items.
create or replace function public.set_list_item_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  if new.checked is distinct from old.checked then
    if new.checked then
      new.checked_at := coalesce(new.checked_at, now());
      new.checked_by := coalesce(new.checked_by, auth.uid());
    else
      new.checked_at := null;
      new.checked_by := null;
    end if;
  end if;
  return new;
end;
$$;

-- Cria profile ao inserir em auth.users.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
      split_part(coalesce(new.email, ''), '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Tabelas
-- -----------------------------------------------------------------------------

create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  display_name  text,
  created_at    timestamptz not null default now()
);

create table if not exists public.households (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (length(trim(name)) between 1 and 80),
  invite_code  text not null unique default public.generate_invite_code()
               check (invite_code ~ '^[A-Z0-9]{6}$'),
  created_by   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at   timestamptz not null default now()
);

create table if not exists public.household_members (
  household_id  uuid not null references public.households (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  role          text not null default 'member' check (role in ('owner', 'member')),
  joined_at     timestamptz not null default now(),
  primary key (household_id, user_id)
);

create table if not exists public.lists (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  name          text not null default 'Compras' check (length(trim(name)) between 1 and 80),
  is_default    boolean not null default false,
  created_at    timestamptz not null default now()
);

create table if not exists public.list_items (
  id          uuid primary key default gen_random_uuid(),
  list_id     uuid not null references public.lists (id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 200),
  quantity    numeric not null default 1 check (quantity > 0),
  unit        text,
  note        text,
  checked     boolean not null default false,
  checked_at  timestamptz,
  checked_by  uuid references auth.users (id) on delete set null,
  added_by    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Índices
-- -----------------------------------------------------------------------------

create index if not exists list_items_list_id_checked_created_at_idx
  on public.list_items (list_id, checked, created_at);

create index if not exists household_members_user_id_idx
  on public.household_members (user_id);

create index if not exists lists_household_id_idx
  on public.lists (household_id);

-- No máximo uma lista default por household.
create unique index if not exists lists_one_default_per_household_idx
  on public.lists (household_id) where is_default;

-- -----------------------------------------------------------------------------
-- Triggers
-- -----------------------------------------------------------------------------

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

drop trigger if exists list_items_set_updated_at on public.list_items;
create trigger list_items_set_updated_at
  before update on public.list_items
  for each row execute function public.set_list_item_updated_at();

-- -----------------------------------------------------------------------------
-- RPCs (security definer; expostas só para authenticated)
-- -----------------------------------------------------------------------------

-- Usada nas policies: evita recursão de RLS em household_members.
create or replace function public.is_household_member(hid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.household_members m
    where m.household_id = hid
      and m.user_id = auth.uid()
  );
$$;

-- Cria household + owner + lista default. Retorna o household id.
create or replace function public.create_household(p_name text)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_name text := trim(coalesce(p_name, ''));
  v_hid uuid;
  v_attempt int := 0;
begin
  if v_uid is null then
    raise exception 'Não autenticado' using errcode = '42501';
  end if;
  if v_name = '' then
    raise exception 'Nome da casa é obrigatório' using errcode = '22023';
  end if;

  -- Retry em colisão de invite_code (improvável: 32^6 ≈ 1 bilhão).
  loop
    begin
      insert into public.households (name, invite_code, created_by)
      values (v_name, public.generate_invite_code(), v_uid)
      returning id into v_hid;
      exit;
    exception when unique_violation then
      v_attempt := v_attempt + 1;
      if v_attempt >= 5 then
        raise;
      end if;
    end;
  end loop;

  insert into public.household_members (household_id, user_id, role)
  values (v_hid, v_uid, 'owner');

  insert into public.lists (household_id, name, is_default)
  values (v_hid, 'Compras', true);

  return v_hid;
end;
$$;

-- Entra num household pelo código. Idempotente. Retorna o household id.
create or replace function public.join_household(p_code text)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code text := upper(trim(coalesce(p_code, '')));
  v_hid uuid;
begin
  if v_uid is null then
    raise exception 'Não autenticado' using errcode = '42501';
  end if;

  select h.id into v_hid
  from public.households h
  where h.invite_code = v_code;

  if v_hid is null then
    raise exception 'Código inválido' using errcode = 'P0002';
  end if;

  insert into public.household_members (household_id, user_id, role)
  values (v_hid, v_uid, 'member')
  on conflict (household_id, user_id) do nothing;

  return v_hid;
end;
$$;

revoke all on function public.is_household_member(uuid) from public, anon;
revoke all on function public.create_household(text) from public, anon;
revoke all on function public.join_household(text) from public, anon;
grant execute on function public.is_household_member(uuid) to authenticated;
grant execute on function public.create_household(text) to authenticated;
grant execute on function public.join_household(text) to authenticated;

-- Utilitária: usada como default de households.invite_code (só via create_household).
revoke all on function public.generate_invite_code() from public, anon;
grant execute on function public.generate_invite_code() to authenticated;

-- -----------------------------------------------------------------------------
-- Grants de tabela (Supabase já tem default privileges, mas explícito é seguro)
-- -----------------------------------------------------------------------------

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.profiles, public.households,
  public.household_members, public.lists, public.list_items to authenticated;

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------

alter table public.profiles          enable row level security;
alter table public.households        enable row level security;
alter table public.household_members enable row level security;
alter table public.lists             enable row level security;
alter table public.list_items        enable row level security;

-- profiles: qualquer autenticado lê; só o dono atualiza. Insert só via trigger.
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select to authenticated
  using (true);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- households: membros leem/atualizam; owner apaga. Insert só via create_household.
drop policy if exists "households_select_member" on public.households;
create policy "households_select_member" on public.households
  for select to authenticated
  using (public.is_household_member(id));

drop policy if exists "households_update_member" on public.households;
create policy "households_update_member" on public.households
  for update to authenticated
  using (public.is_household_member(id))
  with check (public.is_household_member(id));

drop policy if exists "households_delete_owner" on public.households;
create policy "households_delete_owner" on public.households
  for delete to authenticated
  using (created_by = (select auth.uid()));

-- household_members: membros veem os colegas; cada um pode sair (delete própria linha).
-- Insert só via create_household/join_household.
drop policy if exists "household_members_select_member" on public.household_members;
create policy "household_members_select_member" on public.household_members
  for select to authenticated
  using (public.is_household_member(household_id));

drop policy if exists "household_members_delete_self" on public.household_members;
create policy "household_members_delete_self" on public.household_members
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- lists: membros do household fazem tudo.
drop policy if exists "lists_select_member" on public.lists;
create policy "lists_select_member" on public.lists
  for select to authenticated
  using (public.is_household_member(household_id));

drop policy if exists "lists_insert_member" on public.lists;
create policy "lists_insert_member" on public.lists
  for insert to authenticated
  with check (public.is_household_member(household_id));

drop policy if exists "lists_update_member" on public.lists;
create policy "lists_update_member" on public.lists
  for update to authenticated
  using (public.is_household_member(household_id))
  with check (public.is_household_member(household_id));

drop policy if exists "lists_delete_member" on public.lists;
create policy "lists_delete_member" on public.lists
  for delete to authenticated
  using (public.is_household_member(household_id));

-- list_items: membros do household da lista fazem tudo (join via lists).
drop policy if exists "list_items_select_member" on public.list_items;
create policy "list_items_select_member" on public.list_items
  for select to authenticated
  using (exists (
    select 1 from public.lists l
    where l.id = list_items.list_id and public.is_household_member(l.household_id)
  ));

drop policy if exists "list_items_insert_member" on public.list_items;
create policy "list_items_insert_member" on public.list_items
  for insert to authenticated
  with check (exists (
    select 1 from public.lists l
    where l.id = list_items.list_id and public.is_household_member(l.household_id)
  ));

drop policy if exists "list_items_update_member" on public.list_items;
create policy "list_items_update_member" on public.list_items
  for update to authenticated
  using (exists (
    select 1 from public.lists l
    where l.id = list_items.list_id and public.is_household_member(l.household_id)
  ))
  with check (exists (
    select 1 from public.lists l
    where l.id = list_items.list_id and public.is_household_member(l.household_id)
  ));

drop policy if exists "list_items_delete_member" on public.list_items;
create policy "list_items_delete_member" on public.list_items
  for delete to authenticated
  using (exists (
    select 1 from public.lists l
    where l.id = list_items.list_id and public.is_household_member(l.household_id)
  ));

-- -----------------------------------------------------------------------------
-- Realtime
-- -----------------------------------------------------------------------------

alter table public.list_items replica identity full;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public' and tablename = 'list_items'
     )
  then
    alter publication supabase_realtime add table public.list_items;
  end if;
end;
$$;
