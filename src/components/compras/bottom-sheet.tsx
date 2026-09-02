"use client";

import { useEffect, type ReactNode } from "react";

type BottomSheetProps = {
  title: string;
  onClose: () => void;
  children: ReactNode;
};

/** Folha inferior modal, mobile-first: fecha por toque no fundo, botão X ou Esc. */
export function BottomSheet({ title, onClose, children }: BottomSheetProps) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center" role="presentation">
      <button type="button" aria-label="Fechar" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex max-h-[92dvh] w-full max-w-md flex-col rounded-t-3xl bg-white pb-[env(safe-area-inset-bottom)] shadow-xl dark:bg-zinc-900"
      >
        <div className="flex items-center gap-2 px-4 pt-3 pb-2">
          <span aria-hidden className="absolute top-1.5 left-1/2 h-1 w-10 -translate-x-1/2 rounded-full bg-zinc-300 dark:bg-zinc-700" />
          <h2 className="min-w-0 flex-1 truncate pt-1 text-base font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 pb-4">{children}</div>
      </div>
    </div>
  );
}
