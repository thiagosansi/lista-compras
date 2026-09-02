# Supabase — banco de dados

Schema em `migrations/*.sql` (espelhado por `src/lib/database.types.ts`).
As migrations são idempotentes: podem ser aplicadas mais de uma vez sem quebrar. Aplique em ordem:

1. `0001_init.sql` — Fase 1 (households, listas, itens, RLS, realtime).
2. `0002_precos.sql` — Fases 2/3 (histórico de preços). Requer a 0001 já aplicada.
3. `0003_matches.sql` — Fase 4 (veredictos de correspondência). Requer a 0002 já aplicada.

## Aplicar as migrations

**Opção A — Dashboard (mais simples):** abra o projeto no [Supabase Dashboard](https://supabase.com/dashboard) → *SQL Editor* → cole o conteúdo de `migrations/0001_init.sql` → *Run*; repita com `migrations/0002_precos.sql` e `migrations/0003_matches.sql`.

**Opção B — CLI:**

```bash
supabase login
supabase link --project-ref <ref-do-projeto>
supabase db push
```

## Configurar Auth

Em *Authentication → Providers → Email*:

- **Confirm email**: pode ficar **ligado** (o Supabase envia 1 email por cadastro e o usuário só entra depois de confirmar; a tela `/login` avisa isso) ou **desligado** para simplificar o teste entre duas pessoas. Qualquer um dos dois funciona com o app.
- O nome informado no cadastro vai em `options.data.display_name` e vira `profiles.display_name` via trigger em `auth.users`.

## Preços (migration 0002)

- Habilita as extensões `unaccent` e `pg_trgm` no schema `extensions` (padrão do Supabase; *Database → Extensions* também serve, mas a migration já faz isso).
- Cria `public.immutable_unaccent` e `public.normalize_name` (espelho de `src/lib/normalize.ts`), usadas em colunas `normalized_name` *generated stored* de `products`, `price_observations` e `list_items`.
- Tabelas `stores` e `products` são catálogo compartilhado entre todos os households (qualquer usuário logado lê/insere/atualiza, ninguém apaga). `receipts`, `receipt_items` e `price_observations` seguem `is_household_member`.
- Índice único parcial em `price_observations` (`where source = 'precodahora'`) evita duplicar leituras do Preço da Hora ao "Atualizar preços" de novo.
- RPC `best_prices(p_list_id, p_max_age_hours default 336)` roda como *security invoker*: a RLS se aplica, então só membros do household da lista recebem linhas. Usa `extensions.similarity` qualificado (as funções do `pg_trgm` não estão no `search_path` padrão do Supabase).

## Correspondências (migration 0003)

- Tabela `item_matches`: veredicto por household de "esta descrição (Preço da Hora/cupom) é este item da lista?", chaveado por `normalize_name` do item e da descrição (`item_key`, `description_key`), `source` = `llm` ou `user`. RLS por `is_household_member`. Único `(household_id, item_key, description_key)` — é o `onConflict` do upsert da rota.
- Trigger `before update`: um veredicto `source='user'` nunca é sobrescrito por um update com `source='llm'` (mantém `is_match`, `source` e `reason`); `updated_at` é atualizado sempre.
- `best_prices` recriada (mesma assinatura/colunas): veredicto `is_match=false` exclui a observação; `is_match=true` devolve `match_kind` = `llm`/`user` com `score = 1`; sem veredicto valem as regras antigas, com o limiar de similaridade por nome subindo de 0.35 para 0.5.

## Realtime

A migration já adiciona `public.list_items` à publication `supabase_realtime` e define `replica identity full` (necessário para o `DELETE` chegar com a linha completa). Se a publication não existir na hora (projeto muito antigo), habilite a tabela em *Database → Publications → supabase_realtime*.

## Chaves para o `.env.local`

*Project Settings → API*: `NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (chave *publishable*/*anon*). Ver `.env.example`.
