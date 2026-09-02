import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { ShoppingSessionItem } from "@/lib/database.types";
import { ComprasView, type SessionHistoryEntry } from "@/components/compras/compras-view";
import type { RecentStore } from "@/components/compras/start-session";

const RECENT_STORES_LIMIT = 8;

export default async function ComprasPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: membership } = await supabase
    .from("household_members")
    .select("household_id")
    .eq("user_id", user.id)
    .order("joined_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!membership) redirect("/");

  const householdId = membership.household_id;

  const [{ data: household }, { data: lists }, { data: openSession }, { data: finishedSessions }, { data: observations }, { data: receipts }] =
    await Promise.all([
      supabase.from("households").select("id, name").eq("id", householdId).single(),
      supabase
        .from("lists")
        .select("id, name, is_default")
        .eq("household_id", householdId)
        .order("is_default", { ascending: false })
        .order("created_at", { ascending: true })
        .limit(1),
      supabase.from("shopping_sessions").select("*").eq("household_id", householdId).is("finished_at", null).maybeSingle(),
      supabase
        .from("shopping_sessions")
        .select("id, store_id, store_name, finished_at, total")
        .eq("household_id", householdId)
        .not("finished_at", "is", null)
        .order("finished_at", { ascending: false })
        .limit(20),
      supabase
        .from("price_observations")
        .select("store_id, observed_at")
        .eq("household_id", householdId)
        .in("source", ["nfce", "manual"])
        .order("observed_at", { ascending: false })
        .limit(200),
      supabase
        .from("receipts")
        .select("store_id, created_at")
        .eq("household_id", householdId)
        .order("created_at", { ascending: false })
        .limit(50),
    ]);

  const list = lists?.[0];
  if (!household || !list) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-lg font-medium text-zinc-800 dark:text-zinc-200">Nenhuma lista encontrada</p>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Sua casa ainda não tem uma lista. Tente recarregar a página.</p>
      </main>
    );
  }

  // Lojas recentes: sessões finalizadas + cupons + observações manuais/NFC-e, por recência, sem repetir.
  const finished = finishedSessions ?? [];
  const recency: { storeId: string; at: string }[] = [
    ...finished.flatMap((s) => (s.store_id && s.finished_at ? [{ storeId: s.store_id, at: s.finished_at }] : [])),
    ...(receipts ?? []).map((r) => ({ storeId: r.store_id, at: r.created_at })),
    ...(observations ?? []).map((o) => ({ storeId: o.store_id, at: o.observed_at })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const recentStoreIds: string[] = [];
  for (const { storeId } of recency) {
    if (!recentStoreIds.includes(storeId)) recentStoreIds.push(storeId);
    if (recentStoreIds.length >= RECENT_STORES_LIMIT) break;
  }

  const historyStoreIds = finished.flatMap((s) => (s.store_id && !s.store_name ? [s.store_id] : []));
  const storeIds = [...new Set([...recentStoreIds, ...historyStoreIds])];

  const [{ data: stores }, { data: sessionItems }] = await Promise.all([
    storeIds.length
      ? supabase.from("stores").select("id, name, address, lat, lng").in("id", storeIds)
      : Promise.resolve({ data: [] as RecentStore[] }),
    openSession
      ? supabase.from("shopping_session_items").select("*").eq("session_id", openSession.id).order("created_at", { ascending: true })
      : Promise.resolve({ data: [] as ShoppingSessionItem[] }),
  ]);
  const storeById = new Map((stores ?? []).map((s) => [s.id, s] as const));

  const recentStores: RecentStore[] = recentStoreIds.flatMap((id) => {
    const s = storeById.get(id);
    return s ? [{ id: s.id, name: s.name, address: s.address, lat: s.lat, lng: s.lng }] : [];
  });

  const history: SessionHistoryEntry[] = finished.slice(0, 5).map((s) => ({
    id: s.id,
    storeName: s.store_name ?? (s.store_id ? (storeById.get(s.store_id)?.name ?? "Loja") : "Loja"),
    finishedAt: s.finished_at!,
    total: Number(s.total),
  }));

  const [{ data: pendingItems }] = await Promise.all([
    supabase.from("list_items").select("*").eq("list_id", list.id).eq("checked", false).order("created_at", { ascending: true }),
  ]);

  return (
    <ComprasView
      householdId={householdId}
      householdName={household.name}
      listId={list.id}
      currentUserId={user.id}
      initialSession={openSession ?? null}
      initialSessionItems={sessionItems ?? []}
      initialPendingItems={pendingItems ?? []}
      recentStores={recentStores}
      initialHistory={history}
    />
  );
}
