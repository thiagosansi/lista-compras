"use client";

import type { ListItem } from "@/lib/database.types";
import { CATEGORIES, isCategory, type Category } from "@/lib/categories";
import { BottomSheet } from "./bottom-sheet";

type CategorySheetProps = {
  item: ListItem;
  onClose: () => void;
  onChoose: (category: Category) => void;
};

/**
 * Folha para corrigir manualmente a seção de um item pendente (ordem = percurso do mercado).
 * Item sem categoria mostra "Sem seção" como atual — nenhuma opção fica destacada até o
 * usuário escolher uma (inclusive "Outros", que é uma seção real e não o estado "sem seção").
 */
export function CategorySheet({ item, onClose, onChoose }: CategorySheetProps) {
  const current = isCategory(item.category) ? item.category : null;

  return (
    <BottomSheet title="Mover para seção" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Seção atual: <span className="font-medium text-zinc-700 dark:text-zinc-300">{current ?? "Sem seção"}</span>
        </p>
        <ul className="flex flex-col gap-1">
          {CATEGORIES.map((cat) => {
            const selected = cat === current;
            return (
              <li key={cat}>
                <button
                  type="button"
                  onClick={() => onChoose(cat)}
                  className={`flex min-h-12 w-full items-center justify-between gap-3 rounded-xl px-3 text-left text-base ${
                    selected
                      ? "bg-emerald-50 font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                      : "text-zinc-900 active:bg-zinc-50 dark:text-zinc-100 dark:active:bg-zinc-800"
                  }`}
                >
                  <span>{cat}</span>
                  {selected ? (
                    <svg
                      className="h-5 w-5 shrink-0"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      <path d="M5 12l5 5L20 7" />
                    </svg>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </BottomSheet>
  );
}
