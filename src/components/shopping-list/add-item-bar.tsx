"use client";

import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ProductSuggestion } from "@/lib/database.types";
import { useProductSuggestions } from "@/lib/hooks/use-product-suggestions";
import { formatProductName } from "@/lib/products/format";
import { BarcodeIcon, PlusIcon } from "./icons";

type AddItemBarProps = {
  onAdd: (name: string, quantity: number) => void;
  /** Sugestão escolhida (toque ou Enter com uma opção realçada). */
  onPick: (sugestao: ProductSuggestion, quantity: number) => void;
};

function parseQuantity(raw: string): number {
  const q = raw.trim() ? Number(raw.replace(",", ".")) : 1;
  return Number.isFinite(q) && q > 0 ? q : 1;
}

function formatPrice(value: number): string {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/** "2026-08-30T..." → "30/08". Aceita qualquer string que o Date entenda; senão devolve o original. */
function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

/** Barra fixa logo acima da tab bar (3.5rem + área segura) para adicionar itens. Enter adiciona; sugestões acima. */
export function AddItemBar({ onAdd, onPick }: AddItemBarProps) {
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const nameRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const { sugestoes, carregando, fonteExterna, buscarMais, buscandoMais, avisoBuscarMais } = useProductSuggestions(name);
  const open = !dismissed && name.trim().length >= 3 && sugestoes.length > 0;
  const activeId = open && activeIndex >= 0 && activeIndex < sugestoes.length ? `${listId}-opt-${activeIndex}` : undefined;

  function reset() {
    setName("");
    setQuantity("");
    setDismissed(false);
    setActiveIndex(-1);
    nameRef.current?.focus();
  }

  function pick(s: ProductSuggestion) {
    onPick(s, parseQuantity(quantity));
    reset();
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (open && activeIndex >= 0 && sugestoes[activeIndex]) {
      pick(sugestoes[activeIndex]);
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) return;
    onAdd(trimmed, parseQuantity(quantity));
    reset();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setDismissed(true);
        setActiveIndex(-1);
      }
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % sugestoes.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? sugestoes.length - 1 : i - 1));
    }
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
      {open ? (
        <div className="mx-auto w-full max-w-md px-3 pt-2">
          <ul
            id={listId}
            role="listbox"
            aria-label="Sugestões de produtos"
            className="max-h-[40vh] overflow-y-auto overscroll-contain rounded-2xl border border-zinc-200 bg-white shadow-lg dark:border-zinc-800 dark:bg-zinc-900"
          >
            {sugestoes.map((s, i) => {
              const active = i === activeIndex;
              return (
                <li
                  key={s.gtin}
                  id={`${listId}-opt-${i}`}
                  role="option"
                  aria-selected={active}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(s)}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={
                    "flex min-h-12 cursor-pointer items-center gap-2.5 border-b border-zinc-100 px-3 py-2 last:border-b-0 dark:border-zinc-800 " +
                    (active ? "bg-emerald-50 dark:bg-emerald-950/40" : "active:bg-zinc-50 dark:active:bg-zinc-800")
                  }
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-zinc-900 dark:text-zinc-100">{formatProductName(s.descricao)}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                      {s.categoria ? <span>{s.categoria}</span> : null}
                      {s.ultimaCompra ? (
                        <span className="text-emerald-700 dark:text-emerald-400">
                          última compra: {formatPrice(s.ultimaCompra.preco)} em {s.ultimaCompra.loja} ({formatShortDate(s.ultimaCompra.data)})
                        </span>
                      ) : null}
                    </span>
                  </span>
                  <BarcodeIcon className="h-4 w-4 shrink-0 text-zinc-400 dark:text-zinc-500" />
                </li>
              );
            })}
          </ul>
          {carregando || fonteExterna ? (
            <p className="mt-1 px-1 text-[11px] text-zinc-400 dark:text-zinc-500" aria-live="polite">
              {carregando ? "Buscando…" : "Inclui sugestões do Preço da Hora"}
            </p>
          ) : null}
          <div className="mt-1 flex items-center justify-between gap-2 px-1">
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => buscarMais()}
              disabled={buscandoMais || name.trim().length < 5}
              className="text-[11px] font-medium text-emerald-700 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:text-zinc-400 dark:text-emerald-400 dark:disabled:text-zinc-600"
            >
              {buscandoMais ? "Buscando…" : "Buscar mais produtos"}
            </button>
          </div>
          {avisoBuscarMais ? (
            <p className="mt-0.5 px-1 text-[11px] text-amber-600 dark:text-amber-400" aria-live="polite">
              {avisoBuscarMais}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="mx-auto flex w-full max-w-md items-center gap-2 px-3 py-2">
        <input
          ref={nameRef}
          type="text"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setDismissed(false);
            setActiveIndex(-1);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Adicionar item..."
          aria-label="Nome do item"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
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
