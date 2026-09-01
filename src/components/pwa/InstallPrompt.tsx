"use client";

import { useEffect, useState } from "react";

// Evento não tipado no lib.dom (só Chromium).
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

const DISMISSED_KEY = "pwa-install-dismissed";

type Mode = "hidden" | "android" | "ios";

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
}

function isIOS(): boolean {
  if (typeof window === "undefined") return false;
  const ua = window.navigator.userAgent;
  const iPadOS = window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1;
  return /iPhone|iPad|iPod/i.test(ua) || iPadOS;
}

function wasDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function markDismissed() {
  try {
    window.localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // localStorage indisponível (modo privado etc.): só esconde nesta sessão.
  }
}

/**
 * Banner discreto para instalar o app.
 * - Android/Chrome: captura `beforeinstallprompt` e mostra o botão "Instalar app".
 * - iOS (Safari): mostra a dica "Compartilhar → Adicionar à Tela de Início".
 * Some quando o app já está instalado ou quando a pessoa dispensa (localStorage).
 */
export function InstallPrompt() {
  const [mode, setMode] = useState<Mode>("hidden");
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (isStandalone() || wasDismissed()) return;

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setMode("android");
    };
    const onInstalled = () => {
      markDismissed();
      setDeferred(null);
      setMode("hidden");
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);

    // No iOS não existe `beforeinstallprompt`; mostra a dica depois de um instante
    // para não competir com o primeiro carregamento.
    const iosTimer = isIOS() ? window.setTimeout(() => setMode("ios"), 1500) : undefined;

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
      if (iosTimer !== undefined) window.clearTimeout(iosTimer);
    };
  }, []);

  if (mode === "hidden") return null;

  const dismiss = () => {
    markDismissed();
    setMode("hidden");
  };

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    setDeferred(null);
    if (outcome === "accepted") {
      setMode("hidden");
    } else {
      dismiss();
    }
  };

  return (
    <div
      role="region"
      aria-label="Instalar aplicativo"
      className="flex items-center gap-3 bg-green-600 px-4 py-2.5 text-sm text-white pt-[calc(env(safe-area-inset-top)+0.625rem)]"
    >
      <span className="min-w-0 flex-1 leading-snug">
        {mode === "android" ? (
          <>
            <span className="font-semibold">Instale o app</span> para abrir a lista direto da tela inicial.
          </>
        ) : (
          <>
            <span className="font-semibold">Adicione à Tela de Início:</span> toque em{" "}
            <span aria-label="Compartilhar" className="inline-block align-middle">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3v13" />
                <path d="m7 8 5-5 5 5" />
                <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
              </svg>
            </span>{" "}
            Compartilhar e depois em <span className="font-semibold">Adicionar à Tela de Início</span>.
          </>
        )}
      </span>
      {mode === "android" && (
        <button
          type="button"
          onClick={install}
          className="shrink-0 rounded-lg bg-white px-3 py-1.5 font-semibold text-green-700 active:bg-green-50"
        >
          Instalar app
        </button>
      )}
      <button
        type="button"
        onClick={dismiss}
        aria-label="Fechar"
        className="shrink-0 rounded-lg p-1.5 text-white/80 hover:bg-white/10 active:bg-white/20"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

export default InstallPrompt;
