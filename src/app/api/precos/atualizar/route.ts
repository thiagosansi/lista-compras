import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, PdhResult } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";
import { normalizeName } from "@/lib/normalize";
import { PdhError, searchPrecoDaHora } from "@/lib/precodahora/client";

export const runtime = "nodejs";
export const maxDuration = 60;

const SALVADOR_CENTRO = { lat: -12.9777, lng: -38.5016 };
const MAX_RESULTADOS_POR_ITEM = 8;
const CONCORRENCIA = 3;

type Db = SupabaseClient<Database>;
type ObservationInsert = Database["public"]["Tables"]["price_observations"]["Insert"];
type ItemRow = { id: string; name: string; gtin: string | null };

function fail(error: string, status: number) {
  return Response.json({ ok: false, error }, { status });
}

/** Executa `fn` sobre `items` com no máximo `limit` promessas em voo. Preserva a ordem dos resultados. */
async function runPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

function isUniqueViolation(err: { code?: string } | null): boolean {
  return err?.code === "23505";
}

/** Encontra ou cria a loja. Por CNPJ quando houver; senão por (nome, endereço), casando com o índice único parcial. */
async function resolveStoreId(db: Db, loja: PdhResult["loja"], cache: Map<string, Promise<string>>): Promise<string> {
  const key = loja.cnpj ? `cnpj:${loja.cnpj}` : `name:${loja.nome.toLowerCase()}|${loja.endereco ?? ""}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const task = (async () => {
    const insert = {
      cnpj: loja.cnpj,
      name: loja.nome,
      address: loja.endereco,
      city: loja.cidade,
      lat: loja.lat,
      lng: loja.lng,
    };

    const find = async (): Promise<string | null> => {
      let q = db.from("stores").select("id").limit(1);
      if (loja.cnpj) {
        q = q.eq("cnpj", loja.cnpj);
      } else {
        q = q.is("cnpj", null).ilike("name", escapeLike(loja.nome));
        q = loja.endereco ? q.eq("address", loja.endereco) : q.is("address", null);
      }
      const { data, error } = await q.maybeSingle();
      if (error) throw new Error(`stores select: ${error.message}`);
      return data?.id ?? null;
    };

    const existing = await find();
    if (existing) return existing;

    const { data, error } = await db.from("stores").insert(insert).select("id").single();
    if (!error && data) return data.id;
    if (isUniqueViolation(error)) {
      const again = await find();
      if (again) return again;
    }
    throw new Error(`stores insert: ${error?.message ?? "sem retorno"}`);
  })();

  cache.set(key, task);
  task.catch(() => cache.delete(key));
  return task;
}

/** Insere observações ignorando duplicatas (índice único parcial com expressões: não dá para usar onConflict). */
async function insertObservations(db: Db, rows: ObservationInsert[]): Promise<number> {
  if (rows.length === 0) return 0;
  const batch = await db.from("price_observations").insert(rows).select("id");
  if (!batch.error) return batch.data?.length ?? 0;
  if (!isUniqueViolation(batch.error)) throw new Error(`price_observations insert: ${batch.error.message}`);

  // Alguma linha duplicada: insere uma a uma e ignora só as duplicadas.
  let inserted = 0;
  for (const row of rows) {
    const one = await db.from("price_observations").insert(row).select("id").single();
    if (!one.error) inserted++;
    else if (!isUniqueViolation(one.error)) throw new Error(`price_observations insert: ${one.error.message}`);
  }
  return inserted;
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Não autenticado", 401);

  let listId: string;
  try {
    const body = (await request.json()) as { listId?: unknown };
    if (typeof body.listId !== "string" || !body.listId) return fail("`listId` é obrigatório", 400);
    listId = body.listId;
  } catch {
    return fail("Body inválido (JSON esperado)", 400);
  }

  // Lista + household (RLS: só membros enxergam).
  const { data: list, error: listError } = await supabase
    .from("lists")
    .select("id, household_id")
    .eq("id", listId)
    .maybeSingle();
  if (listError) return fail(`Erro ao carregar a lista: ${listError.message}`, 500);
  if (!list) return fail("Lista não encontrada", 404);

  const [{ data: household }, { data: itemRows, error: itemsError }] = await Promise.all([
    supabase.from("households").select("lat, lng").eq("id", list.household_id).maybeSingle(),
    supabase.from("list_items").select("id, name, gtin").eq("list_id", listId).eq("checked", false),
  ]);
  if (itemsError) return fail(`Erro ao carregar os itens: ${itemsError.message}`, 500);

  const lat = household?.lat ?? SALVADOR_CENTRO.lat;
  const lng = household?.lng ?? SALVADOR_CENTRO.lng;
  const items: ItemRow[] = (itemRows ?? []).filter((i) => i.name.trim() !== "");

  const falhas: string[] = [];
  const storeCache = new Map<string, Promise<string>>();
  const seen = new Set<string>();
  let observacoes = 0;
  const state: { blocked: PdhError | null } = { blocked: null };

  await runPool(items, CONCORRENCIA, async (item) => {
    if (state.blocked) return;
    const gtin = item.gtin?.replace(/\D+/g, "") ?? "";
    const usaGtin = gtin.length >= 8 && gtin.length <= 14;

    let resultados: PdhResult[];
    try {
      resultados = await searchPrecoDaHora({
        gtin: usaGtin ? gtin : undefined,
        termo: usaGtin ? undefined : item.name,
        lat,
        lng,
        raioKm: 10,
        horas: 72,
        maxResultados: MAX_RESULTADOS_POR_ITEM,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof PdhError && err.blocked) state.blocked = err;
      falhas.push(`${item.name}: ${msg}`);
      return;
    }

    const rows: ObservationInsert[] = [];
    for (const r of resultados) {
      try {
        const storeId = await resolveStoreId(supabase, r.loja, storeCache);
        const dedupe = `${storeId}|${r.gtin ?? ""}|${normalizeName(r.descricao)}|${r.data}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        rows.push({
          household_id: list.household_id,
          store_id: storeId,
          gtin: r.gtin,
          description: r.descricao,
          price: r.preco,
          unit: r.unidade,
          observed_at: r.data,
          valid_until: null,
          source: "precodahora",
        });
      } catch (err) {
        falhas.push(`${item.name} / ${r.loja.nome}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    try {
      observacoes += await insertObservations(supabase, rows);
    } catch (err) {
      falhas.push(`${item.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  if (state.blocked) {
    falhas.push(`Busca interrompida: ${state.blocked.message}`);
  }

  return Response.json({ ok: true, itens: items.length, observacoes, falhas });
}
