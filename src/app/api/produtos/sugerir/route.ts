// POST /api/produtos/sugerir — autocomplete de produtos reais (fase 5, ver SPEC-fase5.md e docs/produtos.md).
// Body { termo, forcarExterno? } (termo: mín. 5 caracteres). Sempre busca no catálogo local (`products`); a fonte
// externa é o `/sugestao/` do Preço da Hora, cacheada 7 dias por termo em `product_suggestions` (limite de ~20
// POSTs/15 min). Falha do Preço da Hora nunca vira 5xx: responde só com o local e `fonteExterna: false`.
// Regra de suficiência local: com >= 3 resultados locais e sem `forcarExterno: true`, só usa a fonte externa se
// já houver cache fresco do termo — nunca dispara o PdH nesse caso (devolve `motivo: "local_suficiente"`).

import type { Category } from "@/lib/categories";
import type { ProductSuggestion } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";
import { categorizeNames } from "@/lib/llm/categorize";
import { isLlmConfigured } from "@/lib/llm/groq";
import { normalizeName } from "@/lib/normalize";
import { PdhError, suggestPrecoDaHora } from "@/lib/precodahora/client";
import {
  findProductsByGtins,
  getHousehold,
  lastPurchasesByGtin,
  upsertProductsByGtin,
  type Db,
  type ProductLite,
} from "@/lib/products/server";

export const runtime = "nodejs";
export const maxDuration = 30;

const MIN_TERM_LENGTH = 5;
const LOCAL_LIMIT = 10;
const MAX_SUGGESTIONS = 12;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A partir daqui o catálogo local já é considerado suficiente: sem `forcarExterno`, não consulta o PdH. */
const LOCAL_SUFFICIENT_THRESHOLD = 3;

