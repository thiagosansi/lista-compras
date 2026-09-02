// POST /api/precos/atualizar — busca preços no Preço da Hora para os itens pendentes da lista e grava
// observações + veredictos de correspondência (fase 4, ver SPEC-fase4.md e docs/matching.md).
//
// Passos: 1) carrega household/itens/veredictos cacheados; 2) planSearches (Groq) → termo + palavras excluídas;
// 3) busca por item (pool de 3), descarta candidatos com palavra excluída; 4) juiz (Groq) para descrições
// ainda sem veredicto e upsert em item_matches; 5) insere TODAS as observações; 6) resposta.
// Se o Groq falhar em qualquer passo, a atualização continua sem ele (`semJuiz: true`).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, PdhResult } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";
import { normalizeName } from "@/lib/normalize";
import { PdhError, searchPrecoDaHora } from "@/lib/precodahora/client";
import { isLlmConfigured } from "@/lib/llm/groq";
import {
  findExcludedWord,
  judgeMatches,
  planSearches,
  type MatchCandidate,
  type SearchPlan,
} from "@/lib/llm/matching";
import { parseGtin } from "@/lib/products/server";

export const runtime = "nodejs";
export const maxDuration = 120;

const SALVADOR_CENTRO = { lat: -12.9777, lng: -38.5016 };
// 1 página (25) = 1 POST por item: o Preço da Hora bloqueia (captcha) após ~20 POSTs em ~15 min por IP.
const MAX_RESULTADOS_POR_ITEM = 25;
const CONCORRENCIA = 1;
/** Itens com preço correspondente buscado há menos de 24 h não são buscados de novo (poupa o limite do Preço da Hora). */
const FRESH_MS = 24 * 60 * 60 * 1000;
/** Depois disto não começamos novos itens, para responder antes do limite da função. */
const BUDGET_MS = 100_000;
/** Só chamamos o juiz se ainda sobrar isto de orçamento (a chamada pode esperar um `retry-after`). */
const JUDGE_MIN_REMAINING_MS = 12_000;

type Db = SupabaseClient<Database>;
type ObservationInsert = Database["public"]["Tables"]["price_observations"]["Insert"];
type MatchInsert = Database["public"]["Tables"]["item_matches"]["Insert"];
type ItemRow = { id: string; name: string; gtin: string | null };
type CachedVerdict = { isMatch: boolean; source: "llm" | "user"; gtin: string | null };

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

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

/** Serializa promessas (mutex simples): o plano gratuito do Groq limita tokens/minuto, então uma chamada por vez. */
function createLock() {
  let tail: Promise<void> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/**
 * Semeia o catálogo (`products`) a partir de resultados ACEITOS (gtin válido + correspondência positiva
 * do item). Só insere linhas novas — `onConflict: "gtin"` com `ignoreDuplicates: true` nunca sobrescreve
 * `name`/`category` de um produto já existente. Erros aqui não abortam a atualização (chamador captura).
 */
async function seedProducts(db: Db, rows: { gtin: string; name: string }[]): Promise<void> {
  const byGtin = new Map<string, string>();
  for (const r of rows) {
    const name = r.name.replace(/\s+/g, " ").trim().slice(0, 200);
    if (name && !byGtin.has(r.gtin)) byGtin.set(r.gtin, name);
  }
  if (byGtin.size === 0) return;
  const payload = [...byGtin].map(([gtin, name]) => ({ gtin, name }));
  const { error } = await db.from("products").upsert(payload, { onConflict: "gtin", ignoreDuplicates: true });
  if (error) throw new Error(`products upsert: ${error.message}`);
}

/** Upsert de veredictos do juiz. O trigger do banco também protege `source='user'`, mas não mandamos nem tentar. */
async function upsertMatches(db: Db, rows: MatchInsert[]): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await db.from("item_matches").upsert(rows, { onConflict: "household_id,item_key,description_key" });
  if (error) throw new Error(`item_matches upsert: ${error.message}`);
}

