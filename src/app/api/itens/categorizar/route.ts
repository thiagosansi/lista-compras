// POST /api/itens/categorizar — categoria (seção do mercado) para nomes de itens (fase 5).
// Body { nomes: string[] } (máx. 50). Cache GLOBAL em `item_categories` (por `normalize_name(nome)`); os que faltam
// vão numa única chamada ao Groq. Grava `source='llm'` sem sobrescrever `'user'` e atualiza `list_items.category`
// dos itens do household do usuário com o mesmo `item_key`. Se o Groq falhar: `DEFAULT_CATEGORY` para os faltantes,
// sem gravar cache. Resposta `{ ok: true, categorias: Record<nome, categoria> }`.

import { DEFAULT_CATEGORY, isCategory, type Category } from "@/lib/categories";
import { createClient } from "@/lib/supabase/server";
import { isLlmConfigured } from "@/lib/llm/groq";
import { categorizeNames } from "@/lib/llm/categorize";
import { normalizeName } from "@/lib/normalize";
import { getHousehold, type Db } from "@/lib/products/server";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_NAMES = 50;

function fail(error: string, status: number) {
  return Response.json({ ok: false, error }, { status });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Atualiza `list_items.category` das listas do household para os item_keys informados (agrupado por categoria). */
async function applyToListItems(db: Db, householdId: string, byKey: Map<string, Category>): Promise<void> {
  if (byKey.size === 0) return;
  const { data: lists, error: listsError } = await db.from("lists").select("id").eq("household_id", householdId);
  if (listsError) throw new Error(`lists select: ${listsError.message}`);
  const listIds = (lists ?? []).map((l) => l.id);
  if (listIds.length === 0) return;

  const keysByCategory = new Map<Category, string[]>();
  for (const [key, cat] of byKey) {
    const arr = keysByCategory.get(cat);
    if (arr) arr.push(key);
    else keysByCategory.set(cat, [key]);
  }
  for (const [cat, keys] of keysByCategory) {
    const { error } = await db
      .from("list_items")
      .update({ category: cat })
      .in("list_id", listIds)
      .in("normalized_name", keys);
    if (error) throw new Error(`list_items update: ${error.message}`);
  }
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Não autenticado", 401);

  let body: { nomes?: unknown };
  try {
    body = (await request.json()) as { nomes?: unknown };
  } catch {
    return fail("Body inválido (JSON esperado)", 400);
  }
  if (!Array.isArray(body.nomes)) return fail("`nomes` deve ser uma lista de strings", 400);
  if (body.nomes.length > MAX_NAMES) return fail(`No máximo ${MAX_NAMES} nomes por chamada`, 400);

  // Nome original → item_key. Nomes vazios ou sem conteúdo útil ficam com DEFAULT_CATEGORY (sem cache).
  const nomes: string[] = [];
  const keyOf = new Map<string, string>();
  for (const raw of body.nomes) {
    if (typeof raw !== "string") return fail("`nomes` deve conter só strings", 400);
    const nome = raw.replace(/\s+/g, " ").trim();
    if (!nome || keyOf.has(nome)) continue;
    nomes.push(nome);
    keyOf.set(nome, normalizeName(nome));
  }
  const categorias: Record<string, Category> = {};
  if (nomes.length === 0) return Response.json({ ok: true, categorias });

  let householdId: string;
  try {
    const household = await getHousehold(supabase, user.id);
    if (!household) return fail("Você ainda não faz parte de uma casa", 403);
    householdId = household.id;
  } catch (err) {
    return fail(`Erro ao carregar a casa: ${errMsg(err)}`, 500);
  }

  // ---- 1. Cache global ----
  const keys = [...new Set([...keyOf.values()].filter(Boolean))];
  const cached = new Map<string, Category>();
  if (keys.length > 0) {
    const { data, error } = await supabase.from("item_categories").select("item_key, category").in("item_key", keys);
    if (error) return fail(`Erro ao carregar as categorias: ${error.message}`, 500);
    for (const row of data ?? []) if (isCategory(row.category)) cached.set(row.item_key, row.category);
  }

  // ---- 2. Faltantes → uma chamada ao Groq ----
  const missing = nomes.filter((n) => {
    const key = keyOf.get(n) ?? "";
    return key !== "" && !cached.has(key);
  });
  const resolved = new Map<string, Category>(cached);
  const falhas: string[] = [];
  if (missing.length > 0) {
    if (!isLlmConfigured()) {
      falhas.push("Categorização por IA não configurada (GROQ_API_KEY)");
    } else {
      try {
        const fromLlm = await categorizeNames(missing);
        const rows: { item_key: string; category: Category; source: "llm" }[] = [];
        for (const nome of missing) {
          const cat = fromLlm[nome];
          const key = keyOf.get(nome);
          if (!cat || !key || resolved.has(key)) continue;
          resolved.set(key, cat);
          rows.push({ item_key: key, category: cat, source: "llm" });
        }
        if (rows.length > 0) {
          // ON CONFLICT DO NOTHING: nunca sobrescreve uma linha existente (inclusive `source='user'`).
          const { error } = await supabase
            .from("item_categories")
            .upsert(rows, { onConflict: "item_key", ignoreDuplicates: true });
          if (error) falhas.push(`Não foi possível salvar o cache de categorias: ${error.message}`);
        }
      } catch (err) {
        falhas.push(`Categorização por IA indisponível: ${errMsg(err)}`);
      }
    }
  }

  // ---- 3. Aplica nos itens do household ----
  try {
    await applyToListItems(supabase, householdId, resolved);
  } catch (err) {
    falhas.push(`Não foi possível atualizar os itens da lista: ${errMsg(err)}`);
  }

  // ---- 4. Resposta: resolvidos + DEFAULT_CATEGORY para o resto ----
  for (const nome of nomes) {
    const key = keyOf.get(nome) ?? "";
    categorias[nome] = resolved.get(key) ?? DEFAULT_CATEGORY;
  }
  return Response.json({ ok: true, categorias, ...(falhas.length > 0 ? { falhas } : {}) });
}
