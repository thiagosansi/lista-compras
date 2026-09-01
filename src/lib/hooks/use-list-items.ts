"use client";

import { useCallback, useEffect, useState } from "react";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import type { ListItem } from "@/lib/database.types";

export const TEMP_ID_PREFIX = "temp-";

/** Insere ou substitui um item pelo id, mantendo a ordem dos demais. */
export function upsertItem(items: ListItem[], item: ListItem): ListItem[] {
  const idx = items.findIndex((i) => i.id === item.id);
  if (idx === -1) return [...items, item];
  const next = items.slice();
  next[idx] = item;
  return next;
}

/**
 * Estado local dos itens de uma lista + assinatura realtime em `list_items`.
 * INSERT/UPDATE/DELETE vindos do servidor são aplicados sobre o estado.
 */
export function useListItems(listId: string, initialItems: ListItem[]) {
  const [items, setItems] = useState<ListItem[]>(initialItems);

  const applyChange = useCallback((payload: RealtimePostgresChangesPayload<ListItem>) => {
    setItems((prev) => {
      switch (payload.eventType) {
        case "INSERT":
          return upsertItem(prev, payload.new);
        case "UPDATE":
          return upsertItem(prev, payload.new);
        case "DELETE": {
          const id = payload.old.id;
          return id ? prev.filter((i) => i.id !== id) : prev;
        }
        default:
          return prev;
      }
    });
  }, []);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`list:${listId}`)
      .on<ListItem>(
        "postgres_changes",
        { event: "*", schema: "public", table: "list_items", filter: `list_id=eq.${listId}` },
        applyChange,
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [listId, applyChange]);

  return { items, setItems };
}
