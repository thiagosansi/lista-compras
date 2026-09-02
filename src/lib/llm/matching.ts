// Correspondência inteligente item ↔ descrição do Preço da Hora usando o Groq (ver SPEC-fase4.md).
// Duas etapas: `planSearches` (termo de busca + palavras que desqualificam, uma chamada para todos os
// itens) e `judgeMatches` (juiz de correspondência, uma chamada por item). Ambas validam o shape da
// resposta e descartam entradas inválidas; nunca inventam nada além do que o modelo devolveu.

import { normalizeName } from "@/lib/normalize";
import { chatJsonWithMeta, type LlmUsage } from "@/lib/llm/groq";
import { diceSimilarity } from "@/lib/llm/similarity";

/** Máximo de descrições distintas enviadas ao juiz numa chamada. */
export const MAX_CANDIDATES = 40;

/**
 * Esforço de raciocínio pedido ao modelo. No plano gratuito do Groq (8k tokens/min, contando
 * prompt + max_tokens), os tokens de raciocínio são o que mais pesa. `GROQ_REASONING_EFFORT`
 * permite ajustar por ambiente/modelo sem mudar código.
 */
type ReasoningEffort = "none" | "default" | "low" | "medium" | "high";
function reasoningEffort(fallback: ReasoningEffort): ReasoningEffort | undefined {
  const v = process.env.GROQ_REASONING_EFFORT?.trim();
  if (v === "none" || v === "default" || v === "low" || v === "medium" || v === "high") return v;
  if (v === "model") return undefined;
  return fallback;
}
const MAX_ITEMS_PER_PLAN = 60;
const MAX_EXCLUDE_WORDS = 14;

export type SearchPlan = { termo: string; excluir: string[]; observacao?: string };

/**
 * Grupos de palavras que desqualificam qualquer item de mercearia, aplicados sempre — cada grupo é pulado
 * se o próprio item contém uma palavra dele (ex.: "ração para gatos", "bala de café"). Rede de segurança
 * determinística: o modelo às vezes esquece essas palavras (a saída varia entre chamadas mesmo em temperature 0).
 */
export const UNIVERSAL_EXCLUDE_GROUPS: readonly (readonly string[])[] = [
  // uso animal
  ["racao", "caes", "cao", "cachorro", "cachorros", "gato", "gatos", "pet", "puppy", "canino", "felino"],
  // doces "sabor X" que aparecem baratos para café, leite, manteiga, coco…
  ["bala", "balas", "caramelo", "bombom", "pirulito", "chiclete"],
];

/**
 * Sanitiza a lista de exclusões: descarta entradas que compartilham alguma palavra com o termo de busca
 * ou com o nome do item (o modelo já devolveu "papel higienico" como exclusão de "papel higiênico"…) e
 * acrescenta os grupos universais.
 */
function sanitizeExclusions(itemName: string, termo: string, excluir: string[]): string[] {
  const ownTokens = new Set(`${normalizeName(itemName)} ${normalizeName(termo)}`.split(" ").filter(Boolean));
  const out: string[] = [];
  for (const e of excluir) {
    const tokens = e.split(" ").filter(Boolean);
    if (tokens.length === 0 || tokens.some((t) => ownTokens.has(t))) continue;
    if (!out.includes(e)) out.push(e);
  }
  for (const group of UNIVERSAL_EXCLUDE_GROUPS) {
    if (group.some((w) => ownTokens.has(w))) continue;
    for (const w of group) if (!out.includes(w)) out.push(w);
  }
  return out;
}
export type PlanItem = { id: string; name: string };

export type MatchCandidate = { description: string; gtin: string | null; price?: number };
export type MatchVerdict = { description: string; isMatch: boolean; reason: string };

/** Métricas da última chamada (para logs/avaliação); zeradas a cada chamada. */
export type MatchingMeta = { usage: LlmUsage };

// ---------------------------------------------------------------------------
// planSearches
// ---------------------------------------------------------------------------

