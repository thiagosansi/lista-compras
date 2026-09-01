import type { MetadataRoute } from "next";

// Cores também usadas em layout.tsx (viewport.themeColor). Manter em sincronia.
const THEME_COLOR = "#16a34a";
const BACKGROUND_COLOR = "#fafafa";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Lista de Compras",
    short_name: "Compras",
    description: "Lista de compras compartilhada entre as pessoas da casa",
    id: "/lista",
    start_url: "/lista",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    lang: "pt-BR",
    dir: "ltr",
    background_color: BACKGROUND_COLOR,
    theme_color: THEME_COLOR,
    categories: ["shopping", "productivity"],
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
