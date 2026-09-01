# Lista de Compras — Fase 1 (esqueleto)

PWA mobile-first de lista de compras compartilhada entre duas pessoas (um "household").
Fases futuras (não fazer agora): histórico de preços via NFC-e, Preço da Hora, encartes, recomendação de loja.

## Stack (já instalada)
- Next.js 16.3 App Router, TypeScript, Tailwind v4, `src/` dir, alias `@/*`. pnpm.
- `@supabase/supabase-js` + `@supabase/ssr`. Serwist (`@serwist/next`, `serwist`) para service worker.
- Deploy alvo: Vercel. Idioma da UI: pt-BR.
- **Next 16 tem mudanças de API.** Antes de escrever código Next, ler os guias em `node_modules/next/dist/docs/01-app/` (ex.: `proxy.md`, `01-metadata/manifest.md`, `02-guides/progressive-web-apps.md`).

## Contrato já escrito (NÃO alterar sem necessidade; se alterar, avisar no relatório final)
- `src/lib/database.types.ts` — tipos do banco. É a fonte da verdade das colunas.
- `src/lib/supabase/client.ts` — `createClient()` para client components (singleton).
- `src/lib/supabase/server.ts` — `createClient()` async para server components/actions.
- `src/proxy.ts` — refresh de sessão + redirect para `/login` quando deslogado. Rotas públicas: `/login`, `/auth/*`.
- `.env.example` — `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.

## Modelo de dados (schema `public`)
- `profiles(id uuid pk -> auth.users, display_name text, created_at)` — criado por trigger em `auth.users` insert (usa `raw_user_meta_data->>'display_name'`, fallback: parte local do email).
- `households(id, name, invite_code text unique not null default código curto de 6 chars [A-Z0-9], created_by -> auth.users default auth.uid(), created_at)`.
- `household_members(household_id, user_id, role text check in ('owner','member') default 'member', joined_at, pk(household_id,user_id))`.
- `lists(id, household_id, name text default 'Compras', is_default bool default false, created_at)`.
- `list_items(id, list_id, name text not null, quantity numeric default 1, unit text, note text, checked bool default false, checked_at, checked_by -> auth.users, added_by -> auth.users default auth.uid(), created_at, updated_at)`; trigger de `updated_at`.
- Funções (todas `security definer`, `set search_path = public`, `revoke all from public; grant execute to authenticated`):
  - `is_household_member(hid uuid) returns boolean` — usada nas policies para evitar recursão de RLS.
  - `create_household(p_name text) returns uuid` — cria household, adiciona `auth.uid()` como owner, cria lista default. Retorna o household id.
  - `join_household(p_code text) returns uuid` — normaliza o código (upper/trim), insere membership (idempotente), retorna household id. Erro claro se código inválido.
- RLS habilitado em todas as tabelas. Regra geral: membro do household lê/escreve tudo daquele household. `profiles`: qualquer autenticado lê; só o dono atualiza. Inserts diretos em `households`/`household_members` NÃO são permitidos via API (usar as RPCs).
- Realtime: `alter publication supabase_realtime add table list_items;` e `alter table list_items replica identity full;`.
- Índices: `list_items(list_id, checked, created_at)`, `household_members(user_id)`.

## Rotas / telas (mobile-first, uma coluna, botões grandes, área segura do iOS)
- `/login` — email + senha, abas "Entrar" / "Criar conta" (criar conta pede nome). Usa `supabase.auth.signInWithPassword` / `signUp` com `options.data.display_name`. Mostrar aviso amigável se a conta precisar de confirmação por email.
- `/` — se o usuário não tem household: tela de onboarding com dois cards: "Criar casa" (nome) e "Entrar com código". Se tem household: redireciona (ou renderiza) a lista default.
- `/lista` — a lista. Campo de adição fixo no rodapé (input + quantidade opcional, Enter adiciona). Itens não marcados em cima, marcados agrupados embaixo ("Comprados", colapsável). Toque marca/desmarca. Swipe ou botão para excluir. Badge com quem adicionou (display_name). Botão "Limpar comprados".
- `/casa` — nome da casa, código de convite grande com botão copiar/compartilhar (Web Share API quando existir), lista de membros, botão sair da conta.
- Realtime: assinar `postgres_changes` em `list_items` filtrando por `list_id`; aplicar INSERT/UPDATE/DELETE no estado local; atualização otimista ao adicionar/marcar.

## Regras para os agentes
- Cada agente só edita os arquivos da sua área (ver tarefa). Se precisar de algo fora, descreva no relatório final em vez de editar.
- NÃO rodar `pnpm build` nem `next dev` (outro agente pode estar rodando; o orquestrador faz o build final). Validar com `pnpm exec tsc --noEmit` e `pnpm lint`.
- Sem bibliotecas novas sem necessidade real. Tailwind puro, sem shadcn nesta fase.
- Código e comentários em português onde for texto de UI; identificadores em inglês.
- Relatório final: lista de arquivos criados/alterados, decisões tomadas, pendências.
