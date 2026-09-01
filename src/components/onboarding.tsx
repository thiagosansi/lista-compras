"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";

function translateRpcError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("inválido") || m.includes("invalid") || m.includes("não encontrado") || m.includes("not found"))
    return "Código inválido. Confira e tente de novo.";
  if (m.includes("fetch") || m.includes("network")) return "Sem conexão. Verifique sua internet.";
  return "Não foi possível concluir. Tente novamente.";
}

type OnboardingProps = {
  displayName: string | null;
};

export function Onboarding({ displayName }: OnboardingProps) {
  const router = useRouter();
  const supabase = createClient();

  const [houseName, setHouseName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"create" | "join" | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);

  function goToList() {
    router.push("/lista");
    router.refresh();
  }

  async function handleCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = houseName.trim();
    if (!name) return;
    setCreateError(null);
    setBusy("create");
    const { error } = await supabase.rpc("create_household", { p_name: name });
    setBusy(null);
    if (error) {
      setCreateError(translateRpcError(error.message));
      return;
    }
    goToList();
  }

  async function handleJoin(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const normalized = code.trim().toUpperCase();
    if (normalized.length < 6) {
      setJoinError("O código tem 6 caracteres.");
      return;
    }
    setJoinError(null);
    setBusy("join");
    const { error } = await supabase.rpc("join_household", { p_code: normalized });
    setBusy(null);
    if (error) {
      setJoinError(translateRpcError(error.message));
      return;
    }
    goToList();
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
          Olá{displayName ? `, ${displayName}` : ""}!
        </h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Para começar, crie uma casa ou entre na casa de alguém com o código de convite.
        </p>
      </div>

      <Card>
        <form onSubmit={handleCreate} className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Criar casa</h2>
          <Input
            id="house_name"
            label="Nome da casa"
            placeholder="Ex.: Nossa casa"
            value={houseName}
            onChange={(e) => setHouseName(e.target.value)}
            maxLength={60}
            required
          />
          {createError ? <Alert kind="error">{createError}</Alert> : null}
          <Button type="submit" full disabled={busy !== null}>
            {busy === "create" ? "Criando..." : "Criar casa"}
          </Button>
        </form>
      </Card>

      <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-zinc-400">
        <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
        ou
        <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
      </div>

      <Card>
        <form onSubmit={handleJoin} className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Entrar com código</h2>
          <Input
            id="invite_code"
            label="Código de convite"
            placeholder="ABC123"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            className="text-center font-mono text-xl uppercase tracking-[0.3em]"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))}
            maxLength={6}
            required
          />
          {joinError ? <Alert kind="error">{joinError}</Alert> : null}
          <Button type="submit" variant="secondary" full disabled={busy !== null}>
            {busy === "join" ? "Entrando..." : "Entrar na casa"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
