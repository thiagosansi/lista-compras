import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Onboarding } from "@/components/onboarding";

export default async function HomePage() {
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

  if (membership) redirect("/lista");

  const { data: profile } = await supabase.from("profiles").select("display_name").eq("id", user.id).maybeSingle();

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(2rem,env(safe-area-inset-top))]">
      <Onboarding displayName={profile?.display_name ?? null} />
    </main>
  );
}
