"use client";

import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import type { BestPriceRow, PriceSource } from "@/lib/database.types";
import { AppHeader } from "@/components/app-header";
import { TabBar, TAB_BAR_PADDING_CLASS } from "@/components/nav/tab-bar";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ChevronIcon } from "@/components/shopping-list/icons";

export type PendingItem = {
  id: string;
  name: string;
  quantity: number;
  unit: string | null;
};

type WhereToBuyProps = {
  listId: string;
  householdName: string;
  hasLocation: boolean;
  /** Itens não marcados da lista default. */
  items: PendingItem[];
  /** Resultado de `rpc best_prices` (uma linha por item × loja). */
  rows: BestPriceRow[];
  loadError: string | null;
};

type StoreSummary = {
  storeId: string;
  name: string;
  covered: number;
  sum: number;
  qualifies: boolean;
};

type UpdateResult = { itens: number; observacoes: number; falhas: string[] };

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

const SOURCE_LABEL: Record<PriceSource, string> = {
  nfce: "seu cupom",
  precodahora: "Preço da Hora",
  encarte: "encarte",
  manual: "manual",
};

function sourceLabel(source: string): string {
  return SOURCE_LABEL[source as PriceSource] ?? source;
}

// Relógio em minutos via useSyncExternalStore: no servidor é null (sem "há X" no HTML),
// no cliente atualiza a cada minuto sem chamar Date.now() durante o render.
const subscribeMinute = (onChange: () => void) => {
  const id = window.setInterval(onChange, 60_000);
  return () => window.clearInterval(id);
};
const getMinute = () => Math.floor(Date.now() / 60_000);
const getServerMinute = () => null;

