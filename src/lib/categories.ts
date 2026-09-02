/** Categorias fixas usadas para agrupar a lista no modo Compras (ordem = ordem típica de percurso no mercado). */
export const CATEGORIES = [
  "Hortifruti",
  "Açougue e peixaria",
  "Frios e laticínios",
  "Padaria",
  "Mercearia",
  "Bebidas",
  "Congelados",
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
