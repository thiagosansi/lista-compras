"use client";

import type { ListItem } from "@/lib/database.types";
import { BarcodeIcon, CheckIcon, TrashIcon } from "./icons";

type ItemRowProps = {
  item: ListItem;
  addedByName: string | null;
  pending: boolean;
  onToggle: (item: ListItem) => void;
  onDelete: (item: ListItem) => void;
};

function formatQuantity(quantity: number, unit: string | null): string | null {
  if (quantity === 1 && !unit) return null;
  const q = Number.isInteger(quantity) ? String(quantity) : quantity.toLocaleString("pt-BR");
  return unit ? `${q} ${unit}` : `${q}×`;
}

export function ItemRow({ item, addedByName, pending, onToggle, onDelete }: ItemRowProps) {
  const qty = formatQuantity(item.quantity, item.unit);

  return (
    <li
      className={
        "flex items-stretch border-b border-zinc-100 last:border-b-0 dark:border-zinc-800 " +
        (pending ? "opacity-60" : "")
      }
    >
      <button
        type="button"
        onClick={() => onToggle(item)}
        disabled={pending}
        aria-pressed={item.checked}
        className="flex min-h-14 min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left active:bg-zinc-50 dark:active:bg-zinc-800"
      >
        <span
          className={
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors " +
            (item.checked
              ? "border-emerald-600 bg-emerald-600 text-white"
              : "border-zinc-300 bg-white dark:border-zinc-600 dark:bg-zinc-900")
          }
          aria-hidden
        >
          {item.checked ? <CheckIcon /> : null}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={
              "block truncate text-base " +
              (item.checked ? "text-zinc-400 line-through dark:text-zinc-500" : "text-zinc-900 dark:text-zinc-100")
            }
          >
            {item.name}
            {qty ? <span className="ml-1.5 text-sm text-zinc-500 dark:text-zinc-400">{qty}</span> : null}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
            {addedByName ? (
              <span className="rounded-full bg-zinc-100 px-1.5 py-px text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                {addedByName}
              </span>
            ) : null}
            {item.gtin ? (
              <span
                className="inline-flex items-center gap-0.5 rounded-full border border-zinc-200 px-1.5 py-px text-[10px] font-medium text-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
                title={`Código de barras ${item.gtin}`}
                aria-label={`Código de barras ${item.gtin}`}
              >
                <BarcodeIcon className="h-3 w-3" />
                <span aria-hidden>código</span>
              </span>
            ) : null}
            {item.category ? <span className="truncate">{item.category}</span> : null}
            {item.note ? <span className="truncate">{item.note}</span> : null}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={() => onDelete(item)}
        disabled={pending}
        aria-label={`Excluir ${item.name}`}
        className="flex min-h-11 min-w-11 items-center justify-center px-2 text-zinc-400 hover:text-red-600 active:text-red-700 dark:text-zinc-500 dark:hover:text-red-400"
      >
        <TrashIcon />
      </button>
    </li>
  );
}
