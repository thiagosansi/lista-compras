export default function ComprasLoading() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-3 pt-16" aria-busy>
      <div className="h-24 animate-pulse rounded-2xl bg-zinc-200 dark:bg-zinc-800" />
      {[0, 1].map((i) => (
        <div key={i} className="h-36 animate-pulse rounded-2xl bg-zinc-200 dark:bg-zinc-800" />
      ))}
      <p className="text-center text-sm text-zinc-500">Carregando compra...</p>
    </main>
  );
}
