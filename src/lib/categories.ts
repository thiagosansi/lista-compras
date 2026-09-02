/** Categorias fixas usadas para agrupar a lista no modo Compras (ordem = ordem típica de percurso no mercado). */
export const CATEGORIES = [
  "Hortifruti",
  "Açougue e peixaria",
  "Padaria",
  "Frios e refrigerados",
  "Congelados",
  "Mercearia",
  "Bebidas",
  "Limpeza",
  "Higiene e beleza",
  "Bebê",
  "Pet",
  "Outros",
] as const;

export type Category = (typeof CATEGORIES)[number];

export function isCategory(v: unknown): v is Category {
  return typeof v === "string" && (CATEGORIES as readonly string[]).includes(v);
}

export const DEFAULT_CATEGORY: Category = "Outros";

/** Categorias antigas que deixaram de existir → categoria nova equivalente (ver migration 0006_secoes.sql). */
export const LEGACY_CATEGORY_MAP = {
  "Frios e laticínios": "Frios e refrigerados",
} as const;

/**
 * Normaliza um valor de categoria: aplica `LEGACY_CATEGORY_MAP` (categoria antiga → nova) e valida
 * contra `CATEGORIES`. Devolve `undefined` se o valor não for uma categoria (antiga ou atual) conhecida.
 */
export function normalizeCategory(v: unknown): Category | undefined {
  if (typeof v !== "string") return undefined;
  const mapped = (LEGACY_CATEGORY_MAP as Record<string, Category>)[v] ?? v;
  return isCategory(mapped) ? mapped : undefined;
}
