/**
 * Lógica pura (sem React) do resumo "Onde comprar a lista inteira".
 *
 * Regras (ver brief da task):
 * - Para cada loja, total = Σ_item (melhor preço real do item na loja × quantidade).
 * - Item sem preço real na loja usa a MEDIANA dos melhores preços do item nas outras
 *   lojas × quantidade, marcado como estimado.
 * - Item sem preço em loja nenhuma fica fora do total de todas as lojas (não é
 *   "comparável"; a UI mostra esses itens em "Sem preço ainda").
 * - cobertura = itensComPrecoReal / itensComparaveis. Só lojas com cobertura ≥ 50%
 *   concorrem ao título de melhor loja para a lista inteira; as demais são
 *   "cobertura baixa".
 * - Divisão em 2 lojas: entre as 5 melhores elegíveis, testa cada par usando, por
 *   item, o menor preço real entre as duas (ou a mediana se nenhuma das duas tem
 *   preço real do item). Só vale a pena mostrar se economizar mais de 10% em
 *   relação à melhor loja única.
 */

export type PendingItem = {
  id: string;
  name: string;
  quantity: number;
  unit: string | null;
};

/** Formato mínimo de linha de preço aceito por `summarizeStores` (subconjunto de `BestPriceRow`). */
export type SummarizeRow = {
  list_item_id: string;
  store_id: string;
  store_name: string;
  price: number;
};

export type StoreSummary = {
  storeId: string;
  name: string;
  /** Soma dos preços (reais + estimados) dos itens comparáveis, já multiplicados pela quantidade. */
  total: number;
  /** Quantidade de itens que têm preço em pelo menos uma loja (igual para todas as lojas). */
  itensComparaveis: number;
  /** Quantidade de itens com preço real nesta loja. */
  itensComPrecoReal: number;
  /** Quantidade de itens estimados (mediana) nesta loja. */
  estimados: number;
  /** Nomes dos itens estimados nesta loja. */
  estimadosNomes: string[];
  /** itensComPrecoReal / itensComparaveis (0 se não houver itens comparáveis). */
  coverage: number;
  /** true quando coverage >= 0.5 e há ao menos um item comparável. */
  eligible: boolean;
};

export type SplitItemRef = { id: string; name: string };

export type SplitSuggestion = {
  storeAId: string;
  storeAName: string;
  storeBId: string;
  storeBName: string;
  /** Total combinado das duas lojas. */
  total: number;
  /** Economia em reais frente à melhor loja única. */
  economia: number;
  /** Economia proporcional (0.12 = 12%) frente à melhor loja única. */
  economiaPercent: number;
  itemsA: SplitItemRef[];
  itemsB: SplitItemRef[];
};

export type SummarizeResult = {
  /** Todas as lojas: elegíveis (por total crescente) primeiro, depois cobertura baixa. */
  stores: StoreSummary[];
  /** Lojas com cobertura >= 50%, ordenadas por total crescente (empate: maior cobertura). */
  eligible: StoreSummary[];
  /** Lojas com cobertura < 50%, ordenadas por cobertura decrescente (empate: menor total). */
  lowCoverage: StoreSummary[];
  /** Melhor loja para a lista inteira (eligible[0]) ou null se nenhuma loja for elegível. */
  best: StoreSummary | null;
  /** Sugestão de divisão em 2 lojas, só quando economiza mais de 10% frente a `best`. */
  split: SplitSuggestion | null;
};

const SPLIT_MIN_SAVINGS = 0.1;
const SPLIT_CANDIDATE_LIMIT = 5;
const ELIGIBLE_COVERAGE_THRESHOLD = 0.5;

/** Quantidade usada na estimativa: 1 quando a lista não tem quantidade válida. */
export function effectiveQuantity(quantity: number | undefined): number {
  return quantity !== undefined && Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
}

/** Mediana de uma lista de números. Retorna 0 para lista vazia. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Resumo por loja para a lista inteira: total real+estimado por loja, cobertura,
 * loja vencedora (só entre as elegíveis) e sugestão de divisão em 2 lojas.
 */
