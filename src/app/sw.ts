/// <reference lib="webworker" />
// Service worker gerado pelo @serwist/next (webpack) em `public/sw.js`.
// Em desenvolvimento o SW fica desabilitado (ver next.config.ts).
import { defaultCache } from "@serwist/next/worker";
import { NetworkOnly, Serwist, type PrecacheEntry, type SerwistGlobalConfig } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    // Injetado pelo InjectManifest no build (lista de assets para precache).
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const isSupabaseRequest = (url: URL) =>
  url.hostname.endsWith(".supabase.co") || url.hostname.endsWith(".supabase.in");

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    // Supabase (REST, auth, realtime): nunca cachear — sempre rede.
    // Requisições não-GET não são interceptadas por nenhuma rota.
    {
      matcher: ({ url }) => isSupabaseRequest(url),
      handler: new NetworkOnly(),
    },
    // Rotas de auth do próprio app (callback/confirm) também só rede.
    {
      matcher: ({ sameOrigin, url }) => sameOrigin && url.pathname.startsWith("/auth/"),
      handler: new NetworkOnly(),
    },
    ...defaultCache,
  ],
});

// Fallback offline simples: quando uma navegação (HTML) falha e não há cache,
// responde com uma página mínima em vez do erro do navegador.
const OFFLINE_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Sem conexão · Lista de Compras</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif;background:#fafafa;color:#18181b;padding:24px;text-align:center}
  main{max-width:360px}
  h1{font-size:1.25rem;margin:0 0 8px}
  p{margin:0 0 20px;color:#52525b;line-height:1.5}
  button{font:inherit;font-weight:600;background:#16a34a;color:#fff;border:0;border-radius:12px;padding:14px 20px;width:100%}
</style>
</head>
<body>
<main>
  <h1>Você está sem conexão</h1>
  <p>Não foi possível carregar a lista. Verifique sua internet e tente de novo.</p>
  <button onclick="location.reload()">Tentar novamente</button>
</main>
</body>
</html>`;

serwist.setCatchHandler(async ({ request }) => {
  if (request.destination === "document") {
    return new Response(OFFLINE_HTML, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  return Response.error();
});

serwist.addEventListeners();
