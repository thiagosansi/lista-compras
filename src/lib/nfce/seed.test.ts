/**
 * Testes leves de seed.ts (sem framework). Como rodar (na raiz do projeto):
 *
 *   OUT=/tmp/nfce-seed-test && pnpm exec tsc src/lib/nfce/parse.ts src/lib/nfce/seed.ts src/lib/nfce/seed.test.ts \
 *     --outDir "$OUT" --module commonjs --target es2022 --types node --skipLibCheck --esModuleInterop \
 *   && node --test "$OUT/seed.test.js"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ParsedItem } from "./parse";
import { collectProductSeeds, buildReceiptItemInserts, buildPriceObservationInserts } from "./seed";

function item(partial: Partial<ParsedItem>): ParsedItem {
  return {
    description: "Item",
    code: null,
    gtin: null,
    quantity: 1,
    unit: "UN",
    unitPrice: 1,
    total: 1,
    ...partial,
  };
}

test("collectProductSeeds: ignora itens sem GTIN válido", () => {
  const items = [
    item({ description: "Refrigerante", gtin: "7891000100103" }), // EAN-13 válido
    item({ description: "Sem GTIN (código interno)", gtin: null }),
    item({ description: "GTIN inválido", gtin: "1234567890123" }), // dígito verificador errado
  ];
  const seeds = collectProductSeeds(items);
  assert.deepEqual(seeds, [{ gtin: "7891000100103", name: "Refrigerante" }]);
});

test("collectProductSeeds: dedup por GTIN mantém a primeira descrição", () => {
  const items = [
    item({ description: "Arroz 5kg", gtin: "7891000100103" }),
    item({ description: "Arroz Tipo 1 5kg", gtin: "7891000100103" }),
  ];
  const seeds = collectProductSeeds(items);
  assert.deepEqual(seeds, [{ gtin: "7891000100103", name: "Arroz 5kg" }]);
});

test("collectProductSeeds: ignora descrição vazia após trim", () => {
  const items = [item({ description: "   ", gtin: "7891000100103" })];
  assert.deepEqual(collectProductSeeds(items), []);
});

test("buildReceiptItemInserts: preenche product_id quando o GTIN está mapeado", () => {
  const items = [
    item({ description: "Refrigerante", gtin: "7891000100103" }),
    item({ description: "Sem GTIN", gtin: null }),
  ];
  const productIdByGtin = new Map([["7891000100103", "prod-1"]]);
  const rows = buildReceiptItemInserts(items, "receipt-1", productIdByGtin);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].product_id, "prod-1");
  assert.equal(rows[0].gtin, "7891000100103");
  assert.equal(rows[0].position, 0);
  assert.equal(rows[1].product_id, null);
  assert.equal(rows[1].gtin, null);
  assert.equal(rows[1].position, 1);
});

test("buildReceiptItemInserts: item com GTIN não mapeado (falha no seed) fica sem product_id", () => {
  const items = [item({ description: "Refrigerante", gtin: "7891000100103" })];
  const rows = buildReceiptItemInserts(items, "receipt-1", new Map());
  assert.equal(rows[0].product_id, null);
});

test("buildPriceObservationInserts: ignora itens com unitPrice <= 0 e preenche product_id", () => {
  const items = [
    item({ description: "Refrigerante", gtin: "7891000100103", unitPrice: 7.5 }),
    item({ description: "Brinde", gtin: null, unitPrice: 0 }),
  ];
  const rows = buildPriceObservationInserts(items, {
    householdId: "hh-1",
    storeId: "store-1",
    observedAt: "2025-07-24T18:18:27-03:00",
    receiptItemIdByPosition: new Map([[0, "ri-1"], [1, "ri-2"]]),
    productIdByGtin: new Map([["7891000100103", "prod-1"]]),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].product_id, "prod-1");
  assert.equal(rows[0].receipt_item_id, "ri-1");
  assert.equal(rows[0].source, "nfce");
});
