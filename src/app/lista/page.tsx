import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ShoppingList } from "@/components/shopping-list/shopping-list";

export default async function ListPage() {
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

  const [{ data: household }, { data: lists }, { data: members }] = await Promise.all([
    supabase.from("households").select("id, name").eq("id", householdId).single(),
    supabase
      .from("lists")
      .select("id, name, is_default")
      .eq("household_id", householdId)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(1),
    supabase.from("household_members").select("user_id").eq("household_id", householdId),
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

  const memberIds = (members ?? []).map((m) => m.user_id);
  const [{ data: items }, { data: profiles }] = await Promise.all([
    supabase.from("list_items").select("*").eq("list_id", list.id).order("created_at", { ascending: false }),
    memberIds.length > 0
      ? supabase.from("profiles").select("id, display_name").in("id", memberIds)
      : Promise.resolve({ data: [] as { id: string; display_name: string | null }[] }),
  ]);

  const memberNames: Record<string, string> = {};
  for (const p of profiles ?? []) {
    if (p.display_name) memberNames[p.id] = p.display_name;
  }

  return (
    <ShoppingList
      listId={list.id}
      listName={list.name}
      householdName={household.name}
      currentUserId={user.id}
      memberNames={memberNames}
      initialItems={items ?? []}
    />
  );
}
