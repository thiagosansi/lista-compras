export default function WhereToBuyLoading() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-3 pt-16" aria-busy>
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-28 animate-pulse rounded-2xl bg-zinc-200 dark:bg-zinc-800" />
      ))}
      <p className="text-center text-sm text-zinc-500">Carregando preços...</p>
    </main>
  );
}
