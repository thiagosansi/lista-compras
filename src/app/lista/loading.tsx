export default function ListLoading() {
  return (
    <main className="mx-auto w-full max-w-md flex-1 px-3 pt-16" aria-busy>
      <div className="mb-2 h-3 w-24 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
      <ul className="overflow-hidden rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className="flex items-center gap-3 border-b border-zinc-100 px-3 py-4 last:border-b-0 dark:border-zinc-800">
            <span className="h-6 w-6 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-800" />
            <span className="h-4 flex-1 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          </li>
        ))}
      </ul>
      <p className="mt-4 text-center text-sm text-zinc-500">Carregando a lista...</p>
    </main>
  );
}
