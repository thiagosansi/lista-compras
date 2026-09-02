"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { nearest } from "@/lib/geo";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export type RecentStore = {
  id: string;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
};

export type StoreChoice = { storeId: string | null; storeName: string };

type StartSessionProps = {
  recentStores: RecentStore[];
  starting: boolean;
  error: string | null;
  onStart: (choice: StoreChoice) => void;
};

function geoErrorMessage(err: GeolocationPositionError): string {
  if (err.code === err.PERMISSION_DENIED) return "Permissão de localização negada. Escolha a loja manualmente.";
  if (err.code === err.TIMEOUT) return "Não foi possível obter sua localização a tempo. Tente de novo.";
  return "Não foi possível obter sua localização.";
}

/** Tela "Começar compra": escolhe a loja (recentes, texto livre ou mais próxima) e abre a sessão. */
export function StartSession({ recentStores, starting, error, onStart }: StartSessionProps) {
  const [selected, setSelected] = useState<RecentStore | null>(null);
  const [freeText, setFreeText] = useState("");
  const [locating, setLocating] = useState(false);
  const [geoMessage, setGeoMessage] = useState<string | null>(null);
  const [nearestInfo, setNearestInfo] = useState<{ store: RecentStore; km: number } | null>(null);

  const choice: StoreChoice | null = selected
    ? { storeId: selected.id, storeName: selected.name }
    : freeText.trim()
      ? { storeId: null, storeName: freeText.trim() }
      : null;

  function pickRecent(store: RecentStore) {
    setSelected((prev) => (prev?.id === store.id ? null : store));
    setFreeText("");
  }

  function locate() {
    setGeoMessage(null);
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
        const best = nearest(origin, [...recentStores, ...(data ?? [])]);
        if (!best) {
          setGeoMessage("Nenhuma loja com localização conhecida ainda. Escolha manualmente.");
          return;
        }
        setNearestInfo({ store: best.item, km: best.distanceKm });
        setSelected(best.item);
        setFreeText("");
      },
      (err) => {
        setLocating(false);
        setGeoMessage(geoErrorMessage(err));
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  }

  return (
    <Card className="flex flex-col gap-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Começar compra</p>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Em que loja você está? O total da compra é calculado enquanto você pega os itens.</p>
      </div>

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
                    aria-pressed={active}
                    className={
                      "min-h-11 max-w-[16rem] truncate rounded-full border px-4 text-sm font-medium transition-colors " +
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

      <Input
        id="store-free-text"
        label="Ou digite o nome da loja"
        placeholder="Ex.: Mercadinho da esquina"
        value={freeText}
        onChange={(e) => {
          setFreeText(e.target.value);
          if (e.target.value.trim()) setSelected(null);
        }}
        autoComplete="off"
        disabled={starting}
      />

      <div className="flex flex-col gap-1">
        <Button variant="secondary" full onClick={locate} disabled={locating || starting}>
          <PinIcon />
          {locating ? "Localizando..." : "Loja mais próxima"}
        </Button>
        {nearestInfo && selected?.id === nearestInfo.store.id ? (
          <p className="text-center text-xs text-zinc-500 dark:text-zinc-400">
            {nearestInfo.store.name} · {nearestInfo.km < 1 ? `${Math.round(nearestInfo.km * 1000)} m` : `${nearestInfo.km.toFixed(1)} km`}
          </p>
        ) : null}
        {geoMessage ? <Alert kind="info">{geoMessage}</Alert> : null}
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}

      <Button full disabled={!choice || starting} onClick={() => choice && onStart(choice)}>
        {starting ? "Abrindo..." : choice ? `Começar em ${choice.storeName}` : "Escolha a loja"}
      </Button>
    </Card>
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