function fail(error: string, status: number) {
  return Response.json({ ok: false, error }, { status });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Busca local: `normalized_name` contendo o termo inteiro e, se houver mais de uma palavra, contendo todas as palavras. */
async function searchLocal(db: Db, termKey: string): Promise<ProductLite[]> {
  const out = new Map<string, ProductLite>();
  const collect = (rows: { id: string; gtin: string | null; name: string; category: string | null }[] | null) => {
    for (const r of rows ?? []) {
      if (r.gtin && !out.has(r.gtin)) out.set(r.gtin, { id: r.id, gtin: r.gtin, name: r.name, category: r.category });
    }
  };

  const whole = await db
    .from("products")
    .select("id, gtin, name, category")
    .not("gtin", "is", null)
    .ilike("normalized_name", `%${termKey}%`)
    .order("name", { ascending: true })
    .limit(LOCAL_LIMIT);
  if (whole.error) throw new Error(`products select: ${whole.error.message}`);
  collect(whole.data);

  const words = termKey.split(" ").filter((w) => w.length >= 2);
  if (words.length > 1 && out.size < LOCAL_LIMIT) {
    let q = db.from("products").select("id, gtin, name, category").not("gtin", "is", null);
    for (const w of words) q = q.ilike("normalized_name", `%${w}%`);
    const byWords = await q.order("name", { ascending: true }).limit(LOCAL_LIMIT);
    if (byWords.error) throw new Error(`products select: ${byWords.error.message}`);
    collect(byWords.data);
  }
  return [...out.values()].slice(0, LOCAL_LIMIT);
}

/**
 * Sugestões externas: cache de 7 dias em `product_suggestions`; senão consulta o Preço da Hora, faz upsert em
 * `products` e grava o cache. Devolve `null` quando a fonte externa não pôde ser usada.
 * `allowNetwork: false` (regra de suficiência local) nunca chama o PdH: com cache fresco usa o cache normalmente;
 * sem cache fresco, devolve `motivo: "local_suficiente"` sem consultar a rede.
 */
async function searchExternal(
  db: Db,
  termo: string,
  termKey: string,
  allowNetwork: boolean,
): Promise<{ products: ProductLite[]; aviso?: string; motivo?: string } | null> {
  const { data: cached, error: cacheError } = await db
    .from("product_suggestions")
    .select("gtins, fetched_at")
    .eq("term_key", termKey)
    .maybeSingle();
  if (cacheError) console.warn("[api/produtos/sugerir] product_suggestions select:", cacheError.message);

  const fresh = cached && Date.now() - new Date(cached.fetched_at).getTime() < CACHE_TTL_MS;
  if (cached && fresh) {
    return { products: orderByGtins(await findProductsByGtins(db, cached.gtins), cached.gtins) };
  }

  if (!allowNetwork) {
    return { products: [], motivo: "local_suficiente" };
  }

  try {
    const suggestions = await suggestPrecoDaHora(termo);
    const products = await upsertProductsByGtin(
      db,
      suggestions.map((s) => ({ gtin: s.gtin, name: s.descricao })),
    );
    const gtins = suggestions.map((s) => s.gtin);
    const { error: saveError } = await db
      .from("product_suggestions")
      .upsert({ term_key: termKey, gtins, fetched_at: new Date().toISOString() }, { onConflict: "term_key" });
    if (saveError) console.warn("[api/produtos/sugerir] product_suggestions upsert:", saveError.message);
    return { products: orderByGtins(products, gtins) };
  } catch (err) {
    const aviso =
      err instanceof PdhError && err.blocked
        ? "Preço da Hora limitou as consultas por agora; mostrando só o catálogo local."
        : `Fonte externa indisponível: ${errMsg(err)}`;
    if (!(err instanceof PdhError)) console.error("[api/produtos/sugerir]", err);
    // Cache vencido ainda é melhor que nada.
    if (cached && cached.gtins.length > 0) {
      return { products: orderByGtins(await findProductsByGtins(db, cached.gtins), cached.gtins), aviso };
    }
    return null;
  }
}

function orderByGtins(products: ProductLite[], gtins: string[]): ProductLite[] {
  const rank = new Map(gtins.map((g, i) => [g, i]));
  return [...products].sort((a, b) => (rank.get(a.gtin) ?? Infinity) - (rank.get(b.gtin) ?? Infinity));
}

/**
 * Categoriza (em memória, mutando `categoria`) as sugestões sem categoria: UMA chamada em lote ao Groq com as
 * descrições, gravando `products.category` por gtin só onde ainda está nula. Nunca lança: se o Groq não estiver
 * configurado, falhar ou não retornar nada útil, as sugestões seguem com `categoria: null`.
 */
async function categorizeMissing(db: Db, sugestoes: ProductSuggestion[]): Promise<void> {
  const missing = sugestoes.filter((s) => !s.categoria);
  if (missing.length === 0 || !isLlmConfigured()) return;

  const gtinsByDescricao = new Map<string, string[]>();
  for (const s of missing) {
    const arr = gtinsByDescricao.get(s.descricao);
    if (arr) arr.push(s.gtin);
    else gtinsByDescricao.set(s.descricao, [s.gtin]);
  }
  const descricoes = [...gtinsByDescricao.keys()];

  let categorias: Record<string, Category>;
  try {
    categorias = await categorizeNames(descricoes);
  } catch (err) {
    console.warn("[api/produtos/sugerir] categorizeNames:", errMsg(err));
    return;
  }
  if (Object.keys(categorias).length === 0) return;

  const gtinsByCategoria = new Map<Category, string[]>();
  for (const [descricao, categoria] of Object.entries(categorias)) {
    const gtins = gtinsByDescricao.get(descricao);
    if (!gtins) continue;
    const arr = gtinsByCategoria.get(categoria);
    if (arr) arr.push(...gtins);
    else gtinsByCategoria.set(categoria, [...gtins]);
  }

  for (const s of missing) {
    const categoria = categorias[s.descricao];
    if (categoria) s.categoria = categoria;
  }

  for (const [categoria, gtins] of gtinsByCategoria) {
    const { error } = await db.from("products").update({ category: categoria }).in("gtin", gtins).is("category", null);
    if (error) console.warn("[api/produtos/sugerir] products update category:", error.message);
  }
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Não autenticado", 401);

  let body: { termo?: unknown; forcarExterno?: unknown };
  try {
    body = (await request.json()) as { termo?: unknown; forcarExterno?: unknown };
  } catch {
    return fail("Body inválido (JSON esperado)", 400);
  }
  const termo = typeof body.termo === "string" ? body.termo.replace(/\s+/g, " ").trim() : "";
  const forcarExterno = body.forcarExterno === true;
  if (termo.length < MIN_TERM_LENGTH) return fail(`\`termo\` precisa ter pelo menos ${MIN_TERM_LENGTH} caracteres`, 400);
  const termKey = normalizeName(termo);
  if (!termKey) return fail("`termo` sem conteúdo útil", 400);

  let householdId: string;
  try {
    const household = await getHousehold(supabase, user.id);
    if (!household) return fail("Você ainda não faz parte de uma casa", 403);
    householdId = household.id;
  } catch (err) {
    return fail(`Erro ao carregar a casa: ${errMsg(err)}`, 500);
  }

  let local: ProductLite[];
  try {
    local = await searchLocal(supabase, termKey);
  } catch (err) {
    return fail(`Erro ao buscar no catálogo: ${errMsg(err)}`, 500);
  }

  const allowNetwork = forcarExterno || local.length < LOCAL_SUFFICIENT_THRESHOLD;

  let external: { products: ProductLite[]; aviso?: string; motivo?: string } | null = null;
  try {
    external = await searchExternal(supabase, termo, termKey, allowNetwork);
  } catch (err) {
    // Erro do banco ao lidar com o cache/catálogo: segue só com o local.
    console.error("[api/produtos/sugerir] externo:", err);
    external = null;
  }

  const localGtins = new Set(local.map((p) => p.gtin));
  const externalOnly = (external?.products ?? []).filter((p) => !localGtins.has(p.gtin));
  const allGtins = [...localGtins, ...externalOnly.map((p) => p.gtin)];

  let purchases = new Map<string, NonNullable<ProductSuggestion["ultimaCompra"]>>();
  try {
    purchases = await lastPurchasesByGtin(supabase, householdId, allGtins);
  } catch (err) {
    console.warn("[api/produtos/sugerir] última compra:", errMsg(err));
  }

  const toSuggestion = (p: ProductLite, origem: ProductSuggestion["origem"]): ProductSuggestion => {
    const ultimaCompra = purchases.get(p.gtin);
    return { gtin: p.gtin, descricao: p.name, categoria: p.category, origem, ...(ultimaCompra ? { ultimaCompra } : {}) };
  };
  const localWithPurchase = local
    .filter((p) => purchases.has(p.gtin))
    .sort((a, b) => (purchases.get(b.gtin)?.data ?? "").localeCompare(purchases.get(a.gtin)?.data ?? ""));
  const localRest = local.filter((p) => !purchases.has(p.gtin));
  const sugestoes = [
    ...localWithPurchase.map((p) => toSuggestion(p, "local")),
    ...localRest.map((p) => toSuggestion(p, "local")),
    ...externalOnly.map((p) => toSuggestion(p, "precodahora")),
  ].slice(0, MAX_SUGGESTIONS);

  try {
    await categorizeMissing(supabase, sugestoes);
  } catch (err) {
    // Nunca deve lançar (categorizeMissing já trata seus próprios erros), mas por segurança: sem categoria, sem 5xx.
    console.warn("[api/produtos/sugerir] categorizeMissing:", errMsg(err));
  }

  return Response.json({
    ok: true,
    sugestoes,
    fonteExterna: external !== null && !external.motivo,
    ...(external?.aviso ? { aviso: external.aviso } : {}),
    ...(external?.motivo ? { motivo: external.motivo } : {}),
  });
}
