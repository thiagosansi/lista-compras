"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { normalizeName } from "@/lib/normalize";
import type { ProductSuggestion } from "@/lib/database.types";

const MIN_LOCAL_CHARS = 3;
const LOCAL_DEBOUNCE_MS = 250;
const EXTERNAL_EVERY_N_CHARS = 5;
const MAX_SUGGESTIONS = 8;

type SugerirResponse = { ok?: boolean; sugestoes?: ProductSuggestion[]; fonteExterna?: boolean };

/** Termos (palavras normalizadas) do texto; vazio se não houver nada útil. */
function wordsOf(text: string): string[] {
  return normalizeName(text).split(" ").filter(Boolean);
}

/** Mescla: externas com última compra → locais → demais externas. Dedup por gtin, máx. 8. */
function merge(locais: ProductSuggestion[], externas: ProductSuggestion[]): ProductSuggestion[] {
  const seen = new Set<string>();
  const out: ProductSuggestion[] = [];
  const push = (s: ProductSuggestion) => {
    if (!s.gtin || seen.has(s.gtin) || out.length >= MAX_SUGGESTIONS) return;
    seen.add(s.gtin);
    out.push(s);
  };
  externas.filter((s) => s.ultimaCompra).forEach(push);
  locais.forEach(push);
  externas.forEach(push);
  return out;
}

/**
 * Sugestões de produto para o campo de adicionar.
 * - LOCAL: `products` via client Supabase a partir de 3 caracteres, debounce 250 ms, descarta respostas obsoletas.
 * - EXTERNA: `POST /api/produtos/sugerir` só quando `texto.length` é múltiplo de 5 (espaço conta) e o texto mudou
 *   desde a última consulta. A última resposta fica em memória e é filtrada por palavras enquanto o usuário digita.
 * Nunca lança: falha externa → só local.
 */
export function useProductSuggestions(texto: string) {
  const [locais, setLocais] = useState<ProductSuggestion[]>([]);
  const [externas, setExternas] = useState<ProductSuggestion[]>([]);
  const [fonteExterna, setFonteExterna] = useState(false);
  const [carregandoLocal, setCarregandoLocal] = useState(false);
  const [carregandoExterno, setCarregandoExterno] = useState(false);

  const localSeq = useRef(0);
  const externalSeq = useRef(0);
  const lastExternalTerm = useRef<string | null>(null);

  const termo = texto.trim();
  const palavras = useMemo(() => wordsOf(termo), [termo]);
  const chaveLocal = palavras.join(" ");
  const curto = termo.length < MIN_LOCAL_CHARS;

  // Busca LOCAL (debounce 250 ms; resultados obsoletos são descartados pelo contador).
  useEffect(() => {
    const seq = ++localSeq.current;
    const palavras = chaveLocal.split(" ").filter(Boolean);
    if (curto || palavras.length === 0) {
      const t = window.setTimeout(() => {
        if (seq !== localSeq.current) return;
        setLocais([]);
        setCarregandoLocal(false);
      }, 0);
      return () => window.clearTimeout(t);
    }

    const timer = window.setTimeout(async () => {
      if (seq !== localSeq.current) return;
      setCarregandoLocal(true);
      try {
        const supabase = createClient();
        let query = supabase.from("products").select("gtin, name, category").not("gtin", "is", null);
        for (const w of palavras) query = query.ilike("normalized_name", `%${w}%`);
        const { data, error } = await query.limit(MAX_SUGGESTIONS);
        if (seq !== localSeq.current) return;
        if (error || !data) {
          setLocais([]);
        } else {
          setLocais(
            data
              .filter((p): p is typeof p & { gtin: string } => typeof p.gtin === "string" && p.gtin.length > 0)
              .map((p) => ({ gtin: p.gtin, descricao: p.name, categoria: p.category, origem: "local" as const })),
          );
        }
      } catch {
        if (seq === localSeq.current) setLocais([]);
      } finally {
        if (seq === localSeq.current) setCarregandoLocal(false);
      }
    }, LOCAL_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [curto, chaveLocal]);

  // Consulta EXTERNA só em múltiplos de 5 caracteres (espaço conta) e quando o texto mudou.
  useEffect(() => {
    const len = texto.length;
    if (len < EXTERNAL_EVERY_N_CHARS || len % EXTERNAL_EVERY_N_CHARS !== 0) return;
    if (texto === lastExternalTerm.current) return;
    if (wordsOf(texto).length === 0) return;
    lastExternalTerm.current = texto;

    const seq = ++externalSeq.current;
    const controller = new AbortController();

    (async () => {
      setCarregandoExterno(true);
      try {
        const res = await fetch("/api/produtos/sugerir", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ termo: texto }),
          signal: controller.signal,
        });
        if (seq !== externalSeq.current) return;
        if (!res.ok) return;
        const json = (await res.json()) as SugerirResponse;
        if (seq !== externalSeq.current) return;
        if (json.ok && Array.isArray(json.sugestoes)) {
          setExternas(json.sugestoes.filter((s) => s && typeof s.gtin === "string" && s.gtin.length > 0));
          setFonteExterna(Boolean(json.fonteExterna));
        }
      } catch {
        // Erro/abort → mantém o que já tinha (só local).
      } finally {
        if (seq === externalSeq.current) setCarregandoExterno(false);
      }
    })();

    return () => controller.abort();
  }, [texto]);

  // Filtra as externas em memória pelas palavras do texto atual.
  const externasFiltradas = useMemo(() => {
    if (palavras.length === 0) return [];
    return externas.filter((s) => {
      const desc = normalizeName(s.descricao);
      return palavras.every((w) => desc.includes(w));
    });
  }, [externas, palavras]);

  const sugestoes = useMemo(() => (curto ? [] : merge(locais, externasFiltradas)), [curto, locais, externasFiltradas]);

  return {
    sugestoes,
    carregando: !curto && (carregandoLocal || carregandoExterno),
    fonteExterna,
  };
}
