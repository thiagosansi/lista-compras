"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { TabBar, TAB_BAR_PADDING_CLASS } from "@/components/nav/tab-bar";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { QrScanner } from "./qr-scanner";

export type RecentReceipt = {
  id: string;
  storeName: string;
  issuedAt: string | null;
  createdAt: string;
  total: number | null;
  itemCount: number | null;
};

type ImportedReceipt = {
  id: string;
  store: { name: string; cnpj: string | null };
  issuedAt: string | null;
  total: number | null;
  items: { description: string; gtin: string | null; quantity: number; unit: string | null; unitPrice: number; total: number }[];
};

type ImportResponse = { ok: true; receipt: ImportedReceipt } | { ok: false; error: string };

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dateFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

function formatMoney(value: number | null): string {
  return value === null ? "—" : brl.format(value);
}

function formatDate(iso: string | null, withTime = false): string {
  if (!iso) return "sem data";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "sem data";
  return withTime ? dateTimeFmt.format(d) : dateFmt.format(d);
}

function formatQuantity(quantity: number, unit: string | null): string {
  const q = Number.isInteger(quantity) ? String(quantity) : quantity.toLocaleString("pt-BR", { maximumFractionDigits: 3 });
  return unit ? `${q} ${unit}` : q;
}

export function CupomView({ recent }: { recent: RecentReceipt[] }) {
  const router = useRouter();
  const [manual, setManual] = useState("");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportedReceipt | null>(null);

  async function importReceipt(text: string) {
    const url = text.trim();
    if (!url) {
      setError("Cole o link do QR code do cupom.");
      return;
    }
    setImporting(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/nfce/importar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      let data: ImportResponse | null = null;
      try {
        data = (await res.json()) as ImportResponse;
      } catch {
        data = null;
      }
      if (!data) {
        setError(res.status === 401 ? "Sua sessão expirou. Entre de novo." : "Resposta inesperada do servidor.");
        return;
      }
      if (!data.ok) {
        setError(data.error || "Não foi possível importar o cupom.");
        return;
      }
      setResult(data.receipt);
      setManual("");
      router.refresh();
    } catch {
      setError("Sem conexão. Tente de novo.");
    } finally {
      setImporting(false);
    }
  }

  return (
    <>
      <AppHeader title="Cupom fiscal" subtitle="Escaneie a NFC-e para registrar os preços" />

      <main className={`mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-3 pt-3 ${TAB_BAR_PADDING_CLASS}`}>
        <Card className="flex flex-col gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Importar cupom</p>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Aponte a câmera para o QR code impresso no cupom (NFC-e da Bahia).
            </p>
          </div>

          <QrScanner onDetect={(text) => void importReceipt(text)} disabled={importing} />

          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void importReceipt(manual);
            }}
          >
            <Input
              id="cupom-link"
              label="Ou cole o link do QR code"
              placeholder="http://nfe.sefaz.ba.gov.br/servicos/nfce/qrcode.aspx?p=..."
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              inputMode="url"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={importing}
            />
            <Button type="submit" variant="secondary" full disabled={importing || !manual.trim()}>
              {importing ? "Importando..." : "Importar"}
            </Button>
          </form>

          {importing ? <Alert kind="info">Consultando a Sefaz-BA... isso pode levar alguns segundos.</Alert> : null}
          {error ? <Alert kind="error">{error}</Alert> : null}
        </Card>

        {result ? (
          <Card className="flex flex-col gap-3">
            <Alert kind="success">Cupom importado! {result.items.length} {result.items.length === 1 ? "item" : "itens"} registrados.</Alert>
            <div>
              <p className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{result.store.name}</p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {formatDate(result.issuedAt, true)}
                {result.store.cnpj ? ` · CNPJ ${result.store.cnpj}` : ""}
              </p>
            </div>
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {result.items.map((item, i) => (
                <li key={i} className="flex items-start justify-between gap-3 py-2">
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-zinc-900 dark:text-zinc-100">{item.description}</span>
                    <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                      {formatQuantity(item.quantity, item.unit)} × {formatMoney(item.unitPrice)}
                      {item.gtin ? ` · GTIN ${item.gtin}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm font-medium text-zinc-900 dark:text-zinc-100">{formatMoney(item.total)}</span>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between border-t border-zinc-200 pt-2 dark:border-zinc-800">
              <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Total</span>
              <span className="text-lg font-bold text-zinc-900 dark:text-zinc-100">{formatMoney(result.total)}</span>
            </div>
          </Card>
        ) : null}

        <Card>
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Últimos cupons</p>
          {recent.length === 0 ? (
            <p className="mt-2 rounded-xl bg-zinc-50 px-3 py-2 text-sm text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
              Nenhum cupom importado ainda. Escaneie o primeiro para começar o histórico de preços.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-zinc-100 dark:divide-zinc-800">
              {recent.map((r) => (
                <li key={r.id} className="flex min-h-12 items-center justify-between gap-3 py-2">
                  <span className="min-w-0">
                    <span className="block truncate text-base text-zinc-900 dark:text-zinc-100">{r.storeName}</span>
                    <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                      {formatDate(r.issuedAt ?? r.createdAt)}
                      {r.itemCount !== null ? ` · ${r.itemCount} ${r.itemCount === 1 ? "item" : "itens"}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm font-medium text-zinc-900 dark:text-zinc-100">{formatMoney(r.total)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </main>
      <TabBar />
    </>
  );
}
