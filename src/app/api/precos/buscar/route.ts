import { createClient } from "@/lib/supabase/server";
import { PdhError, searchPrecoDaHora } from "@/lib/precodahora/client";

export const runtime = "nodejs";
export const maxDuration = 60;

type Body = {
  termo?: unknown;
  gtin?: unknown;
  lat?: unknown;
  lng?: unknown;
  raioKm?: unknown;
  horas?: unknown;
};

function fail(error: string, status: number) {
  return Response.json({ ok: false, error }, { status });
}

function optionalNumber(v: unknown, fallback: number): number | null {
  if (v === undefined || v === null || v === "") return fallback;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Não autenticado", 401);

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return fail("Body inválido (JSON esperado)", 400);
  }

  const termo = typeof body.termo === "string" ? body.termo.trim() : "";
  const gtin = typeof body.gtin === "string" ? body.gtin.replace(/\D+/g, "") : "";
  if (!termo && !gtin) return fail("Informe `termo` ou `gtin`", 400);

  const lat = typeof body.lat === "number" ? body.lat : Number(body.lat);
  const lng = typeof body.lng === "number" ? body.lng : Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return fail("`lat` e `lng` são obrigatórios e devem ser números válidos", 400);
  }

  const raioKm = optionalNumber(body.raioKm, 10);
  const horas = optionalNumber(body.horas, 72);
  if (raioKm === null || raioKm <= 0 || horas === null || horas <= 0) {
    return fail("`raioKm` e `horas` devem ser números positivos", 400);
  }

  try {
    const resultados = await searchPrecoDaHora({
      termo: termo || undefined,
      gtin: gtin || undefined,
      lat,
      lng,
      raioKm,
      horas,
    });
    return Response.json({ ok: true, resultados });
  } catch (err) {
    if (err instanceof PdhError) {
      return fail(err.message, err.kind === "bad_request" ? 400 : 502);
    }
    console.error("[api/precos/buscar]", err);
    return fail("Erro inesperado ao consultar o Preço da Hora", 502);
  }
}
