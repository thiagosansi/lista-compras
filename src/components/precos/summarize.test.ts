import assert from "node:assert/strict";
import { test } from "node:test";
import { median, summarizeStores, type PendingItem, type SummarizeRow } from "./summarize";

const items: PendingItem[] = [
  { id: "i1", name: "Arroz", quantity: 2, unit: "kg" },
  { id: "i2", name: "Feijão", quantity: 1, unit: "kg" },
  { id: "i3", name: "Açúcar", quantity: 3, unit: null },
];

function row(itemId: string, storeId: string, storeName: string, price: number): SummarizeRow {
  return { list_item_id: itemId, store_id: storeId, store_name: storeName, price };
}

test("median: casos base", () => {
  assert.equal(median([]), 0);
  assert.equal(median([5]), 5);
  assert.equal(median([1, 3]), 2);
  assert.equal(median([1, 2, 3]), 2);
});

test("summarizeStores: total por loja com estimativa por mediana", () => {
  // Loja A: tem os 3 itens. Loja B: só i1 e i2 (falta i3, estimado pela mediana de i3
  // entre as outras lojas = mediana de [3] = 3). Loja C: só i3.
  const rows: SummarizeRow[] = [
    row("i1", "A", "Loja A", 10),
    row("i2", "A", "Loja A", 5),
    row("i3", "A", "Loja A", 4),
    row("i1", "B", "Loja B", 8),
    row("i2", "B", "Loja B", 6),
    row("i3", "C", "Loja C", 3),
  ];

  const result = summarizeStores(rows, items);

  assert.equal(result.stores.length, 3);
  const byId = new Map(result.stores.map((s) => [s.storeId, s]));

  const a = byId.get("A")!;
  assert.equal(a.itensComparaveis, 3);
  assert.equal(a.itensComPrecoReal, 3);
  assert.equal(a.estimados, 0);
  assert.equal(a.coverage, 1);
  assert.equal(a.eligible, true);
  // 10*2 + 5*1 + 4*3 = 20 + 5 + 12 = 37
  assert.equal(a.total, 37);

  const b = byId.get("B")!;
  assert.equal(b.itensComPrecoReal, 2);
  assert.equal(b.estimados, 1);
  assert.deepEqual(b.estimadosNomes, ["Açúcar"]);
  // mediana de i3 entre as lojas que o têm (A=4, C=3) => 3.5
  // 8*2 + 6*1 + 3.5*3 = 16 + 6 + 10.5 = 32.5
  assert.equal(b.total, 32.5);
  assert.ok(b.coverage >= 0.5);
  assert.equal(b.eligible, true);

  const c = byId.get("C")!;
  assert.equal(c.itensComPrecoReal, 1);
  assert.equal(c.coverage, 1 / 3);
  assert.equal(c.eligible, false); // cobertura < 50%

  assert.equal(result.eligible.length, 2);
  assert.equal(result.lowCoverage.length, 1);
  assert.equal(result.lowCoverage[0].storeId, "C");

  // Vencedora só entre elegíveis: B (32.5) < A (37).
  assert.equal(result.best?.storeId, "B");
});

test("summarizeStores: item sem preço em loja nenhuma não entra em nenhum total", () => {
  const noPriceItems: PendingItem[] = [...items, { id: "i4", name: "Café", quantity: 1, unit: null }];
  const rows: SummarizeRow[] = [
    row("i1", "A", "Loja A", 10),
    row("i2", "A", "Loja A", 5),
    row("i3", "A", "Loja A", 4),
  ];
  const result = summarizeStores(rows, noPriceItems);
  const a = result.stores.find((s) => s.storeId === "A")!;
  assert.equal(a.itensComparaveis, 3); // i4 não é comparável
  assert.equal(a.total, 37);
});

test("summarizeStores: quantidade inválida conta como 1", () => {
  const badQtyItems: PendingItem[] = [{ id: "i1", name: "Arroz", quantity: 0, unit: null }];
  const rows: SummarizeRow[] = [row("i1", "A", "Loja A", 10)];
  const result = summarizeStores(rows, badQtyItems);
  assert.equal(result.stores[0].total, 10);
});