const PLAN_SYSTEM = `Você ajuda um app de lista de compras a buscar preços no "Preço da Hora Bahia", um site que devolve descrições de cupons fiscais de supermercados (texto em maiúsculas, abreviado, ex.: "LEITE INTEGRAL ITAMBE 1L", "ARROZ TIPO 1 CAMIL 5KG", "CAFE TORRADO E MOIDO 3 CORACOES 500G", "PAPEL HIGIENICO OLE 12 ROLOS").

Como a busca do site funciona (importante para escolher o termo):
- Busca textual: cada palavra do termo precisa aparecer na descrição como trecho de texto (sem acento, maiúsculas/minúsculas não importam). "5kg" casa com "5KG" mas NÃO com "5 KG"; "500g" casa com "500G" e "1500G".
- Os resultados vêm ordenados do MAIS BARATO para o mais caro e só os 60 primeiros são lidos. Um termo genérico ("arroz", "cafe") traz primeiro balas, sachês e ração baratos e o produto de verdade fica de fora. Por isso o termo precisa ser específico o bastante para que o produto certo esteja entre os 60 mais baratos.

Para cada item que o usuário digitou, produza:
- "termo": 1 a 3 palavras, sem acento. Regras:
  a) Use o nome do produto como aparece nos cupons (ex.: "papel higienico", "leite integral", "acucar refinado", "cafe").
  b) Se o usuário informou peso/volume, INCLUA no termo em forma compacta, sem espaço e sem ponto: "5kg", "500g", "1l", "2l", "900ml". Se informou contagem (rolos, unidades, pacotes), inclua só o número: "papel higienico 12" (casa com "12 ROLOS", "12 RL", "12/11").
  c) Se o usuário escreveu marca, inclua a marca. Se não, não invente marca.
  d) Não inclua palavras que muitas descrições omitem (ex.: "tipo 1", "torrado", "longa vida"), senão perde resultados.
- "excluir": palavras (minúsculas, sem acento, uma palavra por entrada) que, se aparecerem na descrição, indicam OUTRO produto. Pense nos falsos positivos baratos que vão aparecer para aquele termo:
  · uso animal: "racao", "caes", "cao", "cachorro", "gato", "gatos", "pet", "puppy" (para grãos, arroz, leite, biscoito);
  · doces e derivados: "bala", "balas", "caramelo", "bombom", "biscoito", "pirulito", "chiclete" (para café, leite, manteiga, coco…);
  · variantes que não são o produto: café → "milho", "cevada", "soluvel", "capsula", "capsulas", "cappuccino", "filtro"; leite integral → "po", "condensado", "coco", "fermentado", "soja", "achocolatado"; manteiga → "margarina", "cacau", "karite", "amendoim"; arroz → "farinha", "creme"; papel higiênico → "toalha", "guardanapo", "lenco".
  NÃO exclua palavras que fazem parte do próprio produto nem palavras genéricas que aparecem em descrições legítimas (ex.: para leite não exclua "1l", "caixa", "uht"; para arroz não exclua "parboilizado", "integral" a menos que o usuário tenha pedido outro tipo). No máximo 12 palavras.
- "observacao" (opcional): uma frase curta se houver ambiguidade relevante no que o usuário escreveu.

Regras de saída:
- Responda SOMENTE com JSON no formato {"itens":[{"id":"...","termo":"...","excluir":["..."],"observacao":"..."}]}.
- Exatamente um objeto por item, com o mesmo "id" recebido. Não invente itens.`;

type RawPlanResponse = { itens?: unknown };

function asStringArray(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const w of v) {
    if (typeof w !== "string") continue;
    const n = normalizeName(w);
    if (!n || out.includes(n)) continue;
    out.push(n);
    if (out.length >= max) break;
  }
  return out;
}

function cleanTerm(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.replace(/\s+/g, " ").trim().slice(0, 80);
}

/**
 * Uma chamada ao modelo para todos os itens. Devolve um mapa id → plano; itens que o modelo
 * não devolveu (ou devolveu inválidos) ficam de fora — o chamador aplica o fallback.
 * Lança `LlmError` se a chamada falhar por completo.
 */
export async function planSearches(items: PlanItem[], meta?: MatchingMeta): Promise<Record<string, SearchPlan>> {
  const out: Record<string, SearchPlan> = {};
  const valid = items.filter((i) => typeof i.id === "string" && i.id && typeof i.name === "string" && i.name.trim());
  if (valid.length === 0) return out;

  const byId = new Map(valid.slice(0, MAX_ITEMS_PER_PLAN).map((i) => [i.id, i] as const));
  const userPayload = { itens: [...byId.values()].map((i) => ({ id: i.id, nome: i.name.trim() })) };

  const { data, usage } = await chatJsonWithMeta<RawPlanResponse>({
    system: PLAN_SYSTEM,
    user: `Itens da lista (JSON):\n${JSON.stringify(userPayload)}\n\nResponda com o JSON no formato pedido.`,
    temperature: 0,
    maxTokens: 2500,
    reasoningEffort: reasoningEffort("low"),
  });
  if (meta) meta.usage = usage;

  const rows = Array.isArray(data?.itens) ? data.itens : [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : typeof r.id === "number" ? String(r.id) : "";
    const item = byId.get(id);
    if (!item || out[id]) continue;
    const termo = cleanTerm(r.termo);
    if (!termo) continue;
    const plan: SearchPlan = { termo, excluir: sanitizeExclusions(item.name, termo, asStringArray(r.excluir, MAX_EXCLUDE_WORDS)) };
    const observacao = cleanTerm(r.observacao);
    if (observacao) plan.observacao = observacao.slice(0, 200);
    out[id] = plan;
  }
  return out;
}

