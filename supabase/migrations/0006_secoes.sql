-- =============================================================================
-- Lista de Compras — migration 0006: seções por layout de mercado
-- Espelha src/lib/categories.ts (CATEGORIES). Idempotente.
-- Pré-requisito: 0001_init.sql … 0005_products_trgm.sql já aplicadas.
--
-- O que muda: "Frios e laticínios" deixa de existir; vira "Frios e refrigerados"
-- (só o que fica na geladeira/vitrine refrigerada — manteiga, queijo, iogurte,
-- presunto, ovos, leite pasteurizado). Leite UHT/em pó/condensado, creme de
-- leite etc. (prateleira seca) passam a cair em "Mercearia" pelo prompt do LLM
-- (src/lib/llm/categorize.ts), não por mudança de schema. A ordem das 12
-- categorias também muda para refletir o percurso físico do mercado.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Soltar os checks antigos ANTES de tocar nos dados (o valor novo
--    "Frios e refrigerados" não é aceito pelo check antigo).
-- -----------------------------------------------------------------------------

alter table public.products drop constraint if exists products_category_check;
alter table public.list_items drop constraint if exists list_items_category_check;
alter table public.item_categories drop constraint if exists item_categories_category_check;

-- -----------------------------------------------------------------------------
-- 2) Migrar o valor legado nas 3 tabelas (espelha LEGACY_CATEGORY_MAP de
--    src/lib/categories.ts). Idempotente: na 2ª aplicação não sobra nenhuma
--    linha com "Frios e laticínios" para migrar.
-- -----------------------------------------------------------------------------

update public.products
   set category = 'Frios e refrigerados'
 where category = 'Frios e laticínios';

update public.list_items
   set category = 'Frios e refrigerados'
 where category = 'Frios e laticínios';

update public.item_categories
   set category = 'Frios e refrigerados'
 where category = 'Frios e laticínios';

-- -----------------------------------------------------------------------------
-- 3) Recriar os checks com a lista nova de src/lib/categories.ts (CATEGORIES).
--    Se a lista mudar lá, mude aqui também (0004 tinha a mesma nota).
-- -----------------------------------------------------------------------------

alter table public.products add constraint products_category_check
  check (category is null or category in (
    'Hortifruti', 'Açougue e peixaria', 'Padaria', 'Frios e refrigerados',
    'Congelados', 'Mercearia', 'Bebidas', 'Limpeza', 'Higiene e beleza',
    'Bebê', 'Pet', 'Outros'
  ));

alter table public.list_items add constraint list_items_category_check
  check (category is null or category in (
    'Hortifruti', 'Açougue e peixaria', 'Padaria', 'Frios e refrigerados',
    'Congelados', 'Mercearia', 'Bebidas', 'Limpeza', 'Higiene e beleza',
    'Bebê', 'Pet', 'Outros'
  ));

alter table public.item_categories add constraint item_categories_category_check
  check (category in (
    'Hortifruti', 'Açougue e peixaria', 'Padaria', 'Frios e refrigerados',
    'Congelados', 'Mercearia', 'Bebidas', 'Limpeza', 'Higiene e beleza',
    'Bebê', 'Pet', 'Outros'
  ));

-- -----------------------------------------------------------------------------
-- 4) Limpeza LIMITADA (não zera tudo — só o que pode ter sido categorizado
--    errado pelo LLM antigo entre as duas seções que mudaram de regra:
--    "Frios e refrigerados" e "Mercearia", por causa do caso manteiga/leite).
--    Veredictos de usuário (source = 'user') são preservados.
-- -----------------------------------------------------------------------------

-- Cache global: descarta só entradas do LLM nessas duas categorias — a
-- próxima categorização re-consulta o Groq com o prompt novo.
delete from public.item_categories
 where source = 'llm'
   and category in ('Frios e refrigerados', 'Mercearia');

-- Itens de lista já categorizados nessas 2 seções voltam a "sem categoria",
-- exceto quando existe um veredicto de usuário para o mesmo item_key — esse
-- é preservado (fica com a categoria que já tinha).
update public.list_items
   set category = null
 where category in ('Frios e refrigerados', 'Mercearia')
   and not exists (
     select 1 from public.item_categories ic
      where ic.item_key = list_items.normalized_name
        and ic.source = 'user'
   );
