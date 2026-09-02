"use client";

import { useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { AppHeader } from "@/components/app-header";
import { TabBar, TAB_BAR_PADDING_CLASS } from "@/components/nav/tab-bar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { LocationCard } from "./location-card";

export type HouseholdMember = {
  userId: string;
  displayName: string | null;
  role: "owner" | "member";
  isCurrentUser: boolean;
};

const noopSubscribe = () => () => {};
const hasShareApi = () => typeof navigator.share === "function";
const serverHasShareApi = () => false;

type HouseholdViewProps = {
  householdId: string;
  householdName: string;
  inviteCode: string;
  members: HouseholdMember[];
  lat: number | null;
  lng: number | null;
  address: string | null;
};

export function HouseholdView({ householdId, householdName, inviteCode, members, lat, lng, address }: HouseholdViewProps) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  // Web Share API só existe no cliente; no servidor o botão fica oculto (sem mismatch de hidratação).
  const canShare = useSyncExternalStore(noopSubscribe, hasShareApi, serverHasShareApi);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(inviteCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Sem permissão de clipboard: o código continua visível para copiar à mão.
    }
  }

  async function handleShare() {
    try {
      await navigator.share({ text: `Entre na minha lista de compras com o código ${inviteCode}` });
    } catch {
      // Usuário cancelou o compartilhamento.
    }
  }

  async function handleSignOut() {
    setSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <>
      <AppHeader title="Minha casa" />

      <main className={`mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-3 pt-3 ${TAB_BAR_PADDING_CLASS}`}>
        <Card>
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Casa</p>
          <h2 className="mt-1 text-2xl font-bold text-zinc-900 dark:text-zinc-100">{householdName}</h2>
        </Card>

        <Card className="flex flex-col gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Código de convite</p>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Quem entrar com este código passa a ver e editar a mesma lista.
            </p>
          </div>
          <p
            className="select-all rounded-xl bg-zinc-100 py-4 text-center font-mono text-4xl font-bold tracking-[0.3em] text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
            aria-label={`Código de convite: ${inviteCode.split("").join(" ")}`}
          >
            {inviteCode}
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" full onClick={handleCopy}>
              {copied ? "Copiado!" : "Copiar"}
            </Button>
            {canShare ? (
              <Button full onClick={handleShare}>
                Compartilhar
              </Button>
            ) : null}
          </div>
        </Card>

        <LocationCard householdId={householdId} lat={lat} lng={lng} address={address} />

        <Card>
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Membros ({members.length})
          </p>
          <ul className="mt-2 divide-y divide-zinc-100 dark:divide-zinc-800">
            {members.map((m) => (
              <li key={m.userId} className="flex min-h-12 items-center gap-3 py-2">
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-sm font-semibold uppercase text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
                  aria-hidden
                >
                  {(m.displayName ?? "?").slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base text-zinc-900 dark:text-zinc-100">
                    {m.displayName ?? "Sem nome"}
                    {m.isCurrentUser ? <span className="text-zinc-500 dark:text-zinc-400"> (você)</span> : null}
                  </span>
                  <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                    {m.role === "owner" ? "Criou a casa" : "Membro"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {members.length < 2 ? (
            <p className="mt-2 rounded-xl bg-zinc-50 px-3 py-2 text-sm text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
              Só você por aqui. Compartilhe o código acima para chamar alguém.
            </p>
          ) : null}
        </Card>

        <Button variant="danger" full onClick={handleSignOut} disabled={signingOut} className="mt-2">
          {signingOut ? "Saindo..." : "Sair da conta"}
        </Button>
      </main>

      <TabBar />
    </>
  );
}
