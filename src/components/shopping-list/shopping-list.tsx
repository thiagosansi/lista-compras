"use client";

import { normalizeName } from "@/lib/normalize";
import { isCategory } from "@/lib/categories";
import { formatProductName } from "@/lib/products/format";

import { useCallback, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { ListItem, ProductSuggestion } from "@/lib/database.types";
import { useListItems, upsertItem, TEMP_ID_PREFIX } from "@/lib/hooks/use-list-items";
import { AppHeader } from "@/components/app-header";
import { TabBar } from "@/components/nav/tab-bar";
import { AddItemBar } from "./add-item-bar";
import { ItemRow } from "./item-row";
import { ChevronIcon } from "./icons";

type NewItemFields = Pick<ListItem, "name" | "quantity" | "gtin" | "product_id" | "category">;

type ShoppingListProps = {
  listId: string;
  listName: string;
  householdName: string;
  currentUserId: string;
  /** display_name por user_id dos membros da casa. */
  memberNames: Record<string, string>;
  initialItems: ListItem[];
};

export function ShoppingList({ listId, listName, householdName, currentUserId, memberNames, initialItems }: ShoppingListProps) {
  const supabase = createClient();
  const { items, setItems } = useListItems(listId, initialItems);
  const [showChecked, setShowChecked] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const { pending, done } = useMemo(() => {
    const pending = items.filter((i) => !i.checked).sort((a, b) => b.created_at.localeCompare(a.created_at));
    const done = items
      .filter((i) => i.checked)
      .sort((a, b) => (b.checked_at ?? b.updated_at).localeCompare(a.checked_at ?? a.updated_at));
    return { pending, done };
  }, [items]);

  const fail = useCallback((message: string) => {
    setError(message);
    window.setTimeout(() => setError(null), 4000);
  }, []);

  /** Aplica uma categoria ao item em estado local (se ainda existir) e no banco. Nunca lança. */
  const applyCategory = useCallback(
    async (itemId: string, category: string) => {
      setItems((prev) => {
        const current = prev.find((i) => i.id === itemId);
        return current && current.category !== category ? upsertItem(prev, { ...current, category }) : prev;
      });
      try {
        await supabase.from("list_items").update({ category }).eq("id", itemId);
      } catch {
        // Silencioso: a categoria é auxiliar; a rota já tenta gravar no banco também.
      }
    },
    [supabase, setItems],
  );

  /** Pede a categoria ao servidor em background (texto livre). Nunca bloqueia nem lança. */
  const categorizeInBackground = useCallback(
    (itemId: string, name: string) => {
      void (async () => {
        try {
          const res = await fetch("/api/itens/categorizar", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ nomes: [name] }),
          });
          if (!res.ok) return;
          const json = (await res.json()) as { ok?: boolean; categorias?: Record<string, string> };
          const category = json.ok ? json.categorias?.[name] : undefined;
          if (isCategory(category)) await applyCategory(itemId, category);
        } catch {
          // Sem categoria: o item fica em "Outros" no modo Compras.
        }
      })();
    },
    [applyCategory],
  );

  /**
   * Inserção otimista compartilhada por texto livre e sugestão. O item aparece na hora; `beforeInsert` (opcional)
   * resolve campos extras (ex.: product_id) antes de gravar. Devolve a linha criada ou null.
   */
  const insertItem = useCallback(
    async (fields: NewItemFields, beforeInsert?: () => Promise<Partial<NewItemFields>>): Promise<ListItem | null> => {
      const now = new Date().toISOString();
      const tempId = `${TEMP_ID_PREFIX}${crypto.randomUUID()}`;
      const optimistic: ListItem = {
        id: tempId,
        list_id: listId,
        unit: null,
        note: null,
        checked: false,
        checked_at: null,
        checked_by: null,
        added_by: currentUserId,
        created_at: now,
        updated_at: now,
        normalized_name: normalizeName(fields.name),
        ...fields,
      };
      setItems((prev) => [...prev, optimistic]);

      let extra: Partial<NewItemFields> = {};
      if (beforeInsert) {
        try {
          extra = await beforeInsert();
        } catch {
          extra = {};
        }
      }

      const { data, error } = await supabase
        .from("list_items")
        .insert({ list_id: listId, ...fields, ...extra })
        .select()
        .single();

      if (error || !data) {
        setItems((prev) => prev.filter((i) => i.id !== tempId));
        fail("Não foi possível adicionar. Tente de novo.");
        return null;
      }
      // Troca o temporário pelo real (o evento realtime pode já ter chegado; upsert evita duplicar).
      setItems((prev) => upsertItem(prev.filter((i) => i.id !== tempId), data));
      return data;
    },
    [listId, currentUserId, supabase, setItems, fail],
  );

  const handleAdd = useCallback(
    async (name: string, quantity: number) => {
      const data = await insertItem({ name, quantity, gtin: null, product_id: null, category: null });
      if (data) categorizeInBackground(data.id, name);
    },
    [insertItem, categorizeInBackground],
  );

  /** Garante o produto em `products` (por gtin) e devolve `{ id, category }`; null se não deu (RLS, rede). */
  const ensureProduct = useCallback(
    async (s: ProductSuggestion): Promise<{ id: string; category: string | null } | null> => {
      try {
        const found = await supabase.from("products").select("id, category").eq("gtin", s.gtin).maybeSingle();
        if (found.data) return found.data;
        const inserted = await supabase
          .from("products")
          .insert({ gtin: s.gtin, name: s.descricao, category: s.categoria })
          .select("id, category")
          .single();
        if (inserted.data) return inserted.data;
        // Corrida (outro celular criou antes) ou RLS: tenta ler de novo.
        const again = await supabase.from("products").select("id, category").eq("gtin", s.gtin).maybeSingle();
        return again.data ?? null;
      } catch {
        return null;
      }
    },
    [supabase],
  );

  const handlePick = useCallback(
    async (s: ProductSuggestion, quantity: number) => {
      const name = formatProductName(s.descricao) || s.descricao;
      const data = await insertItem(
        { name, quantity, gtin: s.gtin, product_id: null, category: s.categoria },
        async () => {
          const product = await ensureProduct(s);
          return { product_id: product?.id ?? null, category: s.categoria ?? product?.category ?? null };
        },
      );
      if (data && !data.category) categorizeInBackground(data.id, name);
    },
    [ensureProduct, insertItem, categorizeInBackground],
  );

  const handleToggle = useCallback(
    async (item: ListItem) => {
      const checked = !item.checked;
      const patch = {
        checked,
        checked_at: checked ? new Date().toISOString() : null,
        checked_by: checked ? currentUserId : null,
      };
      setItems((prev) => upsertItem(prev, { ...item, ...patch }));

      const { error } = await supabase.from("list_items").update(patch).eq("id", item.id);
      if (error) {
        setItems((prev) => upsertItem(prev, item));
        fail("Não foi possível atualizar. Tente de novo.");
      }
    },
    [currentUserId, supabase, setItems, fail],
  );

  const handleDelete = useCallback(
    async (item: ListItem) => {
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      const { error } = await supabase.from("list_items").delete().eq("id", item.id);
      if (error) {
        setItems((prev) => upsertItem(prev, item));
        fail("Não foi possível excluir. Tente de novo.");
      }
    },
    [supabase, setItems, fail],
  );

  const handleClearChecked = useCallback(async () => {
    if (done.length === 0) return;
    setClearing(true);
    const removed = done;
    setItems((prev) => prev.filter((i) => !i.checked));
    const { error } = await supabase.from("list_items").delete().eq("list_id", listId).eq("checked", true);
    setClearing(false);
    if (error) {
      setItems((prev) => removed.reduce(upsertItem, prev));
      fail("Não foi possível limpar. Tente de novo.");
    }
  }, [done, listId, supabase, setItems, fail]);

  const isPending = (item: ListItem) => item.id.startsWith(TEMP_ID_PREFIX);

  return (
    <>
      <AppHeader title={householdName} subtitle={listName} />

      {/* Rodapé: barra de adicionar (~3.75rem) + tab bar (3.5rem) + área segura. */}
      <main className="mx-auto w-full max-w-md flex-1 px-3 pb-[calc(9rem+env(safe-area-inset-bottom))] pt-3">
        {error ? (
          <p role="alert" className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {error}
          </p>
        ) : null}

        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
            <span className="text-5xl" aria-hidden>
              🧺
            </span>
            <p className="text-lg font-medium text-zinc-800 dark:text-zinc-200">A lista está vazia</p>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">Adicione o primeiro item na barra abaixo.</p>
          </div>
        ) : null}

        {pending.length > 0 ? (
          <section aria-label="Para comprar">
            <h2 className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Para comprar ({pending.length})
            </h2>
            <ul className="overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
              {pending.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  addedByName={memberNames[item.added_by] ?? null}
                  pending={isPending(item)}
                  onToggle={handleToggle}
                  onDelete={handleDelete}
                />
              ))}
            </ul>
          </section>
        ) : items.length > 0 ? (
          <p className="px-1 py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">Tudo comprado! 🎉</p>
        ) : null}

        {done.length > 0 ? (
          <section aria-label="Comprados" className="mt-5">
            <div className="mb-1 flex items-center justify-between gap-2 px-1">
              <button
                type="button"
                onClick={() => setShowChecked((v) => !v)}
                aria-expanded={showChecked}
                className="flex min-h-11 items-center gap-1 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400"
              >
                <ChevronIcon className={`h-4 w-4 transition-transform ${showChecked ? "" : "-rotate-90"}`} />
                Comprados ({done.length})
              </button>
              <button
                type="button"
                onClick={handleClearChecked}
                disabled={clearing}
                className="min-h-11 rounded-lg px-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950"
              >
                {clearing ? "Limpando..." : "Limpar comprados"}
              </button>
            </div>
            {showChecked ? (
              <ul className="overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
                {done.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    addedByName={memberNames[item.added_by] ?? null}
                    pending={isPending(item)}
                    onToggle={handleToggle}
                    onDelete={handleDelete}
                  />
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}
      </main>

      <AddItemBar onAdd={handleAdd} onPick={handlePick} />
      <TabBar />
    </>
  );
}
