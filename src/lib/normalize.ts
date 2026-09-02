/** Espelho em TS de public.normalize_name(): lower, sem acentos, só [a-z0-9] e espaços simples. */
export function normalizeName(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Extrai dígitos; útil para GTIN/CNPJ/chave de acesso. */
export function onlyDigits(input: string): string {
  return input.replace(/\D+/g, "");
}
