// Helpers de servidor para o catálogo de produtos (fase 5): household do usuário, upsert por GTIN,
// última compra do household por GTIN, preço sugerido e gravação de observações vindas do Preço da Hora.
// Só para Route Handlers/Server Actions (recebe o client Supabase do servidor, com RLS do usuário).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, PdhResult, ProductLookup, ProductSuggestion } from "@/lib/database.types";
import { normalizeName, onlyDigits } from "@/lib/normalize";

export type Db = SupabaseClient<Database>;

export type ProductLite = { id: string; gtin: string; name: string; category: string | null };
export type HouseholdLite = { id: string; lat: number | null; lng: number | null };
export type LastPurchase = NonNullable<ProductSuggestion["ultimaCompra"]>;

type ObservationInsert = Database["public"]["Tables"]["price_observations"]["Insert"];

/** GTIN válido = 8 a 14 dígitos com pelo menos um dígito diferente de zero. Aceita número (perde zeros à esquerda). */
export function parseGtin(v: unknown): string | null {
  const d = typeof v === "number" ? String(v) : typeof v === "string" ? onlyDigits(v) : "";
  return /^\d{8,14}$/.test(d) && /[1-9]/.test(d) ? d : null;
}

/** Primeira casa do usuário (a mais antiga), com lat/lng. `null` se ele não faz parte de nenhuma. */
export async function getHousehold(db: Db, userId: string): Promise<HouseholdLite | null> {
  const { data: membership, error } = await db
    .from("household_members")
    .select("household_id")
    .eq("user_id", userId)
    .order("joined_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`household_members select: ${error.message}`);
  if (!membership) return null;
  const { data: household, error: hError } = await db
    .from("households")
    .select("id, lat, lng")
    .eq("id", membership.household_id)
    .maybeSingle();
  if (hError) throw new Error(`households select: ${hError.message}`);
  return household ?? { id: membership.household_id, lat: null, lng: null };
}

function toLite(row: { id: string; gtin: string | null; name: string; category: string | null }): ProductLite | null {
  return row.gtin ? { id: row.id, gtin: row.gtin, name: row.name, category: row.category } : null;
}

export async function findProductByGtin(db: Db, gtin: string): Promise<ProductLite | null> {
  const { data, error } = await db.from("products").select("id, gtin, name, category").eq("gtin", gtin).maybeSingle();
  if (error) throw new Error(`products select: ${error.message}`);
  return data ? toLite(data) : null;
}

export async function findProductsByGtins(db: Db, gtins: string[]): Promise<ProductLite[]> {
  if (gtins.length === 0) return [];
  const { data, error } = await db.from("products").select("id, gtin, name, category").in("gtin", gtins);
  if (error) throw new Error(`products select: ${error.message}`);
  return (data ?? []).map(toLite).filter((p): p is ProductLite => p !== null);
}

/**
 * Upsert de produtos por GTIN (`onConflict: "gtin"`): cria os novos e atualiza `name` dos existentes.
 * `category` não é enviada, então a categoria já salva é preservada. Devolve as linhas resultantes.
 */
export async function upsertProductsByGtin(db: Db, rows: { gtin: string; name: string }[]): Promise<ProductLite[]> {
  const byGtin = new Map<string, string>();
  for (const r of rows) {
    const name = r.name.replace(/\s+/g, " ").trim().slice(0, 200);
    if (name && !byGtin.has(r.gtin)) byGtin.set(r.gtin, name);
  }
  if (byGtin.size === 0) return [];
  const payload = [...byGtin].map(([gtin, name]) => ({ gtin, name }));
  const { data, error } = await db
    .from("products")
    .upsert(payload, { onConflict: "gtin" })
    .select("id, gtin, name, category");
  if (error) throw new Error(`products upsert: ${error.message}`);
  return (data ?? []).map(toLite).filter((p): p is ProductLite => p !== null);
}

async function storeNames(db: Db, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const { data, error } = await db.from("stores").select("id, name").in("id", ids);
  if (error) throw new Error(`stores select: ${error.message}`);
  for (const s of data ?? []) out.set(s.id, s.name);
  return out;
}

/** Última compra do household por GTIN: observação mais recente com `source in ('nfce','manual')`. */
export async function lastPurchasesByGtin(db: Db, householdId: string, gtins: string[]): Promise<Map<string, LastPurchase>> {
  const out = new Map<string, LastPurchase>();
  if (gtins.length === 0) return out;
  const { data, error } = await db
    .from("price_observations")
    .select("gtin, price, observed_at, store_id")
    .eq("household_id", householdId)
    .in("gtin", gtins)
    .in("source", ["nfce", "manual"])
    .order("observed_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(`price_observations select: ${error.message}`);
  const first = new Map<string, { price: number; observed_at: string; store_id: string }>();
  for (const r of data ?? []) {
    if (r.gtin && !first.has(r.gtin)) first.set(r.gtin, { price: r.price, observed_at: r.observed_at, store_id: r.store_id });
  }
  const names = await storeNames(db, [...new Set([...first.values()].map((v) => v.store_id))]);
  for (const [gtin, v] of first) {
    out.set(gtin, { loja: names.get(v.store_id) ?? "Loja", preco: v.price, data: v.observed_at });
  }
  return out;
}

/**
 * Preço sugerido para um GTIN: a observação mais recente (qualquer fonte) visível ao usuário (RLS = seu household).
 * Com `storeId`, tenta primeiro essa loja; se ela não tiver observação, cai para qualquer loja.
 */
export async function suggestedPrice(db: Db, gtin: string, storeId?: string | null): Promise<ProductLookup["precoSugerido"]> {
  const fetchLatest = async (onlyStore: string | null) => {
    let q = db
      .from("price_observations")
      .select("price, observed_at, source, store_id")
      .eq("gtin", gtin)
      .order("observed_at", { ascending: false })
      .limit(1);
    if (onlyStore) q = q.eq("store_id", onlyStore);
    const { data, error } = await q.maybeSingle();
    if (error) throw new Error(`price_observations select: ${error.message}`);
    return data;
  };
  const row = (storeId ? await fetchLatest(storeId) : null) ?? (await fetchLatest(null));
  if (!row) return null;
  const names = await storeNames(db, [row.store_id]);
  return { preco: row.price, loja: names.get(row.store_id) ?? "Loja", fonte: row.source, data: row.observed_at };
}

// ---------- observações do Preço da Hora ----------

function isUniqueViolation(err: { code?: string } | null): boolean {
  return err?.code === "23505";
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

/** Encontra ou cria a loja: por CNPJ quando houver; senão por (nome, endereço) com cnpj nulo (índice único parcial). */
async function resolveStoreId(db: Db, loja: PdhResult["loja"], cache: Map<string, string>): Promise<string> {
  const key = loja.cnpj ? `cnpj:${loja.cnpj}` : `name:${loja.nome.toLowerCase()}|${loja.endereco ?? ""}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const find = async (): Promise<string | null> => {
    let q = db.from("stores").select("id").limit(1);
    if (loja.cnpj) q = q.eq("cnpj", loja.cnpj);
    else {
      q = q.is("cnpj", null).ilike("name", escapeLike(loja.nome));
      q = loja.endereco ? q.eq("address", loja.endereco) : q.is("address", null);
    }
    const { data, error } = await q.maybeSingle();
    if (error) throw new Error(`stores select: ${error.message}`);
    return data?.id ?? null;
  };

  let id = await find();
  if (!id) {
    const { data, error } = await db
      .from("stores")
      .insert({ cnpj: loja.cnpj, name: loja.nome, address: loja.endereco, city: loja.cidade, lat: loja.lat, lng: loja.lng })
      .select("id")
      .single();
    if (!error && data) id = data.id;
    else if (isUniqueViolation(error)) id = await find();
    if (!id) throw new Error(`stores insert: ${error?.message ?? "sem retorno"}`);
  }
  cache.set(key, id);
  return id;
}

/**
 * Grava resultados do Preço da Hora como `price_observations` (`source='precodahora'`) do household,
 * criando as lojas que faltarem. Duplicatas (índice único parcial) são ignoradas. Devolve quantas entraram.
 */
export async function recordPdhObservations(db: Db, householdId: string, results: PdhResult[]): Promise<number> {
  const storeCache = new Map<string, string>();
  const seen = new Set<string>();
  const rows: ObservationInsert[] = [];
  for (const r of results) {
    const storeId = await resolveStoreId(db, r.loja, storeCache);
    const dedupe = `${storeId}|${r.gtin ?? ""}|${normalizeName(r.descricao)}|${r.data}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    rows.push({
      household_id: householdId,
      store_id: storeId,
      gtin: r.gtin,
      description: r.descricao,
      price: r.preco,
      unit: r.unidade,
      observed_at: r.data,
      valid_until: null,
      source: "precodahora",
    });
  }
  if (rows.length === 0) return 0;

  const batch = await db.from("price_observations").insert(rows).select("id");
  if (!batch.error) return batch.data?.length ?? 0;
  if (!isUniqueViolation(batch.error)) throw new Error(`price_observations insert: ${batch.error.message}`);

  let inserted = 0;
  for (const row of rows) {
    const one = await db.from("price_observations").insert(row).select("id").single();
    if (!one.error) inserted++;
    else if (!isUniqueViolation(one.error)) throw new Error(`price_observations insert: ${one.error.message}`);
  }
  return inserted;
}
