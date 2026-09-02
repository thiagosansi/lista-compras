/**
 * Title Case simples para descrições de produto (geralmente vindas em CAIXA ALTA do Preço da Hora / NFC-e).
 * "LEITE UHT INTEGRAL PIRACANJUBA 1L" → "Leite UHT Integral Piracanjuba 1L"
 * "ARROZ TIPO 1 500G" → "Arroz Tipo 1 500g"
 */

/** Palavras que ficam em minúsculas (exceto no início). */
const LOWER_WORDS = new Set(["de", "da", "do", "das", "dos", "e", "em", "com", "sem", "a", "o", "ao", "para", "p", "c", "s"]);

/** Siglas que devem permanecer em maiúsculas mesmo com 4+ letras. */
const KEEP_UPPER = new Set(["UHT", "UAT", "PET", "LED", "USB", "SPF", "FPS", "IPA", "APA", "IGP", "DOP"]);

/** Unidades que ficam em minúsculas depois de um número ("500G" → "500g"); "L" fica maiúsculo ("1L"). */
const UNIT_RE = /^(\d+(?:[.,]\d+)?)([a-z]{1,3})$/i;

function formatToken(raw: string, index: number): string {
  if (!raw) return raw;

  // Número + unidade: 500G → 500g, 1L → 1L, 2KG → 2kg, 200ML → 200ml.
  const unit = UNIT_RE.exec(raw);
  if (unit) {
    const [, num, u] = unit;
    return num + (u.toUpperCase() === "L" ? "L" : u.toLowerCase());
  }

  // Só dígitos/pontuação: mantém.
  if (!/[a-zà-ÿ]/i.test(raw)) return raw;

  const upper = raw.toUpperCase();
  if (KEEP_UPPER.has(upper)) return upper;

  const lower = raw.toLowerCase();
  if (index > 0 && LOWER_WORDS.has(lower)) return lower;

  // Sigla curta (até 3 letras, tudo maiúsculo, sem vogal ou já conhecida): preserva. Ex.: PCT, CX, KG, UN.
  const isAllUpper = raw === upper && /^[A-Z]+$/.test(raw);
  if (isAllUpper && raw.length <= 3 && !/[AEIOU]/.test(raw)) return upper;

  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Converte a descrição para um nome legível; preserva siglas curtas e normaliza unidades. */
export function formatProductName(descricao: string): string {
  const words = descricao.trim().replace(/\s+/g, " ").split(" ");
  return words
    .map((word, i) =>
      // Trata separadores internos (ex.: "LEITE/UHT", "SEMI-DESNATADO") parte a parte.
      word
        .split(/([/-])/)
        .map((part) => (part === "/" || part === "-" ? part : formatToken(part, i)))
        .join(""),
    )
    .join(" ");
}
