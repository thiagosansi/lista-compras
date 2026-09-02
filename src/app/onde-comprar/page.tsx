import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { WhereToBuy, type PendingItem } from "@/components/precos/where-to-buy";

export default async function WhereToBuyPage() {
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

  const [{ data: household }, { data: lists }] = await Promise.all([
    supabase.from("households").select("id, name, lat, lng").eq("id", householdId).single(),
    supabase
      .from("lists")
      .select("id, name, is_default")
      .eq("household_id", householdId)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(1),
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

  const [{ data: rows, error: rpcError }, { data: pendingRows }] = await Promise.all([
    supabase.rpc("best_prices", { p_list_id: list.id }),
    supabase
      .from("list_items")
      .select("id, name, quantity, unit")
      .eq("list_id", list.id)
      .eq("checked", false)
      .order("created_at", { ascending: false }),
  ]);

  const items: PendingItem[] = (pendingRows ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    quantity: r.quantity,
    unit: r.unit,
  }));

  return (
    <WhereToBuy
      listId={list.id}
      householdName={household.name}
      hasLocation={household.lat != null && household.lng != null}
      items={items}
      rows={rows ?? []}
      loadError={rpcError ? "Não foi possível carregar os preços. Tente recarregar a página." : null}
    />
  );
}
