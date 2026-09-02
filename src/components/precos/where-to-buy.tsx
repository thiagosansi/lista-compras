"use client";

import Link from "next/link";
import { useMemo, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { BestPriceRow, MatchKind, PriceSource } from "@/lib/database.types";
import { AppHeader } from "@/components/app-header";
import { TabBar, TAB_BAR_PADDING_CLASS } from "@/components/nav/tab-bar";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ChevronIcon } from "@/components/shopping-list/icons";
import { summarizeStores, type PendingItem, type StoreSummary } from "@/components/precos/summarize";

export type { PendingItem } from "@/components/precos/summarize";

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

type UpdateResult = {
  itens: number;
  observacoes: number;
  correspondencias: number;
  jaAtualizados: number;
  semJuiz: boolean;
  falhas: string[];
};

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

const BADGE_GREEN = "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200";
const BADGE_AMBER = "bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200";

const MATCH_BADGE: Record<MatchKind, { label: string; className: string }> = {
  user: { label: "confirmado por você", className: BADGE_GREEN },
  llm: { label: "verificado por IA", className: BADGE_GREEN },
  gtin: { label: "código de barras", className: BADGE_GREEN },
  product: { label: "código de barras", className: BADGE_GREEN },
  name: { label: "por nome (conferir)", className: BADGE_AMBER },
};

