// Gera os ícones PNG da PWA a partir de um SVG (cesta sobre fundo verde).
// Uso: node scripts/gen-icons.mjs
// Usa o `sharp` que o Next.js já traz como dependência (sem instalar nada novo).
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "public", "icons");

const THEME = "#16a34a";
const THEME_DARK = "#15803d";

async function loadSharp() {
  try {
    return (await import("sharp")).default;
  } catch {
    // pnpm não faz hoist: resolve o sharp a partir do pacote `next`.
    const nextDir = path.dirname(require.resolve("next/package.json"));
    const sharpPath = require.resolve("sharp", { paths: [nextDir] });
    return (await import(sharpPath)).default;
  }
}

/**
 * Desenha uma cesta de compras branca com um check.
 * @param {object} o
 * @param {number} o.size tamanho final em px
 * @param {number} o.padding fração do tamanho reservada como margem (0..0.5)
 * @param {number} o.radius raio dos cantos do fundo (0 = quadrado cheio)
 * @param {boolean} o.transparent fundo fora do arredondamento transparente
 */
function svgIcon({ size, padding, radius, transparent }) {
  const bg = transparent
    ? `<rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="url(#g)"/>`
    : `<rect x="0" y="0" width="${size}" height="${size}" fill="url(#g)"/>`;

  // Cesta desenhada num viewBox 100x100 e escalada para a área útil.
  const inner = size * (1 - padding * 2);
  const offset = size * padding;
  const scale = inner / 100;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${THEME}"/>
      <stop offset="1" stop-color="${THEME_DARK}"/>
    </linearGradient>
  </defs>
  ${bg}
  <g transform="translate(${offset} ${offset}) scale(${scale})" fill="none" stroke="#ffffff" stroke-linecap="round" stroke-linejoin="round">
    <!-- alça -->
    <path d="M32 42 L45 18 M68 42 L55 18" stroke-width="7"/>
    <!-- corpo da cesta -->
    <path d="M14 42 H86 L78 80 Q77 86 71 86 H29 Q23 86 22 80 Z" stroke-width="7" fill="#ffffff" fill-opacity="0.12"/>
    <!-- gomos -->
    <path d="M38 54 L40 74 M50 54 V74 M62 54 L60 74" stroke-width="6" stroke-opacity="0.9"/>
  </g>
</svg>`;
}

async function main() {
  const sharp = await loadSharp();
  await mkdir(outDir, { recursive: true });

  const targets = [
    // "any": cantos arredondados com fundo transparente fora do raio.
    { file: "icon-192.png", size: 192, padding: 0.14, radius: 0.2, transparent: true },
    { file: "icon-512.png", size: 512, padding: 0.14, radius: 0.2, transparent: true },
    // "maskable": fundo cheio, desenho dentro da zona segura (80% central).
    { file: "icon-512-maskable.png", size: 512, padding: 0.22, radius: 0, transparent: false },
    // iOS aplica a própria máscara; precisa ser opaco e sem transparência.
    { file: "apple-touch-icon.png", size: 180, padding: 0.16, radius: 0, transparent: false },
  ];

  for (const t of targets) {
    const svg = svgIcon({
      size: t.size,
      padding: t.padding,
      radius: Math.round(t.size * t.radius),
      transparent: t.transparent,
    });
    const png = await sharp(Buffer.from(svg), { density: 384 })
      .resize(t.size, t.size)
      .png({ compressionLevel: 9 })
      .toBuffer();
    await writeFile(path.join(outDir, t.file), png);
    console.log(`ok  ${path.relative(root, path.join(outDir, t.file))}  ${t.size}x${t.size}  ${png.length} bytes`);
  }

  // SVG de referência (fonte dos ícones), útil para retocar depois.
  await writeFile(
    path.join(outDir, "icon.svg"),
    svgIcon({ size: 512, padding: 0.14, radius: 102, transparent: true }),
  );
  console.log("ok  public/icons/icon.svg");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
