import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CupomView, type RecentReceipt } from "@/components/cupom/cupom-view";

export default async function CupomPage() {
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

  const { data: receipts } = await supabase
    .from("receipts")
    .select("id, store_id, issued_at, created_at, total, item_count")
    .eq("household_id", membership.household_id)
    .order("created_at", { ascending: false })
    .limit(10);

  const rows = receipts ?? [];
  const storeIds = [...new Set(rows.map((r) => r.store_id))];
  const { data: stores } = storeIds.length
    ? await supabase.from("stores").select("id, name").in("id", storeIds)
    : { data: [] as { id: string; name: string }[] };
  const storeName = new Map((stores ?? []).map((s) => [s.id, s.name] as const));

  const recent: RecentReceipt[] = rows.map((r) => ({
    id: r.id,
    storeName: storeName.get(r.store_id) ?? "Loja",
    issuedAt: r.issued_at,
    createdAt: r.created_at,
    total: r.total,
    itemCount: r.item_count,
  }));

  return <CupomView recent={recent} />;
}