function MatchBadge({ kind }: { kind: MatchKind }) {
  const badge = MATCH_BADGE[kind] ?? MATCH_BADGE.name;
  return (
    <span
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-1.5 py-px text-[10px] font-medium leading-4 ${badge.className}`}
    >
      {badge.label}
    </span>
  );
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

function rowKey(itemId: string, storeId: string): string {
  return `${itemId}:${storeId}`;
}

function coverageLabel(s: { itensComPrecoReal: number; itensComparaveis: number; estimados: number }): string {
  const base = `${s.itensComPrecoReal} de ${s.itensComparaveis} ${s.itensComparaveis === 1 ? "item" : "itens"} com preço real`;
  if (s.estimados === 0) return base;
  return `${base}, ${s.estimados} estimado${s.estimados === 1 ? "" : "s"}`;
}

function StoreRow({ store, muted }: { store: StoreSummary; muted?: boolean }) {
  return (
    <li
      className={
        "flex items-center gap-3 rounded-xl border px-3 py-2.5 " +
        (muted
          ? "border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-800/60"
          : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900")
      }
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base font-medium text-zinc-900 dark:text-zinc-100">{store.name}</span>
        <span className="block text-xs text-zinc-500 dark:text-zinc-400">
          {coverageLabel(store)}
          {muted ? " · cobertura baixa" : null}
        </span>
      </span>
      <span className="shrink-0 text-base font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
        {brl.format(store.total)}
      </span>
    </li>
  );
}

const SMALL_BUTTON =
  "inline-flex min-h-9 items-center justify-center rounded-lg border px-2.5 text-xs font-medium transition-colors " +
  "disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 active:scale-[0.98] select-none";
const SMALL_BUTTON_NEUTRAL =
  "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800";
const SMALL_BUTTON_POSITIVE =
  "border-emerald-300 bg-white text-emerald-800 hover:bg-emerald-50 dark:border-emerald-800 dark:bg-zinc-900 dark:text-emerald-300 dark:hover:bg-emerald-950";

export function WhereToBuy({ listId, householdName, hasLocation, items, rows, loadError }: WhereToBuyProps) {
  const router = useRouter();
  const minute = useSyncExternalStore(subscribeMinute, getMinute, getServerMinute);
  const now = minute === null ? null : minute * 60_000;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateResult, setUpdateResult] = useState<UpdateResult | null>(null);
  const [matchBusy, setMatchBusy] = useState<string | null>(null);
  const [matchError, setMatchError] = useState<{ key: string; message: string } | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const [splitOpen, setSplitOpen] = useState(false);
  const [winnerOpen, setWinnerOpen] = useState(false);

  const total = items.length;

  const { summary, byItem, withPrice, withoutPrice } = useMemo(() => {
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
    return { summary: summarizeStores(rows, items), byItem, withPrice, withoutPrice };
  }, [rows, items]);

  const { eligible, lowCoverage, best, split } = summary;
  const matchLocked = matchBusy !== null || refreshing;

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
        correspondencias: payload.correspondencias ?? 0,
        jaAtualizados: typeof payload.jaAtualizados === "number" ? payload.jaAtualizados : 0,
        semJuiz: payload.semJuiz === true,
        falhas: payload.falhas ?? [],
      });
      router.refresh();
    } catch {
      setUpdateError("Sem conexão com o servidor. Verifique sua internet e tente de novo.");
    } finally {
      setUpdating(false);
    }
  }

  async function handleMatch(item: PendingItem, offer: BestPriceRow, isMatch: boolean) {
    const key = rowKey(item.id, offer.store_id);
    setMatchBusy(key);
    setMatchError(null);
    try {
      const res = await fetch("/api/precos/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemName: item.name,
          description: offer.description,
          gtin: offer.gtin,
          isMatch,
        }),
      });
      let payload: { ok?: boolean; error?: string } = {};
      try {
        payload = await res.json();
      } catch {
        // Corpo vazio ou não-JSON: tratado abaixo pelo status.
      }
      if (!res.ok || payload.ok === false) {
        setMatchError({ key, message: payload.error || "Não foi possível salvar a correção. Tente de novo." });
        return;
      }
      startRefresh(() => router.refresh());
    } catch {
      setMatchError({ key, message: "Sem conexão com o servidor. Verifique sua internet e tente de novo." });
    } finally {
      setMatchBusy(null);
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
              Consultando o Preço da Hora e verificando os produtos. Isso pode levar até 2 minutos.
            </p>
          ) : null}
          {updateError ? <Alert kind="error">{updateError}</Alert> : null}
          {updateResult ? (
            <Alert kind={updateResult.falhas.length > 0 ? "info" : "success"}>
              {updateResult.itens} {updateResult.itens === 1 ? "item consultado" : "itens consultados"},{" "}
              {updateResult.observacoes} {updateResult.observacoes === 1 ? "preço novo" : "preços novos"},{" "}
              {updateResult.correspondencias}{" "}
              {updateResult.correspondencias === 1 ? "correspondência verificada" : "correspondências verificadas"}.
              {updateResult.jaAtualizados > 0 ? (
                <>
                  {" "}
                  {updateResult.jaAtualizados}{" "}
                  {updateResult.jaAtualizados === 1 ? "item já estava atualizado" : "itens já estavam atualizados"} (últimas 24 h).
                </>
              ) : null}
              {updateResult.falhas.length > 0 ? (
                <>
                  {" "}
                  Avisos: {updateResult.falhas.join("; ")}.
                </>
              ) : null}
            </Alert>
          ) : null}
          {updateResult?.semJuiz ? (
            <Alert kind="info">
              A verificação por IA não estava disponível; os resultados foram cruzados só por nome.
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
              {summary.stores.length === 0 ? (
                <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
                  Ainda não há preços para os itens da lista. Toque em &quot;Atualizar preços&quot; ou importe um cupom.
                </p>
              ) : (
                <>
                  {!best ? (
                    <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
                      Nenhuma loja cobre metade da lista com preço real ainda. Veja a cobertura de cada uma abaixo.
                    </p>
                  ) : (
                    <div className="mt-2 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2.5 dark:border-emerald-800 dark:bg-emerald-950">
                      <button
                        type="button"
                        onClick={() => best.estimados > 0 && setWinnerOpen((v) => !v)}
                        aria-expanded={best.estimados > 0 ? winnerOpen : undefined}
                        className="flex w-full items-center gap-3 text-left"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-base font-medium text-emerald-900 dark:text-emerald-100">
                            {best.name}
                          </span>
                          <span className="block text-xs text-emerald-800/80 dark:text-emerald-200/80">
                            Melhor loja para a lista inteira · {coverageLabel(best)}
                          </span>
                        </span>
                        <span className="shrink-0 text-base font-semibold tabular-nums text-emerald-800 dark:text-emerald-200">
                          {brl.format(best.total)}
                        </span>
                        {best.estimados > 0 ? (
                          <ChevronIcon
                            className={`h-4 w-4 shrink-0 text-emerald-700 transition-transform dark:text-emerald-300 ${winnerOpen ? "rotate-180" : ""}`}
                          />
                        ) : null}
                      </button>
                      {winnerOpen && best.estimados > 0 ? (
                        <p className="mt-1.5 text-xs text-emerald-800/90 dark:text-emerald-200/90">
                          Estimados pela mediana: {best.estimadosNomes.join(", ")}.
                        </p>
                      ) : null}
                    </div>
                  )}

                  {eligible.length > 1 ? (
                    <ul className="mt-2 flex flex-col gap-2">
                      {eligible.slice(1).map((s) => (
                        <StoreRow key={s.storeId} store={s} />
                      ))}
                    </ul>
                  ) : null}

                  {lowCoverage.length > 0 ? (
                    <div className="mt-3">
                      <p className="px-0.5 text-[11px] uppercase tracking-wide text-zinc-400">Cobertura baixa</p>
                      <ul className="mt-1 flex flex-col gap-2">
                        {lowCoverage.map((s) => (
                          <StoreRow key={s.storeId} store={s} muted />
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {split ? (
                    <div className="mt-3 rounded-xl border border-sky-300 bg-sky-50 px-3 py-2.5 dark:border-sky-800 dark:bg-sky-950">
                      <button
                        type="button"
                        onClick={() => setSplitOpen((v) => !v)}
                        aria-expanded={splitOpen}
                        className="flex w-full items-center gap-3 text-left"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-base font-medium text-sky-900 dark:text-sky-100">
                            Dividir em 2 lojas
                          </span>
                          <span className="block text-xs text-sky-800/80 dark:text-sky-200/80">
                            {split.storeAName} + {split.storeBName} · economiza {brl.format(split.economia)} (
                            {Math.round(split.economiaPercent * 100)}%)
                          </span>
                        </span>
                        <span className="shrink-0 text-base font-semibold tabular-nums text-sky-800 dark:text-sky-200">
                          {brl.format(split.total)}
                        </span>
                        <ChevronIcon
                          className={`h-4 w-4 shrink-0 text-sky-700 transition-transform dark:text-sky-300 ${splitOpen ? "rotate-180" : ""}`}
                        />
                      </button>
                      {splitOpen ? (
                        <div className="mt-2 flex flex-col gap-1 text-xs text-sky-900 dark:text-sky-100">
                          <p>
                            <span className="font-semibold">{split.storeAName}:</span>{" "}
                            {split.itemsA.map((i) => i.name).join(", ") || "nenhum item"}
                          </p>
                          <p>
                            <span className="font-semibold">{split.storeBName}:</span>{" "}
                            {split.itemsB.map((i) => i.name).join(", ") || "nenhum item"}
                          </p>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                    Total = melhor preço real de cada item na loja × quantidade. &quot;Estimado&quot; é a mediana dos
                    melhores preços do item nas outras lojas, usada quando a loja não tem preço real dele. Só lojas com 50%
                    ou mais dos itens com preço real concorrem a melhor loja única.
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
                    const open = expanded.has(item.id);
                    const qty = formatQuantity(item.quantity, item.unit);
                    return (
                      <li key={item.id} className="border-b border-zinc-100 last:border-b-0 dark:border-zinc-800">
                        <button
                          type="button"
                          onClick={() => toggle(item.id)}
                          aria-expanded={open}
                          className="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left active:bg-zinc-50 dark:active:bg-zinc-800"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-base text-zinc-900 dark:text-zinc-100">
                              {item.name}
                              {qty ? <span className="ml-1.5 text-sm text-zinc-500 dark:text-zinc-400">{qty}</span> : null}
                            </span>
                            <span className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                              <span className="min-w-0 truncate">
                                {top.store_name} · {sourceLabel(top.source)}
                                {now !== null ? ` · ${relativeTime(top.observed_at, now)}` : null}
                              </span>
                              <MatchBadge kind={top.match_kind} />
                            </span>
                          </span>
                          <span className="shrink-0 text-base font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                            {brl.format(Number(top.price))}
                          </span>
                          <ChevronIcon
                            className={`h-4 w-4 shrink-0 text-zinc-400 transition-transform ${open ? "rotate-180" : ""}`}
                          />
                        </button>
                        {open ? (
                          <ul className="bg-zinc-50 px-3 pb-2 dark:bg-zinc-800/60">
                            <li className="px-1 pt-1 text-[11px] uppercase tracking-wide text-zinc-400">
                              {offers.length === 1 ? "Loja" : "Lojas"}
                            </li>
                            {offers.map((o) => {
                              const key = rowKey(item.id, o.store_id);
                              const busy = matchBusy === key;
                              const error = matchError?.key === key ? matchError.message : null;
                              return (
                                <li
                                  key={o.store_id}
                                  className="flex flex-col gap-1.5 border-b border-zinc-200/70 px-1 py-2 last:border-b-0 dark:border-zinc-700/60"
                                >
                                  <div className="flex items-center gap-3 text-sm">
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
                                  </div>
                                  <p className="text-xs text-zinc-600 dark:text-zinc-400">
                                    Encontrado como: <span className="italic">{o.description}</span>
                                  </p>
                                  <div className="flex flex-wrap items-center gap-2">
                                    <MatchBadge kind={o.match_kind} />
                                    {o.match_kind === "user" ? null : (
                                      <span className="ml-auto flex shrink-0 items-center gap-2">
                                        {o.match_kind === "name" ? (
                                          <button
                                            type="button"
                                            onClick={() => handleMatch(item, o, true)}
                                            disabled={matchLocked}
                                            className={`${SMALL_BUTTON} ${SMALL_BUTTON_POSITIVE}`}
                                          >
                                            {busy ? "Salvando..." : "É esse sim"}
                                          </button>
                                        ) : null}
                                        <button
                                          type="button"
                                          onClick={() => handleMatch(item, o, false)}
                                          disabled={matchLocked}
                                          className={`${SMALL_BUTTON} ${SMALL_BUTTON_NEUTRAL}`}
                                        >
                                          {busy ? "Salvando..." : "Não é esse produto"}
                                        </button>
                                      </span>
                                    )}
                                  </div>
                                  {error ? (
                                    <p role="alert" className="text-xs text-red-700 dark:text-red-400">
                                      {error}
                                    </p>
                                  ) : null}
                                </li>
                              );
                            })}
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
