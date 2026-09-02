"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Altura da barra: 56px (h-14). Páginas somam isto ao padding inferior do conteúdo. */
export const TAB_BAR_HEIGHT_CLASS = "h-14";
/** Padding inferior para o `<main>` de páginas que só têm a tab bar no rodapé. */
export const TAB_BAR_PADDING_CLASS = "pb-[calc(4.5rem+env(safe-area-inset-bottom))]";

type IconProps = { className?: string };

function ListIcon({ className = "h-6 w-6" }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="M4 6h.01M4 12h.01M4 18h.01" />
    </svg>
  );
}

function CartIcon({ className = "h-6 w-6" }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 3h2.5l2.4 12.2a1 1 0 0 0 1 .8h9.8a1 1 0 0 0 1-.8L21 7H6" />
      <circle cx="9" cy="20" r="1.5" />
      <circle cx="17" cy="20" r="1.5" />
    </svg>
  );
}

function TagIcon({ className = "h-6 w-6" }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z" />
      <path d="M7.5 7.5h.01" />
    </svg>
  );
}

function ReceiptIcon({ className = "h-6 w-6" }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 3h14v18l-2.5-1.5L14 21l-2-1.5L10 21l-2.5-1.5L5 21Z" />
      <path d="M9 8h6M9 12h6M9 16h4" />
    </svg>
  );
}

function HomeIcon({ className = "h-6 w-6" }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 11l9-8 9 8" />
      <path d="M5 10v10a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V10" />
    </svg>
  );
}

const TABS = [
  { href: "/lista", label: "Lista", Icon: ListIcon },
  { href: "/compras", label: "Compras", Icon: CartIcon },
  { href: "/onde-comprar", label: "Onde comprar", Icon: TagIcon },
  { href: "/cupom", label: "Cupom", Icon: ReceiptIcon },
  { href: "/casa", label: "Casa", Icon: HomeIcon },
] as const;

/**
 * Barra de navegação inferior, fixa no rodapé, respeitando a área segura do iOS.
 * Cada página logada renderiza `<TabBar />` uma vez e reserva espaço no fim do
 * conteúdo (ver `TAB_BAR_PADDING_CLASS`).
 */
export function TabBar() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Navegação principal"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-zinc-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95"
    >
      <ul className={`mx-auto flex w-full max-w-md items-stretch ${TAB_BAR_HEIGHT_CLASS}`}>
        {TABS.map(({ href, label, Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={href} className="flex flex-1">
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={
                  // 5 abas em 360px: ~72px cada; padding mínimo e tracking-tight para "Onde comprar" caber.
                  "flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg px-0.5 text-[11px] font-medium leading-none tracking-tight transition-colors select-none " +
                  (active
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200")
                }
              >
                <Icon className={active ? "h-6 w-6" : "h-6 w-6 opacity-90"} />
                <span className="max-w-full truncate">{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
