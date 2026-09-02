/** Formatação e parsing de valores em pt-BR usados no modo Compras. */

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dateFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export function formatMoney(value: number | null | undefined): string {
  return value == null || Number.isNaN(value) ? "—" : brl.format(value);
}

export function formatDate(iso: string | null, withTime = false): string {
  if (!iso) return "sem data";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "sem data";
  return withTime ? dateTimeFmt.format(d) : dateFmt.format(d);
}

export function formatQuantity(quantity: number): string {
  return Number.isInteger(quantity) ? String(quantity) : quantity.toLocaleString("pt-BR", { maximumFractionDigits: 3 });
}

/** Valor numérico como texto para um campo `inputMode="decimal"` (vírgula decimal). */
export function toDecimalInput(value: number | null | undefined, digits = 2): string {
  if (value == null || Number.isNaN(value)) return "";
  const fixed = digits === 0 || Number.isInteger(value) ? String(value) : value.toFixed(digits);
  return fixed.replace(".", ",");
}

/**
 * Converte texto digitado ("12,34", "12.34", "R$ 1.234,56") em número.
 * Retorna null se não for um número válido.
 */
export function parseDecimal(text: string): number | null {
  let s = text.trim().replace(/[^\d.,-]/g, "");
  if (!s) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) {
    // Vírgula é o separador decimal; pontos são milhar.
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (lastDot > lastComma) {
    // Ponto é o separador decimal; vírgulas são milhar.
    s = s.replace(/,/g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
