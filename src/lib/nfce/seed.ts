/**
 * Montagem pura dos dados de "semeadura" do catálogo de produtos a partir de um cupom NFC-e
 * já interpretado (ver `parse.ts`). Sem I/O: usado por `route.ts` (que faz o upsert/select no
 * Supabase) e testado isoladamente em `seed.test.ts`.
 */
import type { ParsedItem } from "./parse";
import { isValidGtin } from "./parse";

export type ProductSeedRow = { gtin: string; name: string };

/**
 * Coleta os GTINs válidos dos itens do cupom, dedupados, usando a descrição do primeiro item
 * de cada GTIN como nome. Itens sem GTIN válido ou com descrição vazia (após trim) são ignorados.
 */
export function collectProductSeeds(items: ParsedItem[]): ProductSeedRow[] {
  const byGtin = new Map<string, string>();
  for (const item of items) {
    if (!item.gtin || !isValidGtin(item.gtin)) continue;
    const name = item.description.replace(/\s+/g, " ").trim();
    if (!name) continue;
    if (!byGtin.has(item.gtin)) byGtin.set(item.gtin, name);
  }
  return [...byGtin].map(([gtin, name]) => ({ gtin, name }));
}

export type ReceiptItemInsert = {
  receipt_id: string;
  product_id: string | null;
  description: string;
  gtin: string | null;
  quantity: number;
  unit: string | null;
  unit_price: number;
  total: number;
  position: number;
};

/** Monta os inserts de `receipt_items`, preenchendo `product_id` quando o GTIN do item foi mapeado. */
export function buildReceiptItemInserts(
  items: ParsedItem[],
  receiptId: string,
  productIdByGtin: Map<string, string>,
): ReceiptItemInsert[] {
  return items.map((item, position) => ({
    receipt_id: receiptId,
    product_id: (item.gtin && productIdByGtin.get(item.gtin)) || null,
    description: item.description,
    gtin: item.gtin,
    quantity: item.quantity,
    unit: item.unit,
    unit_price: item.unitPrice,
    total: item.total,
    position,
  }));
}

export type PriceObservationInsert = {
  household_id: string;
  store_id: string;
  product_id: string | null;
  receipt_item_id: string | null;
  gtin: string | null;
  description: string;
  price: number;
  unit: string | null;
  observed_at: string;
  source: "nfce";
};

export type PriceObservationContext = {
  householdId: string;
  storeId: string;
  observedAt: string;
  /** id de `receipt_items` por posição do item no cupom. */
  receiptItemIdByPosition: Map<number, string>;
  productIdByGtin: Map<string, string>;
};

/** Monta os inserts de `price_observations` (itens com `unitPrice > 0`), com `product_id` quando mapeado. */
export function buildPriceObservationInserts(
  items: ParsedItem[],
  ctx: PriceObservationContext,
): PriceObservationInsert[] {
  return items
    .map((item, position) => ({ item, position }))
    .filter(({ item }) => item.unitPrice > 0)
    .map(({ item, position }) => ({
      household_id: ctx.householdId,
      store_id: ctx.storeId,
      product_id: (item.gtin && ctx.productIdByGtin.get(item.gtin)) || null,
      receipt_item_id: ctx.receiptItemIdByPosition.get(position) ?? null,
      gtin: item.gtin,
      description: item.description,
      price: item.unitPrice,
      unit: item.unit,
      observed_at: ctx.observedAt,
      source: "nfce" as const,
    }));
}