export async function POST(request: Request) {
  const startedAt = Date.now();
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

  // ---- 1. Lista, household, itens pendentes e veredictos cacheados ----
  const { data: list, error: listError } = await supabase
    .from("lists")
    .select("id, household_id")
    .eq("id", listId)
    .maybeSingle();
  if (listError) return fail(`Erro ao carregar a lista: ${listError.message}`, 500);
  if (!list) return fail("Lista não encontrada", 404);
  const householdId = list.household_id;

  const [{ data: household }, { data: itemRows, error: itemsError }] = await Promise.all([
    supabase.from("households").select("lat, lng").eq("id", householdId).maybeSingle(),
    supabase.from("list_items").select("id, name, gtin").eq("list_id", listId).eq("checked", false),
  ]);
  if (itemsError) return fail(`Erro ao carregar os itens: ${itemsError.message}`, 500);

  const lat = household?.lat ?? SALVADOR_CENTRO.lat;
  const lng = household?.lng ?? SALVADOR_CENTRO.lng;
  const allItems: ItemRow[] = (itemRows ?? []).filter((i) => i.name.trim() !== "");
  const falhas: string[] = [];

  // Veredictos cacheados: Map<item_key, Map<description_key, veredicto>>.
  const itemKeys = [...new Set(allItems.map((i) => normalizeName(i.name)).filter(Boolean))];
  const cache = new Map<string, Map<string, CachedVerdict>>();
  if (itemKeys.length > 0) {
    const { data: matchRows, error: matchError } = await supabase
      .from("item_matches")
      .select("item_key, description_key, is_match, source, gtin")
      .eq("household_id", householdId)
      .in("item_key", itemKeys);
    if (matchError) {
      falhas.push(`Não foi possível carregar as correspondências salvas: ${matchError.message}`);
    }
    for (const m of matchRows ?? []) {
      let per = cache.get(m.item_key);
      if (!per) cache.set(m.item_key, (per = new Map()));
      per.set(m.description_key, { isMatch: m.is_match, source: m.source, gtin: m.gtin });
    }
  }

  // ---- 1b. Pula itens já atualizados nas últimas 24 h ----
  const { data: freshRows } = await supabase
    .from("price_observations")
    .select("normalized_name, gtin")
    .eq("household_id", householdId)
    .eq("source", "precodahora")
    .gte("created_at", new Date(Date.now() - FRESH_MS).toISOString());
  const freshDescs = new Set((freshRows ?? []).map((r) => r.normalized_name));
  const freshGtins = new Set((freshRows ?? []).map((r) => r.gtin).filter((g): g is string => Boolean(g)));
  const jaAtualizados: string[] = [];
  const items = allItems.filter((item) => {
    const fresh = hasGtin(item)
      ? freshGtins.has(digitsOf(item.gtin))
      : [...(cache.get(normalizeName(item.name))?.entries() ?? [])].some(
          ([desc, v]) => v.isMatch && freshDescs.has(desc),
        );
    if (fresh) jaAtualizados.push(item.name);
    return !fresh;
  });

  // ---- 2. Plano de busca (uma chamada ao Groq para todos os itens) ----
  let semJuiz = !isLlmConfigured();
  let plans: Record<string, SearchPlan> = {};
  const needPlan = items.filter((i) => !hasGtin(i));
  if (!semJuiz && needPlan.length > 0) {
    try {
      plans = await planSearches(needPlan.map((i) => ({ id: i.id, name: i.name })));
    } catch (err) {
      semJuiz = true;
      falhas.push(`Planejamento de busca (IA) indisponível: ${errMsg(err)}`);
    }
  }

  // ---- 3-5. Por item: busca, filtro, juiz, observações ----
  const storeCache = new Map<string, Promise<string>>();
  const seen = new Set<string>();
  const withJudgeLock = createLock();
  const state = { blocked: null as PdhError | null, observacoes: 0, correspondencias: 0, semJuiz };

  await runPool(items, CONCORRENCIA, async (item) => {
    if (state.blocked) return;
    if (Date.now() - startedAt > BUDGET_MS) {
      falhas.push(`${item.name}: tempo esgotado, não foi buscado`);
      return;
    }
    const gtin = digitsOf(item.gtin);
    const usaGtin = hasGtin(item);
    const itemKey = normalizeName(item.name);
    const plan: SearchPlan = plans[item.id] ?? { termo: item.name, excluir: [] };

    let resultados: PdhResult[];
    try {
      resultados = await searchPrecoDaHora({
        gtin: usaGtin ? gtin : undefined,
        termo: usaGtin ? undefined : plan.termo,
        lat,
        lng,
        raioKm: 10,
        horas: 72,
        maxResultados: MAX_RESULTADOS_POR_ITEM,
      });
    } catch (err) {
      if (err instanceof PdhError && err.blocked) {
        state.blocked = err;
        falhas.push(`${item.name}: não buscado (limite do Preço da Hora)`);
      } else {
        falhas.push(`${item.name}: ${errMsg(err)}`);
      }
      return;
    }

    // Candidatos ao juiz: descrições distintas, sem palavra excluída, sem veredicto cacheado.
    // Busca por GTIN já é correspondência exata (best_prices usa gtin/product) — não precisa de juiz.
    const verdicts: MatchInsert[] = [];
    if (!usaGtin && itemKey) {
      const cached = cache.get(itemKey) ?? new Map<string, CachedVerdict>();
      const candidates = new Map<string, MatchCandidate>();
      const excluded = new Map<string, { gtin: string | null; word: string }>();
      for (const r of resultados) {
        const key = normalizeName(r.descricao);
        if (!key || cached.has(key)) continue;
        const word = findExcludedWord(key, plan.excluir);
        if (word) {
          if (!excluded.has(key)) excluded.set(key, { gtin: r.gtin, word });
          continue;
        }
        const prev = candidates.get(key);
        if (!prev) candidates.set(key, { description: r.descricao, gtin: r.gtin, price: r.preco });
        else {
          if (!prev.gtin && r.gtin) prev.gtin = r.gtin;
          if (typeof prev.price !== "number" || r.preco < prev.price) prev.price = r.preco;
        }
      }

      const now = new Date().toISOString();
      for (const [key, e] of excluded) {
        verdicts.push({
          household_id: householdId,
          item_key: itemKey,
          description_key: key,
          gtin: e.gtin,
          is_match: false,
          source: "llm",
          reason: `Contém "${e.word}" (palavra excluída para "${plan.termo}")`,
          updated_at: now,
        });
      }
      // Mesmo código de barras de uma descrição excluída/rejeitada = mesmo produto (ex.: "ARROZ MATILHA 5KG" e
      // "ARROZ P/ CAES MATILHA 5KG" têm o mesmo GTIN): rejeita sem consultar o juiz.
      const negativeGtins = new Map<string, string>();
      for (const [key, v] of cached) if (!v.isMatch && v.gtin && !negativeGtins.has(v.gtin)) negativeGtins.set(v.gtin, key);
      for (const [key, e] of excluded) if (e.gtin && !negativeGtins.has(e.gtin)) negativeGtins.set(e.gtin, key);
      for (const [key, c] of candidates) {
        const twin = c.gtin ? negativeGtins.get(c.gtin) : undefined;
        if (!twin) continue;
        candidates.delete(key);
        verdicts.push({
          household_id: householdId,
          item_key: itemKey,
          description_key: key,
          gtin: c.gtin,
          is_match: false,
          source: "llm",
          reason: `Mesmo código de barras de "${twin}" (rejeitada)`,
          updated_at: now,
        });
      }

      if (!state.semJuiz && candidates.size > 0) {
        try {
          const judged = await withJudgeLock(async () => {
            if (state.semJuiz) return [];
            if (Date.now() - startedAt > BUDGET_MS - JUDGE_MIN_REMAINING_MS) {
              throw new Error("sem tempo para consultar o juiz");
            }
            return judgeMatches({ name: item.name }, [...candidates.values()]);
          });
          for (const v of judged) {
            const key = normalizeName(v.description);
            const c = candidates.get(key);
            if (!c) continue;
            verdicts.push({
              household_id: householdId,
              item_key: itemKey,
              description_key: key,
              gtin: c.gtin,
              is_match: v.isMatch,
              source: "llm",
              reason: v.reason || null,
              updated_at: now,
            });
          }
        } catch (err) {
          state.semJuiz = true;
          falhas.push(`${item.name}: juiz de correspondência (IA) indisponível: ${errMsg(err)}`);
        }
      }

      // Nunca sobrescreve veredicto do usuário (o trigger também garante, mas não enviamos).
      const toSave = verdicts.filter((v) => cached.get(v.description_key)?.source !== "user");
      try {
        await upsertMatches(supabase, toSave);
        for (const v of toSave) cached.set(v.description_key, { isMatch: v.is_match, source: "llm", gtin: v.gtin ?? null });
        cache.set(itemKey, cached);
      } catch (err) {
        falhas.push(`${item.name}: ${errMsg(err)}`);
      }

      // Correspondências deste item = descrições retornadas com veredicto positivo (cacheado ou novo).
      const matchedKeys = new Set<string>();
      for (const r of resultados) {
        const key = normalizeName(r.descricao);
        if (cached.get(key)?.isMatch) matchedKeys.add(key);
      }
      state.correspondencias += matchedKeys.size;
    } else if (usaGtin) {
      state.correspondencias += resultados.length > 0 ? 1 : 0;
    }

    // Semeia o catálogo só com resultados ACEITOS: gtin válido e (busca por gtin OU veredicto positivo
    // — cacheado ou recém-emitido pelo juiz nesta chamada). Sem veredicto (semJuiz) não semeia por nome.
    const toSeed: { gtin: string; name: string }[] = [];
    const seededGtins = new Set<string>();
    for (const r of resultados) {
      const gtinValido = parseGtin(r.gtin);
      if (!gtinValido || seededGtins.has(gtinValido)) continue;
      const accepted = usaGtin || (itemKey ? cache.get(itemKey)?.get(normalizeName(r.descricao))?.isMatch === true : false);
      if (!accepted) continue;
      seededGtins.add(gtinValido);
      toSeed.push({ gtin: gtinValido, name: r.descricao });
    }
    if (toSeed.length > 0) {
      try {
        await seedProducts(supabase, toSeed);
      } catch (err) {
        falhas.push(`${item.name}: catálogo de produtos: ${errMsg(err)}`);
      }
    }

    // Observações: TODOS os resultados (preços válidos, mesmo os que não casam com este item).
    const rows: ObservationInsert[] = [];
    for (const r of resultados) {
      try {
        const storeId = await resolveStoreId(supabase, r.loja, storeCache);
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
      } catch (err) {
        falhas.push(`${item.name} / ${r.loja.nome}: ${errMsg(err)}`);
      }
    }

    try {
      state.observacoes += await insertObservations(supabase, rows);
    } catch (err) {
      falhas.push(`${item.name}: ${errMsg(err)}`);
    }
  });

  if (state.blocked) {
    falhas.push(
      "Preço da Hora limitou as buscas por agora. Os itens já buscados ficaram salvos; tente de novo em uns 15 minutos.",
    );
  }

  // ---- 6. Resposta ----
  return Response.json({
    ok: true,
    itens: items.length,
    jaAtualizados: jaAtualizados.length,
    observacoes: state.observacoes,
    correspondencias: state.correspondencias,
    semJuiz: state.semJuiz,
    falhas,
  });
}

function digitsOf(v: string | null): string {
  return v?.replace(/\D+/g, "") ?? "";
}

function hasGtin(item: ItemRow): boolean {
  const d = digitsOf(item.gtin);
  return d.length >= 8 && d.length <= 14;
}
