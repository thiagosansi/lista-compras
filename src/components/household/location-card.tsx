"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type LocationCardProps = {
  householdId: string;
  lat: number | null;
  lng: number | null;
  address: string | null;
};

function geoErrorMessage(err: GeolocationPositionError): string {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return "Permissão de localização negada. Libere o acesso nas configurações do navegador e tente de novo.";
    case err.POSITION_UNAVAILABLE:
      return "Não foi possível obter a localização agora. Tente de novo em instantes.";
    case err.TIMEOUT:
      return "Tempo esgotado ao buscar a localização. Tente de novo.";
    default:
      return "Erro ao obter a localização.";
  }
}

/** Card "Localização da casa": GPS + endereço opcional, salvos em `households`. */
export function LocationCard({ householdId, lat: initialLat, lng: initialLng, address: initialAddress }: LocationCardProps) {
  const router = useRouter();
  const [lat, setLat] = useState<number | null>(initialLat);
  const [lng, setLng] = useState<number | null>(initialLng);
  const [address, setAddress] = useState(initialAddress ?? "");
  const [locating, setLocating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const dirty =
    lat !== initialLat || lng !== initialLng || address.trim() !== (initialAddress ?? "").trim();
  const hasCoords = lat != null && lng != null;

  function handleLocate() {
    setError(null);
    setSaved(false);
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError("Seu navegador não suporta geolocalização. Preencha o endereço abaixo.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(pos.coords.latitude);
        setLng(pos.coords.longitude);
        setLocating(false);
      },
      (err) => {
        setError(geoErrorMessage(err));
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);
    const supabase = createClient();
    const trimmed = address.trim();
    const { error } = await supabase
      .from("households")
      .update({ lat, lng, address: trimmed ? trimmed : null })
      .eq("id", householdId);
    setSaving(false);
    if (error) {
      setError("Não foi possível salvar a localização. Tente de novo.");
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <Card className="flex flex-col gap-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Localização da casa</p>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Usada para buscar preços em lojas perto de você. Sem ela, a busca usa o centro de Salvador.
        </p>
      </div>

      <div className="rounded-xl bg-zinc-100 px-3 py-2.5 text-sm dark:bg-zinc-800">
        {hasCoords ? (
          <>
            <p className="font-mono tabular-nums text-zinc-900 dark:text-zinc-100">
              {lat.toFixed(4)}, {lng.toFixed(4)}
            </p>
            {initialAddress ? <p className="mt-0.5 text-zinc-600 dark:text-zinc-300">{initialAddress}</p> : null}
            {dirty ? <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-400">Alterações não salvas</p> : null}
          </>
        ) : (
          <p className="text-zinc-500 dark:text-zinc-400">Localização não definida</p>
        )}
      </div>

      <Button variant="secondary" full onClick={handleLocate} disabled={locating || saving}>
        {locating ? "Buscando localização..." : "Usar minha localização"}
      </Button>

      <Input
        id="household-address"
        label="Endereço (opcional)"
        value={address}
        onChange={(e) => {
          setAddress(e.target.value);
          setSaved(false);
        }}
        placeholder="Rua, número, bairro"
        autoComplete="street-address"
        maxLength={200}
      />

      {error ? <Alert kind="error">{error}</Alert> : null}
      {saved && !dirty ? <Alert kind="success">Localização salva.</Alert> : null}

      <Button full onClick={handleSave} disabled={!dirty || saving || locating}>
        {saving ? "Salvando..." : "Salvar localização"}
      </Button>
    </Card>
  );
}
