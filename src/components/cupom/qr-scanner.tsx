"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/** API nativa (Chrome/Android, Safari 17+ parcial). Não está nos tipos do TS. */
type NativeBarcodeDetector = {
  detect(source: HTMLVideoElement | ImageBitmap | HTMLCanvasElement): Promise<{ rawValue: string }[]>;
};
type NativeBarcodeDetectorCtor = new (options?: { formats?: string[] }) => NativeBarcodeDetector;

const SCAN_INTERVAL_MS = 250;

function getNativeDetector(): NativeBarcodeDetector | null {
  if (typeof window === "undefined" || !("BarcodeDetector" in window)) return null;
  try {
    const Ctor = (window as unknown as { BarcodeDetector: NativeBarcodeDetectorCtor }).BarcodeDetector;
    return new Ctor({ formats: ["qr_code"] });
  } catch {
    return null;
  }
}

function cameraErrorMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Permissão de câmera negada. Libere o acesso à câmera nas configurações do navegador ou cole o link abaixo.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "Nenhuma câmera encontrada. Cole o link do cupom abaixo.";
  }
  if (name === "NotReadableError") {
    return "A câmera está em uso por outro aplicativo.";
  }
  return "Não foi possível abrir a câmera. Cole o link do cupom abaixo.";
}

type QrScannerProps = {
  /** Chamado uma vez ao detectar um QR code; a câmera é desligada antes. */
  onDetect: (text: string) => void;
  disabled?: boolean;
};

export function QrScanner({ onDetect, disabled }: QrScannerProps) {
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const onDetectRef = useRef(onDetect);
  useEffect(() => {
    onDetectRef.current = onDetect;
  }, [onDetect]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: number | undefined;
    const video = videoRef.current;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("Este navegador não permite usar a câmera. Cole o link do cupom abaixo.");
        setActive(false);
        return;
      }
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
      } catch (err) {
        if (cancelled) return;
        setError(cameraErrorMessage(err));
        setActive(false);
        return;
      }
      if (cancelled || !video) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        // autoplay bloqueado: o atributo autoPlay/playsInline resolve na maioria dos casos.
      }

      const native = getNativeDetector();
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      let jsQR: typeof import("jsqr").default | null = null;
      if (!native) {
        try {
          jsQR = (await import("jsqr")).default;
        } catch {
          if (!cancelled) setError("Não foi possível carregar o leitor de QR code. Cole o link do cupom abaixo.");
          return;
        }
      }

      let busy = false;
      const tick = async () => {
        if (cancelled || busy || !video || video.readyState < 2) return;
        busy = true;
        try {
          let text: string | null = null;
          if (native) {
            const codes = await native.detect(video);
            text = codes.find((c) => c.rawValue)?.rawValue ?? null;
          } else if (jsQR && ctx) {
            const w = video.videoWidth;
            const h = video.videoHeight;
            if (w && h) {
              // Reduz a imagem para acelerar o jsQR em celulares.
              const scale = Math.min(1, 640 / Math.max(w, h));
              canvas.width = Math.round(w * scale);
              canvas.height = Math.round(h * scale);
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
              text = code?.data || null;
            }
          }
          if (text && !cancelled) {
            cancelled = true;
            setActive(false);
            onDetectRef.current(text);
          }
        } catch {
          // Frame ruim: tenta de novo no próximo tick.
        } finally {
          busy = false;
        }
      };
      timer = window.setInterval(() => void tick(), SCAN_INTERVAL_MS);
    }

    void start();

    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (video) video.srcObject = null;
    };
  }, [active]);

  if (!active) {
    return (
      <div className="flex flex-col gap-2">
        <Button
          full
          onClick={() => {
            setError(null);
            setActive(true);
          }}
          disabled={disabled}
        >
          <CameraIcon />
          Escanear QR code
        </Button>
        {error ? (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="relative aspect-square w-full overflow-hidden rounded-2xl bg-black">
        <video ref={videoRef} className="h-full w-full object-cover" autoPlay muted playsInline aria-label="Câmera" />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 m-auto h-[60%] w-[60%] rounded-2xl border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]"
        />
        <p className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-sm font-medium text-white drop-shadow">
          Aponte para o QR code do cupom
        </p>
      </div>
      <Button variant="secondary" full onClick={() => setActive(false)}>
        Cancelar
      </Button>
    </div>
  );
}

function CameraIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}
