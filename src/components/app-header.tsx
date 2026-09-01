import type { ReactNode } from "react";

type AppHeaderProps = {
  title: string;
  subtitle?: string;
  left?: ReactNode;
  right?: ReactNode;
};

/** Cabeçalho fixo no topo, respeitando a área segura do iOS. */
export function AppHeader({ title, subtitle, left, right }: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/90 pt-[env(safe-area-inset-top)] backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
      <div className="mx-auto flex min-h-14 w-full max-w-md items-center gap-2 px-3">
        {left}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold text-zinc-900 dark:text-zinc-100">{title}</h1>
          {subtitle ? <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</p> : null}
        </div>
        {right}
      </div>
    </header>
  );
}