// ---------------------------------------------------------------------------
// judgeMatches
// ---------------------------------------------------------------------------

const JUDGE_SYSTEM = `Você é o juiz de correspondência de um app de lista de compras. O usuário escreveu um item da lista; um site de preços devolveu descrições REAIS de cupons fiscais de supermercados (maiúsculas, abreviadas, às vezes com marca, peso e embalagem). Para cada descrição, diga se ela É o produto que o usuário quer comprar.

Critérios, nesta ordem:
1. Mesmo TIPO de produto (o mais importante). NÃO corresponde quando é outro produto da mesma família:
   - "leite integral" (líquido, UHT/pasteurizado) NÃO é leite em pó (atenção: leite integral vendido em GRAMAS — 120G, 200G, 400G, 800G — ou "sachê", "lata", "instantâneo" é leite em pó), nem condensado, de coco, fermentado, bebida láctea, soja/aveia/amêndoas, achocolatado, creme de leite, composto lácteo, iogurte.
   - "arroz" NÃO é ração ou arroz para cães/gatos ("P/ CAES", "P CAO", "PUPPY", "PET", "QUIRERA", "FORA DO TIPO" = uso animal; marcas de arroz para cães comuns na Bahia: MATILHA, BONE, AMIGACO, PUPPY, PARBOR), farinha/creme de arroz, biscoito de arroz, bebida de arroz, arroz doce pronto.
   - "café" NÃO é café de milho, cevada, café solúvel, cápsulas, cappuccino, filtro/coador, bala/caramelo/bombom de café, a menos que o usuário tenha pedido isso.
   - "manteiga" NÃO é margarina, creme vegetal, manteiga de cacau/karité/amendoim, requeijão, manteiga de garrafa (só se pedido).
   - "papel higiênico" NÃO é papel toalha, lenço, guardanapo, fralda, absorvente.
   - Itens de serviço/lanchonete ("ADICIONAL", "COPO", "PORÇÃO", "DOSE") e descrições que não deixam claro o tipo de produto (só código, só marca) → NÃO corresponde.
2. Tamanho/embalagem COMPATÍVEL. Se o usuário escreveu quantidade/peso/volume ("5kg", "500g", "1L", "12 rolos"), a descrição precisa indicar o mesmo tamanho (aceite abreviações: 5KG = 5 KG = 5000G; 500G = 500 GR; 1L = 1LT = 1000ML; 12 ROLOS = C/12 = 12UN = L12P11) ou não indicar tamanho algum (aceite). Tamanho diferente → NÃO corresponde. Se o usuário não escreveu tamanho, qualquer tamanho serve.
3. Marca: só importa se o usuário escreveu marca. Sem marca no item, qualquer marca serve.
4. Variante: se o usuário especificou ("integral", "desnatado", "parboilizado", "torrado e moído", "folha dupla"), a descrição precisa ser da mesma variante (leite desnatado/semidesnatado NÃO é "leite integral"). Se não especificou, qualquer variante do mesmo produto serve (para "arroz": tipo 1, tipo 2, parboilizado, integral; para "café" sem qualificador: torrado e moído; para "papel higiênico": folha simples ou dupla).
5. Preço como pista: cada descrição vem com o menor preço encontrado (R$). Um preço muito abaixo do normal para aquele produto e tamanho em supermercado brasileiro (ex.: arroz 5 kg por menos de R$ 15, leite 1 L por menos de R$ 3, café 500 g por menos de R$ 10) indica outro produto (uso animal, doce, unidade/porção, "fora do tipo") — rejeite se a descrição não deixar claro que é o produto certo.
6. Na dúvida sobre o TIPO de produto, rejeite. Na dúvida sobre tamanho porque a descrição não informa, aceite.

Responda SOMENTE com JSON compacto no formato:
{"resultados":[{"n":1,"corresponde":true,"motivo":"..."}]}
"n" é o número da descrição recebida. "motivo": no máximo 6 palavras em português (ex.: "leite em pó", "tamanho 1kg, pedido 5kg", "ok"). Inclua TODAS as descrições recebidas, uma vez cada, na mesma ordem. Não invente descrições.`;

type RawJudgeResponse = { resultados?: unknown };

function toBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "sim") return true;
    if (s === "false" || s === "nao" || s === "não") return false;
  }
  return null;
}

