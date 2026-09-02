"use client";

import { useEffect, useId, useState } from "react";
import type { ListItem, ProductLookup, ShoppingSessionItem } from "@/lib/database.types";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BottomSheet } from "./bottom-sheet";
import { BarcodeScanner } from "./barcode-scanner";
import { formatDate, formatMoney, parseDecimal, toDecimalInput } from "./format";

export type PickResult = {
  description: string;
  gtin: string | null;
  categoria: string | null;
  unitPrice: number;
  quantity: number;
  scanned: boolean;
  /** Renomear o item da lista (texto livre) com a descrição do produto. */
  useProductName: boolean;
};

type LookupResponse = ({ ok: true } & ProductLookup) | { ok: false; error: string };

type PriceFormProps = {
  title: string;
  initialPrice: number | null;
  initialQuantity: number;
  suggestion?: ProductLookup["precoSugerido"];
  extra?: React.ReactNode;
  confirmLabel?: string;
  busy: boolean;
  onSubmit: (unitPrice: number, quantity: number) => void;
};

/** Preço unitário + quantidade, com teclado decimal e vírgula. */
function PriceForm({ title, initialPrice, initialQuantity, suggestion, extra, confirmLabel = "Confirmar", busy, onSubmit }: PriceFormProps) {
  const uid = useId();
  const [price, setPrice] = useState(toDecimalInput(initialPrice));
  const [quantity, setQuantity] = useState(toDecimalInput(initialQuantity, 3));
  const [error, setError] = useState<string | null>(null);

  const parsedPrice = parseDecimal(price);
  const parsedQty = parseDecimal(quantity);
  const lineTotal = parsedPrice != null && parsedQty != null ? parsedPrice * parsedQty : null;

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (parsedPrice == null || parsedPrice < 0) {
          setError("Informe o preço (ex.: 12,90).");
          return;
        }
        if (parsedQty == null || parsedQty <= 0) {
          setError("A quantidade precisa ser maior que zero.");
          return;
        }
        setError(null);
        onSubmit(parsedPrice, parsedQty);
      }}
    >
      <p className="text-base font-medium text-zinc-900 dark:text-zinc-100">{title}</p>
      {suggestion ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Preço sugerido: {formatMoney(suggestion.preco)} em {suggestion.loja} ({formatDate(suggestion.data)})
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <Input
          id={`${uid}-price`}
          label="Preço unitário (R$)"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0,00"
          enterKeyHint="next"
          autoFocus
          disabled={busy}
        />
        <Input
          id={`${uid}-qty`}
          label="Quantidade"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          inputMode="decimal"
          autoComplete="off"
          placeholder="1"
          enterKeyHint="done"
          disabled={busy}
        />
      </div>
      {extra}
      <div className="flex items-center justify-between rounded-xl bg-zinc-50 px-3 py-2 dark:bg-zinc-800">
        <span className="text-sm text-zinc-600 dark:text-zinc-300">Subtotal</span>
        <span className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{formatMoney(lineTotal)}</span>
      </div>
      {error ? <Alert kind="error">{error}</Alert> : null}
      <Button type="submit" full disabled={busy}>
        {busy ? "Salvando..." : confirmLabel}
      </Button>
    </form>
  );
}

type PickSheetProps = {
  item: ListItem;
  storeId: string | null;
  onClose: () => void;
  onConfirm: (result: PickResult) => Promise<void>;
};

type Step =
  | { kind: "choose" }
  | { kind: "scan" }
  | { kind: "lookup"; gtin: string }
  | { kind: "form"; gtin: string | null; scanned: boolean; lookup: ProductLookup | null; lookupError: string | null };

