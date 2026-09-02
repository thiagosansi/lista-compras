import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchNfce, NfceFetchError } from "@/lib/nfce/fetch";
import { NfceParseError } from "@/lib/nfce/parse";
import { collectProductSeeds, buildReceiptItemInserts, buildPriceObservationInserts } from "@/lib/nfce/seed";
import { findProductsByGtins } from "@/lib/products/server";

export const runtime = "nodejs";

type ImportResponse =
  | { ok: false; error: string }
  | {
      ok: true;
      receipt: {
        id: string;
        store: { name: string; cnpj: string | null };
        issuedAt: string | null;
        total: number | null;
        items: {
          description: string;
          gtin: string | null;
          quantity: number;
          unit: string | null;
          unitPrice: number;
          total: number;
        }[];
      };
      avisos?: string[];
    };

function fail(error: string, status: number) {
  return NextResponse.json<ImportResponse>({ ok: false, error }, { status });
}

/** POST /api/nfce/importar — body `{ url }` com o conteúdo do QR code do cupom (Sefaz-BA). */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("Corpo da requisição inválido.", 400);
  }
  const url = typeof body === "object" && body !== null ? (body as { url?: unknown }).url : undefined;
  if (typeof url !== "string" || !url.trim() || url.length > 1000) {
    return fail("Informe o link do QR code do cupom.", 400);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Não autenticado.", 401);

  const { data: membership } = await supabase
    .from("household_members")
    .select("household_id")
    .eq("user_id", user.id)
    .order("joined_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!membership) return fail("Você ainda não faz parte de uma casa.", 403);
  const householdId = membership.household_id;

  // 1) Baixa e interpreta o cupom na Sefaz-BA.
  let fetched: Awaited<ReturnType<typeof fetchNfce>>;
  try {
    fetched = await fetchNfce(url);
  } catch (err) {
    if (err instanceof NfceFetchError) return fail(err.message, err.status);
    if (err instanceof NfceParseError) return fail(err.message, 422);
    console.error("[nfce/importar] fetch", err);
    return fail("Não foi possível ler o cupom na Sefaz-BA.", 502);
  }
  const { receipt: parsed, sourceUrl } = fetched;

  // 2) Já importado? (RLS limita ao household; a unique global é tratada no insert.)
  const { data: existing } = await supabase.from("receipts").select("id").eq("access_key", parsed.accessKey).maybeSingle();
  if (existing) return fail("Cupom já importado", 409);

  // 3) Loja (catálogo compartilhado, upsert por CNPJ).
  const { data: store, error: storeError } = await supabase
    .from("stores")
    .upsert(
      { cnpj: parsed.store.cnpj, name: parsed.store.name, address: parsed.store.address, city: parsed.store.city },
      { onConflict: "cnpj" },
    )
    .select("id, name, cnpj")
    .single();
  if (storeError || !store) {
    console.error("[nfce/importar] stores", storeError);
    return fail("Não foi possível salvar a loja.", 500);
  }

  // 4) Cupom.
  const { data: receipt, error: receiptError } = await supabase
    .from("receipts")
    .insert({
      household_id: householdId,
      store_id: store.id,
      access_key: parsed.accessKey,
      issued_at: parsed.issuedAt,
      total: parsed.total,
      item_count: parsed.items.length,
      source_url: sourceUrl,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (receiptError || !receipt) {
    if (receiptError?.code === "23505") return fail("Cupom já importado", 409);
    console.error("[nfce/importar] receipts", receiptError);
    return fail("Não foi possível salvar o cupom.", 500);
  }

  // 5) Semeia o catálogo de produtos com os itens que têm GTIN válido (não bloqueia a importação em caso de falha).
  const avisos: string[] = [];
  const productIdByGtin = new Map<string, string>();
  const productSeeds = collectProductSeeds(parsed.items);
  if (productSeeds.length > 0) {
    try {
      // `ignoreDuplicates: true` evita sobrescrever `name`/`category` de produtos já cadastrados.
      const { error: seedError } = await supabase
        .from("products")
        .upsert(productSeeds, { onConflict: "gtin", ignoreDuplicates: true });
      if (seedError) throw new Error(seedError.message);
      const products = await findProductsByGtins(supabase, productSeeds.map((p) => p.gtin));
      for (const p of products) productIdByGtin.set(p.gtin, p.id);
    } catch (err) {
      console.error("[nfce/importar] products seed", err);
      avisos.push("Não foi possível vincular os produtos do cupom ao catálogo.");
    }
  }

  // 6) Itens + observações de preço. Em caso de falha, remove o cupom (cascade) para não deixar dados pela metade.
  const rollback = async () => {
    await supabase.from("receipts").delete().eq("id", receipt.id);
  };

  const { data: items, error: itemsError } = await supabase
    .from("receipt_items")
    .insert(buildReceiptItemInserts(parsed.items, receipt.id, productIdByGtin))
    .select("id, position");
  if (itemsError || !items) {
    console.error("[nfce/importar] receipt_items", itemsError);
    await rollback();
    return fail("Não foi possível salvar os itens do cupom.", 500);
  }

  const receiptItemIdByPosition = new Map(items.map((i) => [i.position, i.id] as const));
  const observedAt = parsed.issuedAt ?? new Date().toISOString();
  const observations = buildPriceObservationInserts(parsed.items, {
    householdId,
    storeId: store.id,
    observedAt,
    receiptItemIdByPosition,
    productIdByGtin,
  });

  if (observations.length > 0) {
    const { error: obsError } = await supabase.from("price_observations").insert(observations);
    if (obsError) {
      console.error("[nfce/importar] price_observations", obsError);
      await rollback();
      return fail("Não foi possível registrar os preços do cupom.", 500);
    }
  }

  return NextResponse.json<ImportResponse>({
    ok: true,
    receipt: {
      id: receipt.id,
      store: { name: store.name, cnpj: store.cnpj },
      issuedAt: parsed.issuedAt,
      total: parsed.total,
      items: parsed.items.map((item) => ({
        description: item.description,
        gtin: item.gtin,
        quantity: item.quantity,
        unit: item.unit,
        unitPrice: item.unitPrice,
        total: item.total,
      })),
    },
    ...(avisos.length > 0 ? { avisos } : {}),
  });
}
