# Supabase — banco de dados

Schema em `migrations/0001_init.sql` (espelhado por `src/lib/database.types.ts`).
A migration é idempotente: pode ser aplicada mais de uma vez sem quebrar.

## Aplicar a migration

**Opção A — Dashboard (mais simples):** abra o projeto no [Supabase Dashboard](https://supabase.com/dashboard) → *SQL Editor* → cole o conteúdo de `migrations/0001_init.sql` → *Run*.

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

## Realtime

A migration já adiciona `public.list_items` à publication `supabase_realtime` e define `replica identity full` (necessário para o `DELETE` chegar com a linha completa). Se a publication não existir na hora (projeto muito antigo), habilite a tabela em *Database → Publications → supabase_realtime*.

## Chaves para o `.env.local`

*Project Settings → API*: `NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (chave *publishable*/*anon*). Ver `.env.example`.
