"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Database, ListItem, ShoppingSession, ShoppingSessionItem } from "@/lib/database.types";
import { CATEGORIES, DEFAULT_CATEGORY, isCategory, type Category } from "@/lib/categories";
import { normalizeName } from "@/lib/normalize";
import { useListItems, upsertItem, TEMP_ID_PREFIX } from "@/lib/hooks/use-list-items";
import { useShoppingSession, upsertSessionItem } from "@/lib/hooks/use-shopping-session";
import { AppHeader } from "@/components/app-header";
import { TabBar, TAB_BAR_PADDING_CLASS } from "@/components/nav/tab-bar";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StartSession } from "./start-session";
import { StorePicker, type RecentStore, type StoreChoice } from "./store-picker";
import { BottomSheet } from "./bottom-sheet";
import { PickSheet, CartItemSheet, type PickResult } from "./pick-sheet";
import { CategorySheet } from "./category-sheet";
import { formatDate, formatMoney, formatQuantity } from "./format";

type SupabaseClient = ReturnType<typeof createClient>;

/**
 * Resolve o `store_id` de uma escolha de loja: usa o id já conhecido (recente, busca
 * ou "mais próxima") ou, para texto livre, reaproveita uma loja com o mesmo nome
 * (ilike exato) ou cria uma nova sem CNPJ — assim preços confirmados viram observações
 * desta loja mesmo sem cadastro completo.
 */
async function resolveStoreId(supabase: SupabaseClient, choice: StoreChoice): Promise<string | null> {
  if (choice.storeId) return choice.storeId;
  const { data: existing } = await supabase.from("stores").select("id").ilike("name", choice.storeName).limit(1).maybeSingle();
  if (existing) return existing.id;
  const { data: created } = await supabase.from("stores").insert({ name: choice.storeName }).select("id").single();
  return created?.id ?? null;
}

export type SessionHistoryEntry = {
  id: string;
  storeName: string;
  finishedAt: string;
  total: number;
};

type ComprasViewProps = {
  householdId: string;
  householdName: string;
  listId: string;
  currentUserId: string;
  initialSession: ShoppingSession | null;
  initialSessionItems: ShoppingSessionItem[];
  initialPendingItems: ListItem[];
  recentStores: RecentStore[];
  initialHistory: SessionHistoryEntry[];
};

type Sheet =
  | { kind: "pick"; item: ListItem }
  | { kind: "cart"; item: ShoppingSessionItem }
  | { kind: "store" }
  | { kind: "category"; item: ListItem }
  | null;

type CategorizeResponse = { ok: true; categorias: Record<string, string> } | { ok: false; error: string };

type ListItemPatch = Database["public"]["Tables"]["list_items"]["Update"];

