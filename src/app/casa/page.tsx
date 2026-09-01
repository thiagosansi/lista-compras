import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { HouseholdView, type HouseholdMember } from "@/components/household/household-view";

export default async function HouseholdPage() {
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

  const [{ data: household }, { data: memberRows }] = await Promise.all([
    supabase.from("households").select("name, invite_code").eq("id", householdId).single(),
    supabase
      .from("household_members")
      .select("user_id, role, joined_at")
      .eq("household_id", householdId)
      .order("joined_at", { ascending: true }),
  ]);
  if (!household) redirect("/");

  const rows = memberRows ?? [];
  const { data: profiles } = rows.length
    ? await supabase
        .from("profiles")
        .select("id, display_name")
        .in(
          "id",
          rows.map((r) => r.user_id),
        )
    : { data: [] as { id: string; display_name: string | null }[] };

  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.display_name] as const));
  const members: HouseholdMember[] = rows.map((r) => ({
    userId: r.user_id,
    displayName: nameById.get(r.user_id) ?? null,
    role: r.role,
    isCurrentUser: r.user_id === user.id,
  }));

  return <HouseholdView householdName={household.name} inviteCode={household.invite_code} members={members} />;
}
