"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/** API nativa (Chrome/Android; Safari iOS 17+ parcial). Não está nos tipos do TS. */
type NativeBarcodeDetector = {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
};
type NativeBarcodeDetectorCtor = new (options?: { formats?: string[] }) => NativeBarcodeDetector;

const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e"];
const SCAN_INTERVAL_MS = 200;
const GTIN_RE = /^\d{8,14}$/;

function getNativeDetector(): NativeBarcodeDetector | null {
  if (typeof window === "undefined" || !("BarcodeDetector" in window)) return null;
  try {
    const Ctor = (window as unknown as { BarcodeDetector: NativeBarcodeDetectorCtor }).BarcodeDetector;
    return new Ctor({ formats: FORMATS });
  } catch {
    return null;
  }
}

function cameraErrorMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return "Este navegador não permite usar a câmera. Use \"Sem código\".";
  }
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Permissão de câmera negada. Libere o acesso nas configurações do navegador ou use \"Sem código\".";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "Nenhuma câmera encontrada. Use \"Sem código\".";
  }
  if (name === "NotReadableError") {
    return "A câmera está em uso por outro aplicativo.";
  }
  return "Não foi possível abrir a câmera. Use \"Sem código\".";
}

/** Normaliza o valor lido: só dígitos; UPC-A (12) e EAN-8 ficam como estão (a API aceita 8–14). */
function normalizeGtin(raw: string): string | null {
  const digits = raw.replace(/\D+/g, "");
  return GTIN_RE.test(digits) ? digits : null;
}

type BarcodeScannerProps = {
  /** Chamado uma vez ao ler um código válido; a câmera é desligada antes. */
  onDetect: (gtin: string) => void;
  onCancel: () => void;
};

/**
 * Lê códigos de barras EAN/UPC pela câmera traseira. Usa `BarcodeDetector` nativo
 * quando existe; caso contrário carrega `@zxing/browser` sob demanda.
 * Liga a câmera assim que monta (o usuário já tocou em "Escanear código").
 */
export function BarcodeScanner({ onDetect, onCancel }: BarcodeScannerProps) {
  const [error, setError] = useState<string | null>(null);
  // Só monta no cliente (dentro da folha, após toque), então o initializer roda no navegador.
  const [detector] = useState<NativeBarcodeDetector | null>(() => getNativeDetector());
  const engine = detector ? "native" : "zxing";
  const videoRef = useRef<HTMLVideoElement>(null);
  const onDetectRef = useRef(onDetect);
  useEffect(() => {
    onDetectRef.current = onDetect;
  }, [onDetect]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    let timer: number | undefined;
    let stream: MediaStream | null = null;
    let stopZxing: (() => void) | null = null;

    const constraints: MediaStreamConstraints = {
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
    };

    const finish = (raw: string) => {
      const gtin = normalizeGtin(raw);
      if (!gtin || cancelled) return;
      cancelled = true;
      if (timer) window.clearInterval(timer);
      stopZxing?.();
      stream?.getTracks().forEach((t) => t.stop());
      onDetectRef.current(gtin);
    };

    async function startNative(detector: NativeBarcodeDetector) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        if (!cancelled) setError(cameraErrorMessage(err));
        return;
      }
      if (cancelled || !video) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        // autoPlay/playsInline resolvem na maioria dos casos.
      }
      let busy = false;
      timer = window.setInterval(async () => {
        if (cancelled || busy || !video || video.readyState < 2) return;
        busy = true;
        try {
          const codes = await detector.detect(video);
          const hit = codes.map((c) => c.rawValue).find((v) => normalizeGtin(v));
          if (hit) finish(hit);
        } catch {
          // Frame ruim: tenta no próximo tick.
        } finally {
          busy = false;
        }
      }, SCAN_INTERVAL_MS);
    }

    async function startZxing() {
      let Reader: typeof import("@zxing/browser").BrowserMultiFormatReader;
      try {
        Reader = (await import("@zxing/browser")).BrowserMultiFormatReader;
      } catch {
        if (!cancelled) setError("Não foi possível carregar o leitor de código de barras. Use \"Sem código\".");
        return;
      }
      if (cancelled || !video) return;
      const reader = new Reader(undefined, { delayBetweenScanAttempts: SCAN_INTERVAL_MS, delayBetweenScanSuccess: 1000 });
      try {
        const controls = await reader.decodeFromConstraints(constraints, video, (result) => {
          if (result) finish(result.getText());
        });
        stopZxing = () => controls.stop();
        if (cancelled) controls.stop();
      } catch (err) {
        if (!cancelled) setError(cameraErrorMessage(err));
      }
    }

    // Sem getUserMedia, ambos os caminhos caem no catch e mostram a mensagem de navegador sem suporte.
    if (detector) void startNative(detector);
    else void startZxing();

    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
      stopZxing?.();
      stream?.getTracks().forEach((t) => t.stop());
      if (video) video.srcObject = null;
    };
  }, [detector]);

  return (
    <div className="flex flex-col gap-3">
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-2xl bg-black">
        <video ref={videoRef} className="h-full w-full object-cover" autoPlay muted playsInline aria-label="Câmera" />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-[10%] top-1/2 h-[38%] -translate-y-1/2 rounded-xl border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]"
        />
        <div aria-hidden className="pointer-events-none absolute inset-x-[14%] top-1/2 h-0.5 -translate-y-1/2 bg-red-500/80" />
        <p className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-sm font-medium text-white drop-shadow">
          Aponte para o código de barras
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : (
        <p className="text-center text-xs text-zinc-500 dark:text-zinc-400">
          {engine === "zxing" ? "Leitor alternativo carregado." : "Mantenha o código dentro da moldura."}
        </p>
      )}
      <Button variant="secondary" full onClick={onCancel}>
        Cancelar
      </Button>
    </div>
  );
}
