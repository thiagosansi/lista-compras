"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { translateAuthError } from "./auth-errors";

type Tab = "signin" | "signup";

type LoginFormProps = {
  /** Rota para onde voltar após o login (já validada no servidor). */
  next: string;
};

export function LoginForm({ next }: LoginFormProps) {
  const router = useRouter();
  const supabase = createClient();

  const [tab, setTab] = useState<Tab>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function switchTab(t: Tab) {
    setTab(t);
    setError(null);
    setInfo(null);
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setLoading(true);

    try {
      if (tab === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) {
          setError(translateAuthError(error.message));
          return;
        }
        router.push(next);
        router.refresh();
        return;
      }

      const name = displayName.trim();
      if (!name) {
        setError("Informe seu nome.");
        return;
      }
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { data: { display_name: name } },
      });
      if (error) {
        setError(translateAuthError(error.message));
        return;
      }
      // Email já cadastrado: o Supabase devolve um usuário "fantasma" sem identidades.
      if (data.user && data.user.identities && data.user.identities.length === 0) {
        setError("Este email já está cadastrado. Tente entrar.");
        return;
      }
      if (data.user && !data.session) {
        setInfo("Confira seu email para confirmar a conta.");
        return;
      }
      router.push(next);
      router.refresh();
    } catch {
      setError("Sem conexão. Verifique sua internet.");
    } finally {
      setLoading(false);
    }
  }

  const tabClass = (t: Tab) =>
    "min-h-11 flex-1 rounded-lg text-base font-medium transition-colors " +
    (tab === t
      ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100"
      : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200");

  return (
    <div className="flex flex-col gap-5">
      <div role="tablist" className="flex gap-1 rounded-xl bg-zinc-100 p-1 dark:bg-zinc-900">
        <button role="tab" aria-selected={tab === "signin"} className={tabClass("signin")} onClick={() => switchTab("signin")} type="button">
          Entrar
        </button>
        <button role="tab" aria-selected={tab === "signup"} className={tabClass("signup")} onClick={() => switchTab("signup")} type="button">
          Criar conta
        </button>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {tab === "signup" ? (
          <Input
            id="display_name"
            label="Seu nome"
            placeholder="Como quer ser chamado"
            autoComplete="name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
          />
        ) : null}
        <Input
          id="email"
          label="Email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          placeholder="voce@exemplo.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <Input
          id="password"
          label="Senha"
          type="password"
          autoComplete={tab === "signin" ? "current-password" : "new-password"}
          placeholder={tab === "signup" ? "Mínimo 6 caracteres" : "Sua senha"}
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        {error ? <Alert kind="error">{error}</Alert> : null}
        {info ? <Alert kind="success">{info}</Alert> : null}

        <Button type="submit" full disabled={loading}>
          {loading ? "Aguarde..." : tab === "signin" ? "Entrar" : "Criar conta"}
        </Button>
      </form>
    </div>
  );
}