/** Folha ao tocar num item pendente: escanear código → preço/quantidade → confirmar. */
export function PickSheet({ item, storeId, onClose, onConfirm }: PickSheetProps) {
  const [step, setStep] = useState<Step>({ kind: "choose" });
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [useProductName, setUseProductName] = useState(true);
  const isFreeText = !item.gtin && !item.product_id;

  useEffect(() => {
    if (step.kind !== "lookup") return;
    let cancelled = false;
    const gtin = step.gtin;
    (async () => {
      let lookup: ProductLookup | null = null;
      let lookupError: string | null = null;
      try {
        const params = storeId ? `?storeId=${encodeURIComponent(storeId)}` : "";
        const res = await fetch(`/api/produtos/${gtin}${params}`);
        let data: LookupResponse | null = null;
        try {
          data = (await res.json()) as LookupResponse;
        } catch {
          data = null;
        }
        if (data?.ok) lookup = { produto: data.produto, precoSugerido: data.precoSugerido };
        else lookupError = data && !data.ok ? data.error : "Não foi possível consultar o produto.";
      } catch {
        lookupError = "Sem conexão. Informe o preço manualmente.";
      }
      if (!cancelled) setStep({ kind: "form", gtin, scanned: true, lookup, lookupError });
    })();
    return () => {
      cancelled = true;
    };
  }, [step, storeId]);

  async function submit(unitPrice: number, quantity: number) {
    if (step.kind !== "form") return;
    const produto = step.lookup?.produto ?? null;
    setBusy(true);
    setSaveError(null);
    try {
      await onConfirm({
        description: produto?.descricao ?? item.name,
        gtin: step.gtin,
        categoria: produto?.categoria ?? null,
        unitPrice,
        quantity,
        scanned: step.scanned,
        useProductName: Boolean(produto) && isFreeText && useProductName,
      });
    } catch {
      setSaveError("Não foi possível salvar. Tente de novo.");
      setBusy(false);
    }
  }

  let body: React.ReactNode;
  switch (step.kind) {
    case "choose":
      body = (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Escaneie o código de barras para registrar o produto e o preço, ou informe só o preço.
          </p>
          <Button full onClick={() => setStep({ kind: "scan" })}>
            <BarcodeIcon />
            Escanear código
          </Button>
          {item.gtin ? (
            <Button variant="secondary" full onClick={() => setStep({ kind: "lookup", gtin: item.gtin! })}>
              Usar o produto da lista
            </Button>
          ) : null}
          <Button variant="secondary" full onClick={() => setStep({ kind: "form", gtin: null, scanned: false, lookup: null, lookupError: null })}>
            Sem código
          </Button>
        </div>
      );
      break;
    case "scan":
      body = <BarcodeScanner onDetect={(gtin) => setStep({ kind: "lookup", gtin })} onCancel={() => setStep({ kind: "choose" })} />;
      break;
    case "lookup":
      body = (
        <div className="flex flex-col items-center gap-2 py-6" aria-busy>
          <span className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-600 border-t-transparent" aria-hidden />
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Consultando código {step.gtin}...</p>
        </div>
      );
      break;
    case "form": {
      const produto = step.lookup?.produto ?? null;
      const showRename = Boolean(produto) && isFreeText && produto!.descricao.trim() !== item.name.trim();
      body = (
        <div className="flex flex-col gap-3">
          {step.gtin ? (
            <div className="rounded-xl border border-zinc-200 px-3 py-2 dark:border-zinc-800">
              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{produto ? produto.descricao : "Produto não encontrado"}</p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Código {step.gtin}
                {produto?.categoria ? ` · ${produto.categoria}` : ""}
                {!produto ? " · será registrado com o nome da lista" : ""}
              </p>
            </div>
          ) : null}
          {step.lookupError ? <Alert kind="info">{step.lookupError}</Alert> : null}
          <PriceForm
            title={item.name}
            initialPrice={step.lookup?.precoSugerido?.preco ?? null}
            initialQuantity={item.quantity}
            suggestion={step.lookup?.precoSugerido ?? null}
            busy={busy}
            onSubmit={submit}
            extra={
              showRename ? (
                <label className="flex min-h-11 items-center gap-3 text-sm text-zinc-700 dark:text-zinc-300">
                  <input
                    type="checkbox"
                    className="h-5 w-5 rounded border-zinc-300 accent-emerald-600 dark:border-zinc-600"
                    checked={useProductName}
                    onChange={(e) => setUseProductName(e.target.checked)}
                  />
                  <span>
                    Usar o nome do produto na lista
                    <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                      &quot;{item.name}&quot; vira &quot;{produto!.descricao}&quot;
                    </span>
                  </span>
                </label>
              ) : null
            }
          />
          {saveError ? <Alert kind="error">{saveError}</Alert> : null}
          {!busy ? (
            <Button variant="ghost" full onClick={() => setStep({ kind: "choose" })}>
              Voltar
            </Button>
          ) : null}
        </div>
      );
      break;
    }
  }

  return (
    <BottomSheet title={item.name} onClose={onClose}>
      {body}
    </BottomSheet>
  );
}

type CartItemSheetProps = {
  item: ShoppingSessionItem;
  onClose: () => void;
  onSave: (unitPrice: number, quantity: number) => Promise<void>;
  onRemove: () => Promise<void>;
};

/** Folha para editar preço/quantidade de um item do carrinho ou removê-lo. */
export function CartItemSheet({ item, onClose, onSave, onRemove }: CartItemSheetProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch {
      setError("Não foi possível salvar. Tente de novo.");
      setBusy(false);
    }
  }

  return (
    <BottomSheet title="Item do carrinho" onClose={onClose}>
      <div className="flex flex-col gap-3">
        {item.gtin ? <p className="text-xs text-zinc-500 dark:text-zinc-400">Código {item.gtin}</p> : null}
        <PriceForm
          title={item.description}
          initialPrice={item.unit_price}
          initialQuantity={item.quantity}
          confirmLabel="Salvar"
          busy={busy}
          onSubmit={(p, q) => void run(() => onSave(p, q))}
        />
        {error ? <Alert kind="error">{error}</Alert> : null}
        {confirmRemove ? (
          <div className="flex gap-2">
            <Button variant="danger" full disabled={busy} onClick={() => void run(onRemove)}>
              Sim, remover
            </Button>
            <Button variant="secondary" full disabled={busy} onClick={() => setConfirmRemove(false)}>
              Cancelar
            </Button>
          </div>
        ) : (
          <Button variant="danger" full disabled={busy} onClick={() => setConfirmRemove(true)}>
            Remover do carrinho
          </Button>
        )}
      </div>
    </BottomSheet>
  );
}

function BarcodeIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M3 5v14M7 5v14M11 5v14M14 5v14M18 5v14M21 5v14" />
    </svg>
  );
}
