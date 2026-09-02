"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { normalizeName } from "@/lib/normalize";
import type { ProductSuggestion } from "@/lib/database.types";

const MIN_LOCAL_CHARS = 3;
const LOCAL_DEBOUNCE_MS = 250;
const EXTERNAL_EVERY_N_CHARS = 5;
const MAX_SUGGESTIONS = 8;
/** Abaixo disso o catálogo local já não é considerado suficiente: vale a pena consultar a fonte externa. */
const LOCAL_SUFFICIENT_THRESHOLD = 3;

type SugerirResponse = {
  ok?: boolean;
  sugestoes?: ProductSuggestion[];
  fonteExterna?: boolean;
  aviso?: string;
  motivo?: string;
};

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

/** União por gtin de duas listas de sugestões externas, preservando a ordem (`a` primeiro). */
function unionByGtin(a: ProductSuggestion[], b: ProductSuggestion[]): ProductSuggestion[] {
  const seen = new Set(a.map((s) => s.gtin));
  const extra = b.filter((s) => s.gtin && !seen.has(s.gtin));
  return [...a, ...extra];
}

/**
 * Sugestões de produto para o campo de adicionar.
 * - LOCAL: `products` via client Supabase a partir de 3 caracteres, debounce 250 ms, descarta respostas obsoletas.
 * - EXTERNA (automática): `POST /api/produtos/sugerir` só quando `texto.length` é múltiplo de 5 (espaço conta), o
 *   texto mudou desde a última consulta E a busca LOCAL atual (já assentada para esse texto) tem menos de 3
 *   resultados — regra de suficiência local: com 3+ locais não vale gastar o limite do Preço da Hora. A decisão
 *   espera a resposta local pendente do mesmo texto; se o usuário continuou digitando enquanto isso, é descartada
 *   (o efeito reage a `localSettledKey`, então só decide quando os locais estiverem em dia com o texto atual).
 * - `buscarMais()`: escape manual — chama a rota com `forcarExterno: true` para o texto atual (ignora a regra de
 *   suficiência) e mescla o resultado às externas já carregadas.
 * A última resposta externa fica em memória e é filtrada por palavras enquanto o usuário digita entre múltiplos
 * de 5. Nunca lança: falha externa → só local.
 */
export function useProductSuggestions(texto: string) {
  const [locais, setLocais] = useState<ProductSuggestion[]>([]);
  const [externas, setExternas] = useState<ProductSuggestion[]>([]);
  const [fonteExterna, setFonteExterna] = useState(false);
  const [carregandoLocal, setCarregandoLocal] = useState(false);
  const [carregandoExterno, setCarregandoExterno] = useState(false);
  const [buscandoMais, setBuscandoMais] = useState(false);
  const [avisoBuscarMais, setAvisoBuscarMais] = useState<string | null>(null);
  /** Chave local (`chaveLocal`) para a qual `locais` está garantidamente em dia. */
  const [localSettledKey, setLocalSettledKey] = useState<string>("");

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
        setLocalSettledKey(chaveLocal);
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
        if (seq === localSeq.current) {
          setCarregandoLocal(false);
          setLocalSettledKey(chaveLocal);
        }
      }
    }, LOCAL_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [curto, chaveLocal]);

  // Consulta EXTERNA automática só em múltiplos de 5 caracteres (espaço conta), quando o texto mudou e — regra de
  // suficiência local — a busca local ATUAL (já assentada, `localSettledKey === chaveLocal`) tem menos de 3
  // resultados. Se o usuário continuar digitando antes dos locais assentarem, este efeito roda de novo com o
  // texto novo e a decisão anterior é descartada (nada foi disparado ainda).
  useEffect(() => {
    const len = texto.length;
    if (len < EXTERNAL_EVERY_N_CHARS || len % EXTERNAL_EVERY_N_CHARS !== 0) return;
    if (texto === lastExternalTerm.current) return;
    if (wordsOf(texto).length === 0) return;
    if (localSettledKey !== chaveLocal) return; // aguarda a busca local do texto atual assentar
    if (locais.length >= LOCAL_SUFFICIENT_THRESHOLD) {
      // Catálogo local já basta: não gasta o limite do Preço da Hora. Marca como decidido para este texto exato.
      lastExternalTerm.current = texto;
      return;
    }
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
  }, [texto, chaveLocal, localSettledKey, locais]);

  // Filtra as externas em memória pelas palavras do texto atual.
  const externasFiltradas = useMemo(() => {
    if (palavras.length === 0) return [];
    return externas.filter((s) => {
      const desc = normalizeName(s.descricao);
      return palavras.every((w) => desc.includes(w));
    });
  }, [externas, palavras]);

  const sugestoes = useMemo(() => (curto ? [] : merge(locais, externasFiltradas)), [curto, locais, externasFiltradas]);

  /** Escape manual: consulta a rota com `forcarExterno: true` para o texto atual e mescla o resultado. */
  async function buscarMais(): Promise<void> {
    const atual = termo;
    if (atual.length < EXTERNAL_EVERY_N_CHARS) return;
    const seq = ++externalSeq.current;
    setBuscandoMais(true);
    setAvisoBuscarMais(null);
    try {
      const res = await fetch("/api/produtos/sugerir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ termo: atual, forcarExterno: true }),
      });
      if (seq !== externalSeq.current) return;
      if (!res.ok) {
        setAvisoBuscarMais("Não foi possível buscar mais produtos agora.");
        return;
      }
      const json = (await res.json()) as SugerirResponse;
      if (seq !== externalSeq.current) return;
      if (json.ok && Array.isArray(json.sugestoes)) {
        const validas = json.sugestoes.filter((s) => s && typeof s.gtin === "string" && s.gtin.length > 0);
        setExternas((prev) => unionByGtin(prev, validas));
        setFonteExterna(Boolean(json.fonteExterna));
      }
      if (json.aviso) setAvisoBuscarMais(json.aviso);
    } catch {
      if (seq === externalSeq.current) setAvisoBuscarMais("Não foi possível buscar mais produtos agora.");
    } finally {
      if (seq === externalSeq.current) setBuscandoMais(false);
    }
  }

  return {
    sugestoes,
    carregando: !curto && (carregandoLocal || carregandoExterno),
    fonteExterna,
    buscarMais,
    buscandoMais,
    avisoBuscarMais,
  };
}
