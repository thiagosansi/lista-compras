import type { InputHTMLAttributes } from "react";

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
};

export function Input({ label, id, className = "", ...props }: InputProps) {
  const input = (
    <input
      id={id}
      className={
        "min-h-11 w-full rounded-xl border border-zinc-300 bg-white px-3 text-base text-zinc-900 placeholder:text-zinc-400 " +
        "focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/30 " +
        "dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500 " +
        className
      }
      {...props}
    />
  );
  if (!label) return input;
  return (
    <label htmlFor={id} className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
      {input}
    </label>
  );
}
