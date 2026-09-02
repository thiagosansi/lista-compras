"use client";

import { useRef, useState, type FormEvent } from "react";
import { PlusIcon } from "./icons";

type AddItemBarProps = {
  onAdd: (name: string, quantity: number) => void;
};

/** Barra fixa logo acima da tab bar (3.5rem + área segura) para adicionar itens. Enter adiciona. */
export function AddItemBar({ onAdd }: AddItemBarProps) {
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const q = quantity.trim() ? Number(quantity.replace(",", ".")) : 1;
    onAdd(trimmed, Number.isFinite(q) && q > 0 ? q : 1);
    setName("");
    setQuantity("");
    nameRef.current?.focus();
  }

  const inputClass =
    "min-h-11 rounded-xl border border-zinc-300 bg-white px-3 text-base text-zinc-900 placeholder:text-zinc-400 " +
    "focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/30 " +
    "dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500";

  return (
    <form
      onSubmit={handleSubmit}
      className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-10 border-t border-zinc-200 bg-white/95 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95"
    >
      <div className="mx-auto flex w-full max-w-md items-center gap-2 px-3 py-2">
        <input
          ref={nameRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Adicionar item..."
          aria-label="Nome do item"
          autoComplete="off"
          autoCapitalize="sentences"
          enterKeyHint="done"
          className={`${inputClass} min-w-0 flex-1`}
        />
        <input
          type="text"
          inputMode="decimal"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value.replace(/[^0-9.,]/g, "").slice(0, 6))}
          placeholder="Qtd"
          aria-label="Quantidade (opcional)"
          className={`${inputClass} w-16 text-center`}
        />
        <button
          type="submit"
          disabled={!name.trim()}
          aria-label="Adicionar"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white transition-colors hover:bg-emerald-700 disabled:opacity-40"
        >
          <PlusIcon />
        </button>
      </div>
    </form>
  );
}
