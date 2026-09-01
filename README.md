# Lista de Compras

PWA mobile-first de lista de compras compartilhada (fase 1). Veja `SPEC.md` para o contrato técnico e o roadmap.

## Rodar localmente

1. Crie um projeto no Supabase e aplique `supabase/migrations/0001_init.sql` (SQL Editor do dashboard ou `supabase db push`).
2. Copie `.env.example` para `.env.local` e preencha a URL e a publishable key do projeto (Settings → API).
3. Instale e rode:

```bash
pnpm install
pnpm dev
```

Abra no celular pelo IP da máquina na mesma rede (ex.: `http://192.168.0.10:3000`). O service worker fica desligado em dev.

## Deploy (Vercel)

```bash
vercel link
vercel env add NEXT_PUBLIC_SUPABASE_URL
vercel env add NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
vercel --prod
```

Depois, no Supabase em Authentication → URL Configuration, adicione a URL de produção em "Site URL" e "Redirect URLs".

## Fluxo de uso

1. Cada pessoa cria uma conta em `/login`.
2. Uma cria a "casa" e compartilha o código de 6 letras. A outra entra com o código.
3. A lista em `/lista` sincroniza em tempo real entre os dois.
4. No celular, instale como app: Android mostra o banner "Instalar"; no iPhone use Compartilhar → Adicionar à Tela de Início.

## Roadmap

- Fase 2: leitura do QR da NFC-e para histórico de preços por loja.
- Fase 3: integração com Preço da Hora (BA), com cache.
- Fase 4: foto de encarte → promoções estruturadas.
- Fase 5: recomendação de loja única vs. divisão de compras.
