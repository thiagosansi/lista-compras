"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { StorePicker, type RecentStore, type StoreChoice } from "./store-picker";

export type { RecentStore, StoreChoice };

type StartSessionProps = {
  recentStores: RecentStore[];
  starting: boolean;
  error: string | null;
  onStart: (choice: StoreChoice) => void;
};

/** Tela "Começar compra": escolhe a loja (recentes, busca, texto livre ou mais próxima) e abre a sessão. */
export function StartSession({ recentStores, starting, error, onStart }: StartSessionProps) {
  const [choice, setChoice] = useState<StoreChoice | null>(null);

  return (
    <Card className="flex flex-col gap-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Começar compra</p>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Em que loja você está? O total da compra é calculado enquanto você pega os itens.</p>
      </div>

      <StorePicker recentStores={recentStores} disabled={starting} onChange={setChoice} />

      {error ? <Alert kind="error">{error}</Alert> : null}

      <Button full disabled={!choice || starting} onClick={() => choice && onStart(choice)}>
        {starting ? "Abrindo..." : choice ? `Começar em ${choice.storeName}` : "Escolha a loja"}
      </Button>
    </Card>
  );
}
