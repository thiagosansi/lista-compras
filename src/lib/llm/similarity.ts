// Similaridade textual simples (coeficiente de Dice sobre bigramas de caracteres).
// Aproxima o `similarity()` do pg_trgm o bastante para ordenar candidatos; não é idêntico.

import { normalizeName } from "@/lib/normalize";

/** Multiconjunto de bigramas da string normalizada (com espaço nas bordas, como o pg_trgm). */
export function bigrams(input: string): Map<string, number> {
  const s = ` ${normalizeName(input)} `;
  const out = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Dice = 2·|A∩B| / (|A|+|B|), em [0, 1]. */
export function diceSimilarity(a: string, b: string): number {
  const ga = bigrams(a);
  const gb = bigrams(b);
  let sizeA = 0;
  let sizeB = 0;
  let common = 0;
  for (const n of ga.values()) sizeA += n;
  for (const n of gb.values()) sizeB += n;
  if (sizeA === 0 || sizeB === 0) return 0;
  for (const [g, n] of ga) {
    const m = gb.get(g);
    if (m) common += Math.min(n, m);
  }
  return (2 * common) / (sizeA + sizeB);
}