/** Deduplica por chave normalizada e, se passar do limite, prioriza os mais baratos e os mais parecidos. */
export function selectCandidates(itemName: string, candidates: MatchCandidate[], limit = MAX_CANDIDATES): MatchCandidate[] {
  const distinct = new Map<string, MatchCandidate>();
  for (const c of candidates) {
    if (!c || typeof c.description !== "string") continue;
    const key = normalizeName(c.description);
    if (!key) continue;
    const prev = distinct.get(key);
    if (!prev) {
      distinct.set(key, { ...c });
    } else {
      if (prev.gtin == null && c.gtin) prev.gtin = c.gtin;
      if (typeof c.price === "number" && (typeof prev.price !== "number" || c.price < prev.price)) prev.price = c.price;
    }
  }
  const all = [...distinct.values()];
  if (all.length <= limit) return all;

  const chosen = new Set<MatchCandidate>();
  const cheapest = all
    .filter((c) => typeof c.price === "number" && Number.isFinite(c.price))
    .sort((a, b) => (a.price as number) - (b.price as number));
  for (const c of cheapest) {
    if (chosen.size >= Math.floor(limit / 2)) break;
    chosen.add(c);
  }
  const bySimilarity = all
    .map((c) => ({ c, s: diceSimilarity(itemName, c.description) }))
    .sort((a, b) => b.s - a.s);
  for (const { c } of bySimilarity) {
    if (chosen.size >= limit) break;
    chosen.add(c);
  }
  // Mantém a ordem original (que vem por preço crescente do Preço da Hora).
  return all.filter((c) => chosen.has(c));
}

/**
 * Uma chamada ao modelo para um item. Devolve um veredicto por descrição reconhecida
 * (descrições que o modelo não devolveu ou devolveu inválidas ficam sem veredicto).
 * Lança `LlmError` se a chamada falhar por completo.
 */
export async function judgeMatches(
  item: { name: string },
  candidates: MatchCandidate[],
  meta?: MatchingMeta,
): Promise<MatchVerdict[]> {
  const name = item.name.replace(/\s+/g, " ").trim();
  const selected = selectCandidates(name, candidates);
  if (!name || selected.length === 0) return [];

  // Lista numerada com o menor preço (sem GTIN: o juiz decide pelo texto e o token custa caro no plano gratuito).
  const list = selected
    .map((c, i) => `${i + 1}. ${c.description}${typeof c.price === "number" ? ` — R$ ${c.price.toFixed(2)}` : ""}`)
    .join("\n");
  const user = `Item da lista: "${name}"\n\nDescrições encontradas (${selected.length}):\n${list}\n\nResponda com o JSON no formato pedido, com um resultado para cada uma das ${selected.length} descrições.`;

  const { data, usage } = await chatJsonWithMeta<RawJudgeResponse>({
    system: JUDGE_SYSTEM,
    user,
    temperature: 0,
    maxTokens: 2500,
    reasoningEffort: reasoningEffort("low"),
  });
  if (meta) meta.usage = usage;

  const byKey = new Map<string, MatchCandidate>();
  for (const c of selected) byKey.set(normalizeName(c.description), c);

  const out: MatchVerdict[] = [];
  const done = new Set<string>();
  const rows = Array.isArray(data?.resultados) ? data.resultados : [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const corresponde = toBool(r.corresponde);
    if (corresponde === null) continue;

    // Identifica o candidato pelo índice `n` ou, se não bater, pela descrição (chave normalizada).
    let candidate: MatchCandidate | undefined;
    const n = typeof r.n === "number" ? r.n : typeof r.n === "string" ? Number(r.n) : NaN;
    if (Number.isInteger(n) && n >= 1 && n <= selected.length) candidate = selected[n - 1];
    if (!candidate && typeof r.descricao === "string") candidate = byKey.get(normalizeName(r.descricao));
    if (!candidate) continue;
    const key = normalizeName(candidate.description);
    if (done.has(key)) continue;
    done.add(key);

    const motivo = typeof r.motivo === "string" ? r.motivo.replace(/\s+/g, " ").trim().slice(0, 120) : "";
    out.push({ description: candidate.description, isMatch: corresponde, reason: motivo });
  }
  return out;
}

// ---------------------------------------------------------------------------
// utilitários usados pela rota
// ---------------------------------------------------------------------------

/** Devolve a palavra de `excluir` (já normalizada) que aparece na descrição normalizada, ou null. */
export function findExcludedWord(normalizedDescription: string, excluir: string[]): string | null {
  if (excluir.length === 0) return null;
  const padded = ` ${normalizedDescription} `;
  for (const raw of excluir) {
    const w = normalizeName(raw);
    if (w && padded.includes(` ${w} `)) return w;
  }
  return null;
}