function relativeTime(iso: string, now: number | null): string {
  if (now === null) return "";
  const diffMs = now - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return "agora";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} ${hours === 1 ? "hora" : "horas"}`;
  const days = Math.floor(hours / 24);
  return `há ${days} ${days === 1 ? "dia" : "dias"}`;
}

function formatQuantity(quantity: number, unit: string | null): string | null {
  if (quantity === 1 && !unit) return null;
  const q = Number.isInteger(quantity) ? String(quantity) : quantity.toLocaleString("pt-BR");
  return unit ? `${q} ${unit}` : `${q}×`;
}

/** Ordena lojas: com cobertura ≥ 50% primeiro (menor soma), depois por cobertura, depois soma. */
function summarizeStores(rows: BestPriceRow[], total: number): StoreSummary[] {
  const byStore = new Map<string, StoreSummary>();
  for (const r of rows) {
    const s = byStore.get(r.store_id) ?? {
      storeId: r.store_id,
      name: r.store_name,
      covered: 0,
      sum: 0,
      qualifies: false,
    };
    s.covered += 1;
    s.sum += Number(r.price);
    byStore.set(r.store_id, s);
  }
  const list = [...byStore.values()];
  for (const s of list) s.qualifies = total > 0 && s.covered * 2 >= total;
  list.sort((a, b) => {
    if (a.qualifies !== b.qualifies) return a.qualifies ? -1 : 1;
    if (a.qualifies) return a.sum - b.sum || b.covered - a.covered;
    return b.covered - a.covered || a.sum - b.sum;
  });
  return list;
}

export function WhereToBuy({ listId, householdName, hasLocation, items, rows, loadError }: WhereToBuyProps) {
  const router = useRouter();
  const minute = useSyncExternalStore(subscribeMinute, getMinute, getServerMinute);
  const now = minute === null ? null : minute * 60_000;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateResult, setUpdateResult] = useState<UpdateResult | null>(null);

  const total = items.length;

  const { stores, byItem, withPrice, withoutPrice } = useMemo(() => {
    const byItem = new Map<string, BestPriceRow[]>();
    for (const r of rows) {
      const arr = byItem.get(r.list_item_id) ?? [];
      arr.push(r);
      byItem.set(r.list_item_id, arr);
    }
    for (const arr of byItem.values()) {
      arr.sort((a, b) => Number(a.price) - Number(b.price) || b.observed_at.localeCompare(a.observed_at));
    }
    const withPrice = items.filter((i) => byItem.has(i.id));
    const withoutPrice = items.filter((i) => !byItem.has(i.id));
    return { stores: summarizeStores(rows, total), byItem, withPrice, withoutPrice };
  }, [rows, items, total]);

  const best = stores[0]?.qualifies ? stores[0] : null;

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleUpdate() {
    setUpdating(true);
    setUpdateError(null);
    setUpdateResult(null);
    try {
      const res = await fetch("/api/precos/atualizar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listId }),
      });
      let payload: { ok?: boolean; error?: string } & Partial<UpdateResult> = {};
      try {
        payload = await res.json();
      } catch {
        // Corpo vazio ou não-JSON: tratado abaixo pelo status.
      }
      if (!res.ok || payload.ok === false) {
        setUpdateError(payload.error || "Não foi possível atualizar os preços. Tente de novo em instantes.");
        return;
      }
      setUpdateResult({
        itens: payload.itens ?? 0,
        observacoes: payload.observacoes ?? 0,
        falhas: payload.falhas ?? [],
      });
      router.refresh();
    } catch {
      setUpdateError("Sem conexão com o servidor. Verifique sua internet e tente de novo.");
    } finally {
      setUpdating(false);
    }
  }

  return (
    <>
      <AppHeader title="Onde comprar" subtitle={householdName} />

      <main className={`mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-3 pt-3 ${TAB_BAR_PADDING_CLASS}`}>
        {!hasLocation ? (
          <Alert kind="info">
            A casa ainda não tem localização; a busca usa o centro de Salvador.{" "}
            <Link href="/casa" className="font-semibold underline underline-offset-2">
              Definir localização
            </Link>
          </Alert>
        ) : null}

        {loadError ? <Alert kind="error">{loadError}</Alert> : null}

        <Card className="flex flex-col gap-2">
          <Button full onClick={handleUpdate} disabled={updating || total === 0}>
            {updating ? "Atualizando preços..." : "Atualizar preços (Preço da Hora)"}
          </Button>
          {updating ? (
            <p role="status" className="text-center text-sm text-zinc-500 dark:text-zinc-400">
              Consultando o Preço da Hora para cada item. Isso pode levar até 1 minuto.
            </p>
          ) : null}
          {updateError ? <Alert kind="error">{updateError}</Alert> : null}
          {updateResult ? (
            <Alert kind={updateResult.falhas.length > 0 ? "info" : "success"}>
              {updateResult.itens} {updateResult.itens === 1 ? "item consultado" : "itens consultados"},{" "}
              {updateResult.observacoes} {updateResult.observacoes === 1 ? "preço novo" : "preços novos"}.
              {updateResult.falhas.length > 0 ? (
                <>
                  {" "}
                  Sem resultado para: {updateResult.falhas.join(", ")}.
                </>
              ) : null}
            </Alert>
          ) : null}
        </Card>

        {total === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
            <span className="text-5xl" aria-hidden>
              🧺
            </span>
            <p className="text-lg font-medium text-zinc-800 dark:text-zinc-200">Nada para comprar</p>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Adicione itens na{" "}
              <Link href="/lista" className="font-semibold text-emerald-700 underline underline-offset-2 dark:text-emerald-400">
                lista
              </Link>{" "}
              para comparar preços.
            </p>
          </div>
        ) : (
          <>
            <Card>
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Resumo por loja</p>
              {stores.length === 0 ? (
                <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
                  Ainda não há preços para os itens da lista. Toque em &quot;Atualizar preços&quot; ou importe um cupom.
                </p>
              ) : (
                <>
                  {!best ? (
                    <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
                      Nenhuma loja cobre metade da lista ainda. Lojas com mais itens aparecem primeiro.
                    </p>
                  ) : null}
                  <ul className="mt-2 flex flex-col gap-2">
                    {stores.map((s) => {
                      const isBest = best?.storeId === s.storeId;
                      return (
                        <li
                          key={s.storeId}
                          className={
                            "flex items-center gap-3 rounded-xl border px-3 py-2.5 " +
                            (isBest
                              ? "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950"
                              : "border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-800/60")
                          }
                        >
                          <span className="min-w-0 flex-1">
                            <span
                              className={
                                "block truncate text-base font-medium " +
                                (isBest ? "text-emerald-900 dark:text-emerald-100" : "text-zinc-900 dark:text-zinc-100")
                              }
                            >
                              {s.name}
                            </span>
                            <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                              {isBest ? "Melhor opção · " : null}
                              {s.covered}/{total} {s.covered === 1 ? "item" : "itens"}
                              {!s.qualifies ? " · cobre menos da metade" : null}
                            </span>
                          </span>
                          <span
                            className={
                              "shrink-0 text-base font-semibold tabular-nums " +
                              (isBest ? "text-emerald-800 dark:text-emerald-200" : "text-zinc-900 dark:text-zinc-100")
                            }
                          >
                            {brl.format(s.sum)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                    Soma dos preços unitários dos itens que cada loja cobre.
                  </p>
                </>
              )}
            </Card>

            {withPrice.length > 0 ? (
              <section aria-label="Por item">
                <h2 className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  Por item ({withPrice.length})
                </h2>
                <ul className="overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
                  {withPrice.map((item) => {
                    const offers = byItem.get(item.id) ?? [];
                    const top = offers[0];
                    const others = offers.slice(1);
                    const open = expanded.has(item.id);
                    const qty = formatQuantity(item.quantity, item.unit);
                    return (
                      <li key={item.id} className="border-b border-zinc-100 last:border-b-0 dark:border-zinc-800">
                        <button
                          type="button"
                          onClick={() => toggle(item.id)}
                          disabled={others.length === 0}
                          aria-expanded={others.length > 0 ? open : undefined}
                          className="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left active:bg-zinc-50 disabled:cursor-default dark:active:bg-zinc-800"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-base text-zinc-900 dark:text-zinc-100">
                              {item.name}
                              {qty ? <span className="ml-1.5 text-sm text-zinc-500 dark:text-zinc-400">{qty}</span> : null}
                            </span>
                            <span className="mt-0.5 block truncate text-xs text-zinc-500 dark:text-zinc-400">
                              {top.store_name} · {sourceLabel(top.source)}
                              {now !== null ? ` · ${relativeTime(top.observed_at, now)}` : null}
                            </span>
                          </span>
                          <span className="shrink-0 text-base font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                            {brl.format(Number(top.price))}
                          </span>
                          {others.length > 0 ? (
                            <ChevronIcon
                              className={`h-4 w-4 shrink-0 text-zinc-400 transition-transform ${open ? "rotate-180" : ""}`}
                            />
                          ) : (
                            <span className="w-4 shrink-0" aria-hidden />
                          )}
                        </button>
                        {open && others.length > 0 ? (
                          <ul className="bg-zinc-50 px-3 pb-2 dark:bg-zinc-800/60">
                            <li className="px-1 pt-1 text-[11px] uppercase tracking-wide text-zinc-400">Outras lojas</li>
                            {others.map((o) => (
                              <li key={o.store_id} className="flex min-h-10 items-center gap-3 px-1 text-sm">
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-zinc-800 dark:text-zinc-200">{o.store_name}</span>
                                  <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">
                                    {sourceLabel(o.source)}
                                    {now !== null ? ` · ${relativeTime(o.observed_at, now)}` : null}
                                  </span>
                                </span>
                                <span className="shrink-0 font-medium tabular-nums text-zinc-700 dark:text-zinc-300">
                                  {brl.format(Number(o.price))}
                                </span>
                              </li>
                            ))}
                            <li className="px-1 pt-1 text-xs text-zinc-500 dark:text-zinc-400">
                              Encontrado como: <span className="italic">{top.description}</span>
                            </li>
                          </ul>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}

            {withoutPrice.length > 0 ? (
              <section aria-label="Sem preço ainda">
                <h2 className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  Sem preço ainda ({withoutPrice.length})
                </h2>
                <ul className="overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
                  {withoutPrice.map((item) => {
                    const qty = formatQuantity(item.quantity, item.unit);
                    return (
                      <li
                        key={item.id}
                        className="flex min-h-12 items-center gap-3 border-b border-zinc-100 px-3 py-2 last:border-b-0 dark:border-zinc-800"
                      >
                        <span className="min-w-0 flex-1 truncate text-base text-zinc-700 dark:text-zinc-300">
                          {item.name}
                          {qty ? <span className="ml-1.5 text-sm text-zinc-500 dark:text-zinc-400">{qty}</span> : null}
                        </span>
                        <span className="shrink-0 text-xs text-zinc-400">sem preço</span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}
          </>
        )}
      </main>

      <TabBar />
    </>
  );
}
