// GET /api/produtos/[gtin]?storeId= — consulta de produto por código de barras (modo Compras, fase 5).
// Procura em `products`; se não existir, busca no Preço da Hora por GTIN (raio 30 km, 30 dias), cria o produto com a
// descrição do primeiro resultado e grava as observações como `precodahora`. `precoSugerido` = observação mais recente
// (na loja informada, se houver; senão em qualquer loja). Resposta `{ ok: true, ...ProductLookup }`.

import type { ProductLookup } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";
import { PdhError, searchPrecoDaHora } from "@/lib/precodahora/client";
import {
  findProductByGtin,
  getHousehold,
  parseGtin,
  recordPdhObservations,
  suggestedPrice,
  upsertProductsByGtin,
  type ProductLite,
} from "@/lib/products/server";

export const runtime = "nodejs";
export const maxDuration = 30;

const SALVADOR_CENTRO = { lat: -12.9777, lng: -38.5016 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(error: string, status: number) {
  return Response.json({ ok: false, error }, { status });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function GET(request: Request, { params }: { params: Promise<{ gtin: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Não autenticado", 401);

  const gtin = parseGtin((await params).gtin);
  if (!gtin) return fail("GTIN inválido (esperado 8 a 14 dígitos)", 400);

  const storeIdRaw = new URL(request.url).searchParams.get("storeId")?.trim() ?? "";
  if (storeIdRaw && !UUID_RE.test(storeIdRaw)) return fail("`storeId` inválido", 400);
  const storeId = storeIdRaw || null;

  let household: { id: string; lat: number | null; lng: number | null };
  try {
    const h = await getHousehold(supabase, user.id);
    if (!h) return fail("Você ainda não faz parte de uma casa", 403);
    household = h;
  } catch (err) {
    return fail(`Erro ao carregar a casa: ${errMsg(err)}`, 500);
  }

  let product: ProductLite | null;
  try {
    product = await findProductByGtin(supabase, gtin);
  } catch (err) {
    return fail(`Erro ao consultar o catálogo: ${errMsg(err)}`, 500);
  }

  let aviso: string | undefined;
  if (!product) {
    try {
      const resultados = await searchPrecoDaHora({
        gtin,
        lat: household.lat ?? SALVADOR_CENTRO.lat,
        lng: household.lng ?? SALVADOR_CENTRO.lng,
        raioKm: 30,
        horas: 720,
        maxResultados: 25,
      });
      if (resultados.length > 0) {
        // O Preço da Hora pode devolver o gtin sem zero à esquerda; gravamos o pedido (já validado).
        const withGtin = resultados.map((r) => ({ ...r, gtin }));
        const [created] = await upsertProductsByGtin(supabase, [{ gtin, name: resultados[0].descricao }]);
        product = created ?? (await findProductByGtin(supabase, gtin));
        try {
          await recordPdhObservations(supabase, household.id, withGtin);
        } catch (err) {
          console.warn("[api/produtos/[gtin]] observações:", errMsg(err));
        }
      }
    } catch (err) {
      if (err instanceof PdhError) {
        aviso = err.blocked
          ? "Preço da Hora limitou as consultas por agora; produto não encontrado no catálogo local."
          : `Preço da Hora indisponível: ${err.message}`;
      } else {
        console.error("[api/produtos/[gtin]]", err);
        aviso = `Erro ao consultar o Preço da Hora: ${errMsg(err)}`;
      }
    }
  }

  let precoSugerido: ProductLookup["precoSugerido"] = null;
  try {
    precoSugerido = await suggestedPrice(supabase, gtin, storeId);
  } catch (err) {
    console.warn("[api/produtos/[gtin]] preço sugerido:", errMsg(err));
  }

  const lookup: ProductLookup = {
    produto: product ? { gtin: product.gtin, descricao: product.name, categoria: product.category } : null,
    precoSugerido,
  };
  return Response.json({ ok: true, ...lookup, ...(aviso ? { aviso } : {}) });
}