export function summarizeStores(rows: SummarizeRow[], items: PendingItem[]): SummarizeResult {
  const qtyById = new Map(items.map((i) => [i.id, i.quantity]));
  const nameById = new Map(items.map((i) => [i.id, i.name]));

  // Melhor preço real por (item, loja).
  const bestByItemStore = new Map<string, Map<string, number>>();
  // Nome de toda loja que aparece nas linhas para algum item da lista (mesmo sem preço válido).
  const storeNames = new Map<string, string>();

  for (const r of rows) {
    if (!qtyById.has(r.list_item_id)) continue;
    storeNames.set(r.store_id, r.store_name);
    const price = Number(r.price);
    if (!Number.isFinite(price)) continue;
    let byStore = bestByItemStore.get(r.list_item_id);
    if (!byStore) {
      byStore = new Map<string, number>();
      bestByItemStore.set(r.list_item_id, byStore);
    }
    const cur = byStore.get(r.store_id);
    if (cur === undefined || price < cur) byStore.set(r.store_id, price);
  }

  // Itens comparáveis: têm preço real em pelo menos uma loja.
  const comparableItemIds = [...bestByItemStore.keys()].filter((id) => (bestByItemStore.get(id)?.size ?? 0) > 0);
  const itensComparaveis = comparableItemIds.length;

  const medianByItem = new Map<string, number>();
  for (const itemId of comparableItemIds) {
    medianByItem.set(itemId, median([...(bestByItemStore.get(itemId)?.values() ?? [])]));
  }

  const stores: StoreSummary[] = [...storeNames.entries()].map(([storeId, name]) => {
    let total = 0;
    let itensComPrecoReal = 0;
    const estimadosNomes: string[] = [];
    for (const itemId of comparableItemIds) {
      const qty = effectiveQuantity(qtyById.get(itemId));
      const realPrice = bestByItemStore.get(itemId)?.get(storeId);
      if (realPrice !== undefined) {
        itensComPrecoReal += 1;
        total += realPrice * qty;
      } else {
        total += (medianByItem.get(itemId) ?? 0) * qty;
        estimadosNomes.push(nameById.get(itemId) ?? itemId);
      }
    }
    const coverage = itensComparaveis > 0 ? itensComPrecoReal / itensComparaveis : 0;
    return {
      storeId,
      name,
      total,
      itensComparaveis,
      itensComPrecoReal,
      estimados: estimadosNomes.length,
      estimadosNomes,
      coverage,
      eligible: itensComparaveis > 0 && coverage >= ELIGIBLE_COVERAGE_THRESHOLD,
    };
  });

  const eligible = stores
    .filter((s) => s.eligible)
    .sort((a, b) => a.total - b.total || b.coverage - a.coverage || a.name.localeCompare(b.name));
  const lowCoverage = stores
    .filter((s) => !s.eligible)
    .sort((a, b) => b.coverage - a.coverage || a.total - b.total || a.name.localeCompare(b.name));

  const best = eligible[0] ?? null;
  const split = findSplitSuggestion(eligible, comparableItemIds, bestByItemStore, medianByItem, qtyById, nameById);

  return { stores: [...eligible, ...lowCoverage], eligible, lowCoverage, best, split };
}

function findSplitSuggestion(
  eligible: StoreSummary[],
  comparableItemIds: string[],
  bestByItemStore: Map<string, Map<string, number>>,
  medianByItem: Map<string, number>,
  qtyById: Map<string, number>,
  nameById: Map<string, string>,
): SplitSuggestion | null {
  if (eligible.length < 2) return null;
  const bestSingleTotal = eligible[0].total;
  if (!(bestSingleTotal > 0)) return null;

  const candidates = eligible.slice(0, SPLIT_CANDIDATE_LIMIT);
  let bestPair: {
    a: StoreSummary;
    b: StoreSummary;
    total: number;
    itemsA: SplitItemRef[];
    itemsB: SplitItemRef[];
  } | null = null;

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
      let total = 0;
      const itemsA: SplitItemRef[] = [];
      const itemsB: SplitItemRef[] = [];
      for (const itemId of comparableItemIds) {
        const qty = effectiveQuantity(qtyById.get(itemId));
        const realA = bestByItemStore.get(itemId)?.get(a.storeId);
        const realB = bestByItemStore.get(itemId)?.get(b.storeId);
        const name = nameById.get(itemId) ?? itemId;
        let price: number;
        let chooseA: boolean;
        if (realA !== undefined && realB !== undefined) {
          chooseA = realA <= realB;
          price = chooseA ? realA : realB;
        } else if (realA !== undefined) {
          chooseA = true;
          price = realA;
        } else if (realB !== undefined) {
          chooseA = false;
          price = realB;
        } else {
          chooseA = true;
          price = medianByItem.get(itemId) ?? 0;
        }
        total += price * qty;
        (chooseA ? itemsA : itemsB).push({ id: itemId, name });
      }
      if (!bestPair || total < bestPair.total) {
        bestPair = { a, b, total, itemsA, itemsB };
      }
    }
  }

  if (!bestPair) return null;
  const economia = bestSingleTotal - bestPair.total;
  const economiaPercent = economia / bestSingleTotal;
  if (economiaPercent <= SPLIT_MIN_SAVINGS) return null;

  return {
    storeAId: bestPair.a.storeId,
    storeAName: bestPair.a.name,
    storeBId: bestPair.b.storeId,
    storeBName: bestPair.b.name,
    total: bestPair.total,
    economia,
    economiaPercent,
    itemsA: bestPair.itemsA,
    itemsB: bestPair.itemsB,
  };
}
