import { LoginForm } from "@/components/auth/login-form";

/** Só aceita caminhos internos (evita open redirect). */
function safeNext(value: string | string[] | undefined): string {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v || !v.startsWith("/") || v.startsWith("//") || v.startsWith("/login")) return "/";
  return v;
}

export default async function LoginPage(props: PageProps<"/login">) {
  const searchParams = await props.searchParams;
  const next = safeNext(searchParams.next);

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-8 px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(3rem,env(safe-area-inset-top))]">
      <div className="text-center">
        <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-600 text-3xl" aria-hidden>
          🛒
        </div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Lista de Compras</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Uma lista só, para vocês dois.</p>
      </div>
      <LoginForm next={next} />
    </main>
  );
}
