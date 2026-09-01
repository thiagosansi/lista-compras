import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const base =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-base font-medium transition-colors " +
  "disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 " +
  "active:scale-[0.98] select-none";

const variants: Record<Variant, string> = {
  primary: "bg-emerald-600 text-white hover:bg-emerald-700",
  secondary:
    "border border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800",
  ghost: "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800",
  danger: "border border-red-200 bg-white text-red-700 hover:bg-red-50 dark:border-red-900 dark:bg-zinc-900 dark:text-red-400 dark:hover:bg-red-950",
};

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  full?: boolean;
};

export function Button({ variant = "primary", full, className = "", type = "button", ...props }: ButtonProps) {
  return (
    <button type={type} className={`${base} ${variants[variant]} ${full ? "w-full" : ""} ${className}`} {...props} />
  );
}
