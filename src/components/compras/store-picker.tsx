"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { nearestN } from "@/lib/geo";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type RecentStore = {
  id: string;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
};

export type StoreChoice = { storeId: string | null; storeName: string };

const SEARCH_MIN_CHARS = 2;
const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_LIMIT = 10;
const NEAREST_LIMIT = 10;

function geoErrorMessage(err: GeolocationPositionError): string {
  if (err.code === err.PERMISSION_DENIED) return "Permissão de localização negada. Escolha a loja manualmente.";
  if (err.code === err.TIMEOUT) return "Não foi possível obter sua localização a tempo. Tente de novo.";
  return "Não foi possível obter sua localização.";
}

/** Formata distância em km no padrão pt-BR com uma casa decimal (ex.: "1,2 km"). */
function formatKm(km: number): string {
  return `${km.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`;
}

/** Linha de loja reutilizada nos resultados de busca por nome e na lista de mais próximas. */
function StoreResultRow({
  store,
  km,
  onClick,
  disabled,
}: {
  store: RecentStore;
  km?: number;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <li className="border-b border-zinc-100 last:border-b-0 dark:border-zinc-800">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="flex min-h-11 w-full items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-zinc-50 disabled:opacity-50 dark:hover:bg-zinc-800"
      >
        <span className="flex min-w-0 flex-col items-start">
          <span className="truncate text-sm text-zinc-900 dark:text-zinc-100">{store.name}</span>
          {store.address ? <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">{store.address}</span> : null}
        </span>
        {km != null ? <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">{formatKm(km)}</span> : null}
      </button>
    </li>
  );
}

type StorePickerProps = {
  recentStores: RecentStore[];
  disabled?: boolean;
  /** Disparado a cada mudança de seleção (loja recente, resultado da busca, mais próxima ou texto livre). */
  onChange: (choice: StoreChoice | null) => void;
};

/**
 * Seletor de loja reutilizável (tela inicial e "Trocar loja" na sessão aberta):
 * lojas recentes, busca por nome em `stores` (debounce, min. 2 caracteres, até 10
 * resultados), "Lojas mais próximas" (geolocalização, lista das 10 mais próximas com
 * distância) e texto livre — reaproveitado por nome exato ou criado sem CNPJ quando a
 * loja é confirmada pelo chamador.
 */
export function StorePicker({ recentStores, disabled, onChange }: StorePickerProps) {
  const inputId = useId();
  const [selected, setSelected] = useState<RecentStore | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RecentStore[]>([]);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [geoMessage, setGeoMessage] = useState<string | null>(null);
  const [nearestOptions, setNearestOptions] = useState<{ store: RecentStore; km: number }[]>([]);
  const [nearestInfo, setNearestInfo] = useState<{ store: RecentStore; km: number } | null>(null);
  const searchSeq = useRef(0);
  const debounceRef = useRef<number | null>(null);

  // Cancela o debounce pendente ao desmontar (sem setState no corpo do effect).
  useEffect(() => {
    return () => {
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    };
  }, []);

  function runSearch(trimmed: string) {
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    if (trimmed.length < SEARCH_MIN_CHARS) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const seq = ++searchSeq.current;
    debounceRef.current = window.setTimeout(() => {
      const supabase = createClient();
      supabase
        .from("stores")
        .select("id, name, address, lat, lng")
        .ilike("name", `%${trimmed}%`)
        .limit(SEARCH_LIMIT)
        .then(({ data }) => {
          if (searchSeq.current !== seq) return;
          setResults(data ?? []);
          setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
  }

  function selectStore(store: RecentStore | null) {
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    setSelected(store);
    setQuery(store?.name ?? "");
    setResults([]);
    setSearching(false);
    setNearestOptions([]);
    setNearestInfo(null);
    onChange(store ? { storeId: store.id, storeName: store.name } : null);
  }

  function pickRecent(store: RecentStore) {
    selectStore(selected?.id === store.id ? null : store);
  }

  function pickNearest(store: RecentStore, km: number) {
    selectStore(store);
    setNearestInfo({ store, km });
  }

  function handleQueryChange(value: string) {
    setQuery(value);
    if (selected) setSelected(null);
    const trimmed = value.trim();
    onChange(trimmed ? { storeId: null, storeName: trimmed } : null);
    runSearch(trimmed);
  }

  function locate() {
    setGeoMessage(null);
    setNearestOptions([]);
    setNearestInfo(null);
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGeoMessage("Seu navegador não suporta geolocalização.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const origin = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        const supabase = createClient();
        const { data, error: qErr } = await supabase
          .from("stores")
          .select("id, name, address, lat, lng")
          .not("lat", "is", null)
          .not("lng", "is", null)
          .limit(1000);
        setLocating(false);
        if (qErr) {
          setGeoMessage("Não foi possível carregar as lojas.");
          return;
        }
        const byId = new Map<string, RecentStore>();
        for (const s of [...recentStores, ...(data ?? [])]) {
          if (!byId.has(s.id)) byId.set(s.id, s);
        }
        const closest = nearestN(origin, [...byId.values()], NEAREST_LIMIT);
        if (closest.length === 0) {
          setGeoMessage("Nenhuma loja com localização conhecida ainda. Escolha manualmente.");
          return;
        }
        setNearestOptions(closest.map(({ item, distanceKm }) => ({ store: item, km: distanceKm })));
      },
      (err) => {
        setLocating(false);
        setGeoMessage(geoErrorMessage(err));
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {recentStores.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Lojas recentes</p>
          <ul className="flex flex-wrap gap-2">
            {recentStores.map((s) => {
              const active = selected?.id === s.id;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => pickRecent(s)}
                    disabled={disabled}
                    aria-pressed={active}
                    className={
                      "min-h-11 max-w-[16rem] truncate rounded-full border px-4 text-sm font-medium transition-colors disabled:opacity-50 " +
                      (active
                        ? "border-emerald-600 bg-emerald-600 text-white"
                        : "border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800")
                    }
                  >
                    {s.name}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <Input
          id={inputId}
          label="Buscar ou digitar o nome da loja"
          placeholder="Ex.: Mercadinho da esquina"
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          autoComplete="off"
          disabled={disabled}
        />
        {searching ? <p className="px-1 text-xs text-zinc-500 dark:text-zinc-400">Buscando...</p> : null}
        {!selected && results.length > 0 ? (
          <ul className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            {results.map((s) => (
              <StoreResultRow key={s.id} store={s} onClick={() => selectStore(s)} disabled={disabled} />
            ))}
          </ul>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <Button variant="secondary" full onClick={locate} disabled={locating || disabled}>
          <PinIcon />
          {locating ? "Localizando..." : "Lojas mais próximas"}
        </Button>
        {!selected && nearestOptions.length > 0 ? (
          <ul className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            {nearestOptions.map(({ store, km }) => (
              <StoreResultRow key={store.id} store={store} km={km} onClick={() => pickNearest(store, km)} disabled={disabled} />
            ))}
          </ul>
        ) : null}
        {nearestInfo && selected?.id === nearestInfo.store.id ? (
          <p className="text-center text-xs text-zinc-500 dark:text-zinc-400">
            {nearestInfo.store.name} · {formatKm(nearestInfo.km)}
          </p>
        ) : null}
        {geoMessage ? <Alert kind="info">{geoMessage}</Alert> : null}
      </div>
    </div>
  );
}

function PinIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21Z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </svg>
  );
}
