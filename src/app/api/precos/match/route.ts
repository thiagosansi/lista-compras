// POST /api/precos/match — correção manual de correspondência ("Não é esse produto" / "É esse sim").
// Grava um veredicto `source='user'` em item_matches para o household do usuário; ele prevalece sobre o juiz.

import { createClient } from "@/lib/supabase/server";
import { normalizeName, onlyDigits } from "@/lib/normalize";

export const runtime = "nodejs";

type Body = { itemName?: unknown; description?: unknown; gtin?: unknown; isMatch?: unknown };

function fail(error: string, status: number) {
  return Response.json({ ok: false, error }, { status });
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

  const itemName = typeof body.itemName === "string" ? body.itemName.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!itemName || !description) return fail("`itemName` e `description` são obrigatórios", 400);
  if (typeof body.isMatch !== "boolean") return fail("`isMatch` deve ser booleano", 400);
  if (body.gtin !== undefined && body.gtin !== null && typeof body.gtin !== "string") {
    return fail("`gtin` deve ser string ou null", 400);
  }

  const itemKey = normalizeName(itemName);
  const descriptionKey = normalizeName(description);
  if (!itemKey || !descriptionKey) return fail("Nome do item ou descrição sem conteúdo útil", 400);

  const gtinDigits = typeof body.gtin === "string" ? onlyDigits(body.gtin) : "";
  const gtin = gtinDigits.length >= 8 && gtinDigits.length <= 14 ? gtinDigits : null;

  const { data: membership, error: memberError } = await supabase
    .from("household_members")
    .select("household_id")
    .eq("user_id", user.id)
    .order("joined_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (memberError) return fail(`Erro ao carregar a casa: ${memberError.message}`, 500);
  if (!membership) return fail("Você ainda não faz parte de uma casa", 403);

  const { error } = await supabase.from("item_matches").upsert(
    {
      household_id: membership.household_id,
      item_key: itemKey,
      description_key: descriptionKey,
      gtin,
      is_match: body.isMatch,
      source: "user",
      reason: "Marcado pelo usuário",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "household_id,item_key,description_key" },
  );
  if (error) return fail(`Erro ao salvar a correspondência: ${error.message}`, 500);

  return Response.json({ ok: true });
}
