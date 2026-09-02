"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import type { ShoppingSession, ShoppingSessionItem } from "@/lib/database.types";

/** Colunas numeric podem chegar como string pelo realtime; normaliza para number. */
export function normalizeSessionItem(item: ShoppingSessionItem): ShoppingSessionItem {
  const quantity = Number(item.quantity);
  const unit_price = Number(item.unit_price);
  const total = item.total == null || Number.isNaN(Number(item.total)) ? quantity * unit_price : Number(item.total);
  return { ...item, quantity, unit_price, total };
}

/** Insere ou substitui um item do carrinho pelo id, mantendo a ordem dos demais. */
export function upsertSessionItem(items: ShoppingSessionItem[], item: ShoppingSessionItem): ShoppingSessionItem[] {
  const normalized = normalizeSessionItem(item);
  const idx = items.findIndex((i) => i.id === normalized.id);
  if (idx === -1) return [...items, normalized];
  const next = items.slice();
  next[idx] = normalized;
  return next;
}

/**
 * Estado local da sessão de compra (carrinho) + assinaturas realtime em
 * `shopping_session_items` (filtro `session_id`) e `shopping_sessions` (filtro `id`).
 * O total exibido é a soma local dos itens (otimista); o `total` da sessão vindo do
 * servidor chega pelo canal e fica em `session.total`.
 */
export function useShoppingSession(initialSession: ShoppingSession | null, initialItems: ShoppingSessionItem[]) {
  const [session, setSession] = useState<ShoppingSession | null>(initialSession);
  const [items, setItems] = useState<ShoppingSessionItem[]>(() => initialItems.map(normalizeSessionItem));
  const sessionId = session?.id ?? null;

  const applyItemChange = useCallback((payload: RealtimePostgresChangesPayload<ShoppingSessionItem>) => {
    setItems((prev) => {
      switch (payload.eventType) {
        case "INSERT":
        case "UPDATE":
          return upsertSessionItem(prev, payload.new);
        case "DELETE": {
          const id = payload.old.id;
          return id ? prev.filter((i) => i.id !== id) : prev;
        }
        default:
          return prev;
      }
    });
  }, []);

  const applySessionChange = useCallback((payload: RealtimePostgresChangesPayload<ShoppingSession>) => {
    if (payload.eventType === "DELETE") {
      // Sessão cancelada/apagada por outro dispositivo: volta para a tela "Começar compra".
      setSession((prev) => (prev && prev.id === payload.old.id ? null : prev));
      return;
    }
    if (payload.eventType !== "UPDATE") return;
    const next = payload.new;
    setSession((prev) => (prev && prev.id === next.id ? { ...prev, ...next, total: Number(next.total) } : prev));
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    const supabase = createClient();
    const channel = supabase
      .channel(`shopping:${sessionId}`)
      .on<ShoppingSessionItem>(
        "postgres_changes",
        { event: "*", schema: "public", table: "shopping_session_items", filter: `session_id=eq.${sessionId}` },
        applyItemChange,
      )
      .on<ShoppingSession>(
        "postgres_changes",
        { event: "*", schema: "public", table: "shopping_sessions", filter: `id=eq.${sessionId}` },
        applySessionChange,
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [sessionId, applyItemChange, applySessionChange]);

  const total = useMemo(() => items.reduce((sum, i) => sum + i.quantity * i.unit_price, 0), [items]);

  return { session, setSession, items, setItems, total };
}
