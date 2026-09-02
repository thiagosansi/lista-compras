-- =============================================================================
-- Lista de Compras — migration 0005: índice trigram em products.normalized_name
-- Espelha src/lib/database.types.ts. Idempotente.
-- Pré-requisito: 0001_init.sql e 0002_precos.sql aplicadas (extensão pg_trgm e a
-- coluna generated products.normalized_name já existem a partir da 0002).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- products: índice trigram em normalized_name
-- -----------------------------------------------------------------------------

-- O catálogo (products) vai crescer com a semeadura, e a busca local usa
-- `ilike '%palavra%'` por palavra sobre normalized_name. Mesmo padrão do
-- índice já existente em price_observations (0002_precos.sql).
create index if not exists products_normalized_name_trgm_idx
  on public.products using gin (normalized_name extensions.gin_trgm_ops);