export function ComprasView({
  householdId,
  householdName,
  listId,
  currentUserId,
  initialSession,
  initialSessionItems,
  initialPendingItems,
  recentStores,
  initialHistory,
}: ComprasViewProps) {
  const supabase = createClient();
  const { session, setSession, items: cartItems, setItems: setCartItems, total } = useShoppingSession(initialSession, initialSessionItems);
  const { items: listItems, setItems: setListItems } = useListItems(listId, initialPendingItems);
  const [history, setHistory] = useState(initialHistory);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [confirmFinish, setConfirmFinish] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [storeChoice, setStoreChoice] = useState<StoreChoice | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [canceling, setCanceling] = useState(false);

  const isOpen = session != null && session.finished_at == null;
  const isFinished = session != null && session.finished_at != null;

  const fail = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 4000);
  }, []);

  // Itens sem categoria: classifica uma vez ao abrir a sessão e aplica no estado local.
  const categorizedRef = useRef(false);
  useEffect(() => {
    if (!isOpen || categorizedRef.current) return;
    const nomes = [...new Set(listItems.filter((i) => !i.checked && !i.category).map((i) => i.name))].slice(0, 50);
    if (nomes.length === 0) return;
    categorizedRef.current = true;
    fetch("/api/itens/categorizar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nomes }),
    })
      .then(async (res) => {
        const data = (await res.json()) as CategorizeResponse;
        if (!data.ok) return;
        setListItems((prev) =>
          prev.map((i) => {
            if (i.category) return i;
            const cat = data.categorias[i.name];
            return isCategory(cat) ? { ...i, category: cat } : i;
          }),
        );
      })
      .catch(() => {
        // Sem categoria: os itens ficam em "Outros".
      });
  }, [isOpen, listItems, setListItems]);

  const groups = useMemo(() => {
    const byCategory = new Map<Category, ListItem[]>();
    for (const item of listItems) {
      if (item.checked) continue;
      const cat: Category = isCategory(item.category) ? item.category : DEFAULT_CATEGORY;
      const arr = byCategory.get(cat);
      if (arr) arr.push(item);
      else byCategory.set(cat, [item]);
    }
    return CATEGORIES.filter((c) => byCategory.has(c)).map((c) => ({
      category: c,
      items: byCategory.get(c)!.sort((a, b) => a.created_at.localeCompare(b.created_at)),
    }));
  }, [listItems]);
  const pendingCount = groups.reduce((n, g) => n + g.items.length, 0);

  const loadOpenSession = useCallback(async () => {
    const { data: open } = await supabase
      .from("shopping_sessions")
      .select("*")
      .eq("household_id", householdId)
      .is("finished_at", null)
      .maybeSingle();
    if (!open) return false;
    const { data: rows } = await supabase
      .from("shopping_session_items")
      .select("*")
      .eq("session_id", open.id)
      .order("created_at", { ascending: true });
    setSession(open);
    setCartItems((rows ?? []).reduce(upsertSessionItem, []));
    return true;
  }, [supabase, householdId, setSession, setCartItems]);

  const handleStart = useCallback(
    async (choice: StoreChoice) => {
      setStarting(true);
      setStartError(null);
      const storeId = await resolveStoreId(supabase, choice);
      const { data, error } = await supabase
        .from("shopping_sessions")
        .insert({ household_id: householdId, list_id: listId, store_id: storeId, store_name: choice.storeName })
        .select()
        .single();
      if (error || !data) {
        if (error?.code === "23505" && (await loadOpenSession())) {
          setStarting(false);
          return;
        }
        setStartError("Não foi possível começar a compra. Tente de novo.");
        setStarting(false);
        return;
      }
      setSession({ ...data, total: Number(data.total) });
      setCartItems([]);
      setConfirmFinish(false);
      setStarting(false);
    },
    [supabase, householdId, listId, loadOpenSession, setSession, setCartItems],
  );

  const handlePick = useCallback(
    async (item: ListItem, r: PickResult) => {
      if (!session) return;
      const now = new Date().toISOString();
      let productId = item.product_id;
      if (r.gtin) {
        const { data: p } = await supabase.from("products").select("id").eq("gtin", r.gtin).limit(1).maybeSingle();
        if (p) productId = p.id;
      }

      const tempId = `${TEMP_ID_PREFIX}${crypto.randomUUID()}`;
      const optimistic: ShoppingSessionItem = {
        id: tempId,
        session_id: session.id,
        list_item_id: item.id,
        product_id: productId,
        gtin: r.gtin,
        description: r.description,
        quantity: r.quantity,
        unit_price: r.unitPrice,
        total: r.quantity * r.unitPrice,
        scanned: r.scanned,
        created_at: now,
      };
      setCartItems((prev) => [...prev, optimistic]);
      setListItems((prev) => upsertItem(prev, { ...item, checked: true, checked_at: now, checked_by: currentUserId }));

      const { data, error } = await supabase
        .from("shopping_session_items")
        .insert({
          session_id: session.id,
          list_item_id: item.id,
          product_id: productId,
          gtin: r.gtin,
          description: r.description,
          quantity: r.quantity,
          unit_price: r.unitPrice,
          scanned: r.scanned,
        })
        .select()
        .single();
      if (error || !data) {
        setCartItems((prev) => prev.filter((i) => i.id !== tempId));
        setListItems((prev) => upsertItem(prev, item));
        throw new Error(error?.message ?? "insert failed");
      }
      setCartItems((prev) => upsertSessionItem(prev.filter((i) => i.id !== tempId), data));
      setSheet(null);

      const patch: ListItemPatch = { checked: true, checked_at: now, checked_by: currentUserId };
      if (!item.gtin && r.gtin) patch.gtin = r.gtin;
      if (!item.product_id && productId) patch.product_id = productId;
      if (r.useProductName && r.description.trim()) patch.name = r.description.trim();
      if (!item.category && isCategory(r.categoria)) patch.category = r.categoria;
      const { error: updErr } = await supabase.from("list_items").update(patch).eq("id", item.id);
      if (updErr) fail("Item no carrinho, mas a lista não foi atualizada.");
      else setListItems((prev) => upsertItem(prev, { ...item, ...patch, name: patch.name ?? item.name } as ListItem));

      if (session.store_id) {
        const { error: obsErr } = await supabase.from("price_observations").insert({
          household_id: householdId,
          store_id: session.store_id,
          product_id: productId,
          gtin: r.gtin,
          description: r.description,
          price: r.unitPrice,
          observed_at: now,
          source: "manual",
        });
        if (obsErr) fail("Preço registrado só nesta compra (histórico de preços não atualizado).");
      }
    },
    [session, supabase, householdId, currentUserId, setCartItems, setListItems, fail],
  );

  const handleCartSave = useCallback(
    async (item: ShoppingSessionItem, unitPrice: number, quantity: number) => {
      setCartItems((prev) => upsertSessionItem(prev, { ...item, unit_price: unitPrice, quantity, total: unitPrice * quantity }));
      const { error } = await supabase.from("shopping_session_items").update({ unit_price: unitPrice, quantity }).eq("id", item.id);
      if (error) {
        setCartItems((prev) => upsertSessionItem(prev, item));
        throw new Error(error.message);
      }
      setSheet(null);
    },
    [supabase, setCartItems],
  );

  const handleCartRemove = useCallback(
    async (item: ShoppingSessionItem) => {
      setCartItems((prev) => prev.filter((i) => i.id !== item.id));
      const { error } = await supabase.from("shopping_session_items").delete().eq("id", item.id);
      if (error) {
        setCartItems((prev) => upsertSessionItem(prev, item));
        throw new Error(error.message);
      }
      setSheet(null);
      if (item.list_item_id) {
        const patch = { checked: false, checked_at: null, checked_by: null };
        const { error: updErr } = await supabase.from("list_items").update(patch).eq("id", item.list_item_id);
        if (updErr) fail("Removido do carrinho, mas o item continua marcado na lista.");
        else
          setListItems((prev) => {
            const li = prev.find((i) => i.id === item.list_item_id);
            return li ? upsertItem(prev, { ...li, ...patch }) : prev;
          });
      }
    },
    [supabase, setCartItems, setListItems, fail],
  );

  const handleCategoryChange = useCallback(
    async (item: ListItem, category: Category) => {
      setListItems((prev) => upsertItem(prev, { ...item, category }));
      setSheet(null);
      const { error: updErr } = await supabase.from("list_items").update({ category }).eq("id", item.id);
      if (updErr) {
        setListItems((prev) => upsertItem(prev, item));
        fail("Não foi possível mover o item. Tente de novo.");
        return;
      }
      // Cache por nome: vale para outros itens (e futuras listas) com o mesmo nome normalizado.
      // Erro aqui não desfaz o item já movido — só falha em lembrar a seção da próxima vez.
      const itemKey = normalizeName(item.name);
      if (itemKey) {
        const { error: cacheErr } = await supabase
          .from("item_categories")
          .upsert({ item_key: itemKey, category, source: "user" }, { onConflict: "item_key" });
        if (cacheErr) fail("Seção salva neste item, mas não foi possível lembrar para a próxima vez.");
      }
    },
    [supabase, setListItems, fail],
  );

  const handleFinish = useCallback(async () => {
    if (!session) return;
    setFinishing(true);
    const finishedAt = new Date().toISOString();
    const { data, error } = await supabase
      .from("shopping_sessions")
      .update({ finished_at: finishedAt })
      .eq("id", session.id)
      .select()
      .single();
    setFinishing(false);
    setConfirmFinish(false);
    if (error) {
      fail("Não foi possível finalizar. Tente de novo.");
      return;
    }
    setSession(data ? { ...data, total: Number(data.total) } : { ...session, finished_at: finishedAt, total });
  }, [session, supabase, total, setSession, fail]);

  const handleSwitchStore = useCallback(
    async (choice: StoreChoice) => {
      if (!session) return;
      setSwitching(true);
      setSwitchError(null);
      const storeId = await resolveStoreId(supabase, choice);
      const { data, error } = await supabase
        .from("shopping_sessions")
        .update({ store_id: storeId, store_name: choice.storeName })
        .eq("id", session.id)
        .select()
        .single();
      setSwitching(false);
      if (error || !data) {
        setSwitchError("Não foi possível trocar de loja. Tente de novo.");
        return;
      }
      // Itens já no carrinho mantêm o preço registrado: não mexe em shopping_session_items.
      setSession({ ...data, total: Number(data.total) });
      setSheet(null);
      setStoreChoice(null);
    },
    [session, supabase, setSession],
  );

  const handleCancel = useCallback(async () => {
    if (!session) return;
    setCanceling(true);
    // Desmarca só os list_items que estão no carrinho desta sessão; itens marcados
    // fora dela (por outro fluxo) não são tocados.
    const listItemIds = [...new Set(cartItems.flatMap((i) => (i.list_item_id ? [i.list_item_id] : [])))];
    if (listItemIds.length > 0) {
      const { error: updErr } = await supabase
        .from("list_items")
        .update({ checked: false, checked_at: null, checked_by: null })
        .in("id", listItemIds);
      if (updErr) {
        setCanceling(false);
        fail("Não foi possível cancelar. Tente de novo.");
        return;
      }
    }
    const { error: delErr } = await supabase.from("shopping_sessions").delete().eq("id", session.id);
    setCanceling(false);
    if (delErr) {
      fail("Não foi possível cancelar. Tente de novo.");
      return;
    }
    if (listItemIds.length > 0) {
      setListItems((prev) => prev.map((li) => (listItemIds.includes(li.id) ? { ...li, checked: false, checked_at: null, checked_by: null } : li)));
    }
    setSession(null);
    setCartItems([]);
    setConfirmCancel(false);
    setSheet(null);
  }, [session, cartItems, supabase, setListItems, setSession, setCartItems, fail]);

  const handleNewShopping = useCallback(() => {
    if (session?.finished_at) {
      const entry: SessionHistoryEntry = {
        id: session.id,
        storeName: session.store_name ?? "Loja",
        finishedAt: session.finished_at,
        total: cartItems.length ? total : Number(session.total),
      };
      setHistory((prev) => [entry, ...prev.filter((h) => h.id !== entry.id)].slice(0, 5));
    }
    setSession(null);
    setCartItems([]);
    setSheet(null);
  }, [session, cartItems.length, total, setSession, setCartItems]);

  const closeSheet = useCallback(() => setSheet(null), []);

  const storeLabel = session?.store_name ?? "Compra";
  const isTemp = (id: string) => id.startsWith(TEMP_ID_PREFIX);

  return (
    <>
      <AppHeader
        title={isOpen || isFinished ? storeLabel : "Compras"}
        subtitle={
          isOpen
            ? `${householdName} · começou ${formatDate(session.started_at, true)}`
            : isFinished
              ? `Compra finalizada ${formatDate(session.finished_at, true)}`
              : householdName
        }
      />

      <main className={`mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-3 pt-3 ${TAB_BAR_PADDING_CLASS}`}>
        {toast ? <Alert kind="error">{toast}</Alert> : null}

        {isFinished ? (
          <Card className="flex flex-col gap-4">
            <div className="flex flex-col items-center gap-1 py-2 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" aria-hidden>
                <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12l5 5L20 7" />
                </svg>
              </span>
              <p className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Compra finalizada</p>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                {storeLabel} · {cartItems.length} {cartItems.length === 1 ? "item" : "itens"}
              </p>
              <p className="mt-2 text-4xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">{formatMoney(total)}</p>
            </div>
            {cartItems.length > 0 ? (
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {cartItems.map((i) => (
                  <li key={i.id} className="flex items-start justify-between gap-3 py-2">
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-zinc-900 dark:text-zinc-100">{i.description}</span>
                      <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                        {formatQuantity(i.quantity)} × {formatMoney(i.unit_price)}
                      </span>
                    </span>
                    <span className="shrink-0 text-sm font-medium text-zinc-900 dark:text-zinc-100">{formatMoney(i.quantity * i.unit_price)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <Link
              href="/cupom"
              className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 text-base font-medium text-white hover:bg-emerald-700"
            >
              Escanear cupom
            </Link>
            <Button variant="secondary" full onClick={handleNewShopping}>
              Nova compra
            </Button>
          </Card>
        ) : null}

        {!session ? (
          <StartSession recentStores={recentStores} starting={starting} error={startError} onStart={(c) => void handleStart(c)} />
        ) : null}

        {isOpen ? (
          <>
            <Card className="flex items-end justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Total no carrinho</p>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  {cartItems.length} {cartItems.length === 1 ? "item" : "itens"} · {pendingCount} {pendingCount === 1 ? "pendente" : "pendentes"}
                </p>
              </div>
              <p className="shrink-0 text-4xl font-bold tracking-tight text-emerald-700 dark:text-emerald-400" aria-live="polite">
                {formatMoney(total)}
              </p>
            </Card>

            <Card className="flex flex-col gap-2">
              {confirmCancel ? (
                <>
                  <p className="text-sm text-zinc-700 dark:text-zinc-300">
                    Cancelar a compra em {storeLabel}?{" "}
                    {cartItems.length > 0
                      ? `${cartItems.length} ${cartItems.length === 1 ? "item volta" : "itens voltam"} para a lista.`
                      : "O carrinho está vazio."}
                  </p>
                  <div className="flex gap-2">
                    <Button variant="danger" full disabled={canceling} onClick={() => void handleCancel()}>
                      {canceling ? "Cancelando..." : "Sim, cancelar"}
                    </Button>
                    <Button variant="secondary" full disabled={canceling} onClick={() => setConfirmCancel(false)}>
                      Voltar
                    </Button>
                  </div>
                </>
              ) : (
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    full
                    onClick={() => {
                      setSwitchError(null);
                      setStoreChoice(null);
                      setSheet({ kind: "store" });
                    }}
                  >
                    Trocar loja
                  </Button>
                  <Button variant="danger" full onClick={() => setConfirmCancel(true)}>
                    Cancelar compra
                  </Button>
                </div>
              )}
            </Card>

            {pendingCount === 0 ? (
              <p className="px-1 py-4 text-center text-sm text-zinc-500 dark:text-zinc-400">
                {listItems.length === 0 ? "A lista está vazia. Adicione itens na aba Lista." : "Tudo no carrinho! 🎉"}
              </p>
            ) : (
              groups.map((g) => (
                <section key={g.category} aria-label={g.category}>
                  <h2 className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    {g.category} ({g.items.length})
                  </h2>
                  <ul className="overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
                    {g.items.map((item) => (
                      <li key={item.id} className="flex items-stretch border-b border-zinc-100 last:border-b-0 dark:border-zinc-800">
                        <button
                          type="button"
                          onClick={() => setSheet({ kind: "pick", item })}
                          disabled={isTemp(item.id)}
                          className="flex min-h-14 min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left active:bg-zinc-50 disabled:opacity-60 dark:active:bg-zinc-800"
                        >
                          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 border-zinc-300 dark:border-zinc-600" aria-hidden />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-base text-zinc-900 dark:text-zinc-100">
                              {item.name}
                              {item.quantity !== 1 || item.unit ? (
                                <span className="ml-1.5 text-sm text-zinc-500 dark:text-zinc-400">
                                  {formatQuantity(item.quantity)}
                                  {item.unit ? ` ${item.unit}` : "×"}
                                </span>
                              ) : null}
                            </span>
                            {item.note ? <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">{item.note}</span> : null}
                          </span>
                          {item.gtin ? (
                            <span className="shrink-0 rounded-full bg-zinc-100 px-1.5 py-px text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                              código
                            </span>
                          ) : null}
                        </button>
                        <button
                          type="button"
                          onClick={() => setSheet({ kind: "category", item })}
                          disabled={isTemp(item.id)}
                          aria-label={`Mover "${item.name}" para outra seção`}
                          className="flex w-11 shrink-0 items-center justify-center text-zinc-400 active:bg-zinc-50 disabled:opacity-60 dark:text-zinc-500 dark:active:bg-zinc-800"
                        >
                          <TagIcon />
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))
            )}

            <section aria-label="No carrinho">
              <h2 className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                No carrinho ({cartItems.length})
              </h2>
              {cartItems.length === 0 ? (
                <p className="rounded-xl bg-zinc-50 px-3 py-3 text-sm text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                  Toque num item da lista ao pegá-lo na prateleira.
                </p>
              ) : (
                <ul className="overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
                  {cartItems.map((i) => (
                    <li key={i.id} className="border-b border-zinc-100 last:border-b-0 dark:border-zinc-800">
                      <button
                        type="button"
                        onClick={() => setSheet({ kind: "cart", item: i })}
                        disabled={isTemp(i.id)}
                        className="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left active:bg-zinc-50 disabled:opacity-60 dark:active:bg-zinc-800"
                      >
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 border-emerald-600 bg-emerald-600 text-white" aria-hidden>
                          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M5 12l5 5L20 7" />
                          </svg>
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-base text-zinc-900 dark:text-zinc-100">{i.description}</span>
                          <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                            {formatQuantity(i.quantity)} × {formatMoney(i.unit_price)}
                            {i.scanned ? " · escaneado" : ""}
                          </span>
                        </span>
                        <span className="shrink-0 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{formatMoney(i.quantity * i.unit_price)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <Card className="flex flex-col gap-2">
              {confirmFinish ? (
                <>
                  <p className="text-sm text-zinc-700 dark:text-zinc-300">
                    Finalizar com {cartItems.length} {cartItems.length === 1 ? "item" : "itens"} por <strong>{formatMoney(total)}</strong>?
                    {pendingCount > 0 ? ` ${pendingCount} ${pendingCount === 1 ? "item fica" : "itens ficam"} pendente${pendingCount === 1 ? "" : "s"} na lista.` : ""}
                  </p>
                  <div className="flex gap-2">
                    <Button full disabled={finishing} onClick={() => void handleFinish()}>
                      {finishing ? "Finalizando..." : "Sim, finalizar"}
                    </Button>
                    <Button variant="secondary" full disabled={finishing} onClick={() => setConfirmFinish(false)}>
                      Cancelar
                    </Button>
                  </div>
                </>
              ) : (
                <Button full variant={cartItems.length ? "primary" : "secondary"} onClick={() => setConfirmFinish(true)}>
                  Finalizar compra
                </Button>
              )}
            </Card>
          </>
        ) : null}

        {!isOpen ? (
          <Card>
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Últimas compras</p>
            {history.length === 0 ? (
              <p className="mt-2 rounded-xl bg-zinc-50 px-3 py-2 text-sm text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                Nenhuma compra finalizada ainda.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-zinc-100 dark:divide-zinc-800">
                {history.map((h) => (
                  <li key={h.id} className="flex min-h-12 items-center justify-between gap-3 py-2">
                    <span className="min-w-0">
                      <span className="block truncate text-base text-zinc-900 dark:text-zinc-100">{h.storeName}</span>
                      <span className="block text-xs text-zinc-500 dark:text-zinc-400">{formatDate(h.finishedAt, true)}</span>
                    </span>
                    <span className="shrink-0 text-sm font-medium text-zinc-900 dark:text-zinc-100">{formatMoney(h.total)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ) : null}
      </main>

      {sheet?.kind === "pick" && session ? (
        <PickSheet item={sheet.item} storeId={session.store_id} onClose={closeSheet} onConfirm={(r) => handlePick(sheet.item, r)} />
      ) : null}
      {sheet?.kind === "cart" ? (
        <CartItemSheet
          item={sheet.item}
          onClose={closeSheet}
          onSave={(p, q) => handleCartSave(sheet.item, p, q)}
          onRemove={() => handleCartRemove(sheet.item)}
        />
      ) : null}
      {sheet?.kind === "store" ? (
        <BottomSheet title="Trocar loja" onClose={closeSheet}>
          <div className="flex flex-col gap-4">
            <StorePicker recentStores={recentStores} disabled={switching} onChange={setStoreChoice} />
            {switchError ? <Alert kind="error">{switchError}</Alert> : null}
            <Button full disabled={!storeChoice || switching} onClick={() => storeChoice && void handleSwitchStore(storeChoice)}>
              {switching ? "Trocando..." : storeChoice ? `Trocar para ${storeChoice.storeName}` : "Escolha a loja"}
            </Button>
          </div>
        </BottomSheet>
      ) : null}
      {sheet?.kind === "category" ? (
        <CategorySheet item={sheet.item} onClose={closeSheet} onChoose={(cat) => void handleCategoryChange(sheet.item, cat)} />
      ) : null}

      <TabBar />
    </>
  );
}

function TagIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20.59 13.41 11 3.83A2 2 0 0 0 9.59 3.24L4 3a1 1 0 0 0-1 1l.24 5.59a2 2 0 0 0 .59 1.41l9.58 9.58a2 2 0 0 0 2.83 0l4.35-4.35a2 2 0 0 0 0-2.82Z" />
      <circle cx="7.5" cy="7.5" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}