test("summarizeStores: loja única não elegível quando cobertura < 50%", () => {
  const rows: SummarizeRow[] = [
    row("i1", "A", "Loja A", 10),
    row("i2", "B", "Loja B", 5),
    row("i3", "C", "Loja C", 4),
  ];
  const result = summarizeStores(rows, items);
  for (const s of result.stores) {
    assert.equal(s.coverage, 1 / 3);
    assert.equal(s.eligible, false);
  }
  assert.equal(result.best, null);
  assert.equal(result.eligible.length, 0);
  assert.equal(result.lowCoverage.length, 3);
});

test("summarizeStores: loja com 0 preço real vai para cobertura baixa", () => {
  const rows: SummarizeRow[] = [
    row("i1", "A", "Loja A", 10),
    row("i2", "A", "Loja A", 5),
    row("i3", "A", "Loja A", 4),
    // Loja B só manda preço inválido (NaN) para um item da lista: aparece, cobertura 0.
    row("i1", "B", "Loja B", NaN),
  ];
  const result = summarizeStores(rows, items);
  const b = result.stores.find((s) => s.storeId === "B")!;
  assert.equal(b.itensComPrecoReal, 0);
  assert.equal(b.coverage, 0);
  assert.equal(b.eligible, false);
  assert.ok(result.lowCoverage.some((s) => s.storeId === "B"));
});

test("split: não sugere divisão quando só há uma loja elegível", () => {
  const rows: SummarizeRow[] = [
    row("i1", "A", "Loja A", 10),
    row("i2", "A", "Loja A", 5),
    row("i3", "A", "Loja A", 4),
  ];
  const result = summarizeStores(rows, items);
  assert.equal(result.eligible.length, 1);
  assert.equal(result.split, null);
});

test("split: sugere divisão quando economiza mais de 10%", () => {
  // Loja A: barata em i1, cara em i2 e i3. Loja B: cara em i1, barata em i2 e i3.
  // Ambas cobrem 100% (elegíveis). Comprar cada item na loja mais barata economiza bastante.
  const rows: SummarizeRow[] = [
    row("i1", "A", "Loja A", 1),
    row("i2", "A", "Loja A", 100),
    row("i3", "A", "Loja A", 100),
    row("i1", "B", "Loja B", 100),
    row("i2", "B", "Loja B", 1),
    row("i3", "B", "Loja B", 1),
  ];
  const result = summarizeStores(rows, items);
  assert.equal(result.eligible.length, 2);
  // Melhor loja única: A = 1*2 + 100*1 + 100*3 = 402; B = 100*2 + 1*1 + 1*3 = 204.
  assert.equal(result.best?.storeId, "B");
  assert.equal(result.best?.total, 204);
  // Par: i1 em A (1*2=2), i2 em B (1*1=1), i3 em B (1*3=3) = 6. Economia >> 10%.
  assert.ok(result.split);
  assert.equal(result.split?.total, 6);
  assert.ok(result.split!.economiaPercent > 0.1);
  // O par é {A, B}; cada item vai para a loja mais barata dele, independente de qual
  // lado (storeA/storeB) a função atribuiu a cada loja.
  const buyAt = new Map<string, string>();
  for (const it of result.split!.itemsA) buyAt.set(it.name, result.split!.storeAId);
  for (const it of result.split!.itemsB) buyAt.set(it.name, result.split!.storeBId);
  assert.equal(buyAt.get("Arroz"), "A");
  assert.equal(buyAt.get("Feijão"), "B");
  assert.equal(buyAt.get("Açúcar"), "B");
});

test("split: não sugere divisão quando a economia é 10% ou menos", () => {
  // Todas as lojas com o mesmo preço em todos os itens: dividir não economiza nada.
  const rows: SummarizeRow[] = [
    row("i1", "A", "Loja A", 10),
    row("i2", "A", "Loja A", 5),
    row("i3", "A", "Loja A", 4),
    row("i1", "B", "Loja B", 10),
    row("i2", "B", "Loja B", 5),
    row("i3", "B", "Loja B", 4),
  ];
  const result = summarizeStores(rows, items);
  assert.equal(result.eligible.length, 2);
  assert.equal(result.split, null);
});
