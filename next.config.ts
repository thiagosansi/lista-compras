import withSerwistInit from "@serwist/next";
import type { NextConfig } from "next";

/**
 * PWA / service worker (Serwist)
 *
 * `@serwist/next` só funciona com webpack. No Next 16 o bundler padrão é o
 * Turbopack (dev e build), então:
 *  - `next dev` (Turbopack): sem service worker. O wrapper nem é aplicado,
 *    porque o Next aborta quando há chave `webpack` na config com Turbopack.
 *  - `next build --webpack`: gera `public/sw.js` + `public/swe-worker-*.js` e
 *    registra o SW automaticamente no client.
 *  - `next build` (Turbopack) sem `DISABLE_PWA=1`: falha de propósito, para não
 *    publicar o app silenciosamente sem service worker.
 */
const isDev = process.env.NODE_ENV === "development";
const isTurbopack = Boolean(process.env.TURBOPACK);
const pwaDisabled = process.env.DISABLE_PWA === "1";
// Só o `next build` deve falhar; `next typegen`, `next lint` etc. também carregam a config.
const isBuild = process.argv.includes("build");

if (isBuild && !isDev && isTurbopack && !pwaDisabled) {
  throw new Error(
    "[PWA] O service worker (Serwist) precisa do webpack. Rode `next build --webpack` " +
      "(ajuste o script `build` no package.json) ou defina DISABLE_PWA=1 para buildar sem PWA.",
  );
}

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // O SW nunca deve ficar preso em cache HTTP.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
    ];
  },
};

const withSerwist = withSerwistInit({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  disable: isDev || pwaDisabled,
  // Não recarregar a página ao voltar online: o Supabase Realtime reconecta
  // sozinho e um reload perderia o que a pessoa estiver digitando.
  reloadOnOnline: false,
});

export default isTurbopack ? nextConfig : withSerwist(nextConfig);
