// Cliente do Preço da Hora BA (https://precodahora.ba.gov.br) — API privada, não oficial.
// Fluxo (ver docs/precodahora.md):
//   1. GET /produtos/ → cookie `session` + <meta id="validate" data-id="<csrf>">
//   2. POST /produtos/ (form-urlencoded) com Cookie + X-CSRFToken → JSON { codigo: 80, resultado: [...] }
// Só fetch nativo; sessão em cache de módulo (renovada em 401/challenge).

import type { PdhResult } from "@/lib/database.types";

const BASE_URL = "https://precodahora.ba.gov.br";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const TIMEOUT_MS = 15_000;
const SESSION_TTL_MS = 20 * 60 * 1000;
const PAGE_SIZE = 25; // fixo no servidor (registrosporPagina)
const MAX_PAGES = 4; // teto de segurança: 100 resultados

export type PdhErrorKind = "challenge" | "unauthorized" | "timeout" | "network" | "invalid_response" | "bad_request";

export class PdhError extends Error {
  readonly kind: PdhErrorKind;
  readonly status: number | undefined;
  constructor(kind: PdhErrorKind, message: string, status?: number) {
    super(message);
    this.name = "PdhError";
    this.kind = kind;
    this.status = status;
  }
  /** Bloqueio pelo serviço (challenge/captcha, sessão recusada): não adianta insistir agora. */
  get blocked(): boolean {
    return this.kind === "challenge" || this.kind === "unauthorized";
  }
}

export type SearchParams = {
  termo?: string;
  gtin?: string;
  lat: number;
  lng: number;
  /** Raio em km (default 10). */
  raioKm?: number;
  /** Janela de horas das notas (default 72). */
  horas?: number;
  /** Máximo de resultados (default 25, teto 100). */
  maxResultados?: number;
  /** Chamado uma vez antes de cada POST enviado (inclusive páginas subsequentes) — para orçamento de requisições do chamador. */
  onRequest?: () => void;
};

/** Registro bruto como vem do /produtos/ (campos observados no spike; todos tratados como opcionais). */
type RawProduto = {
  codProduto?: string | number | null;
  gtin?: string | number | null;
  descricao?: string | null;
  precoUnitario?: number | string | null;
  precoLiquido?: number | string | null;
  precoBruto?: number | string | null;
  unidade?: string | null;
  data?: string | null;
};
type RawEstabelecimento = {
  nomeEstabelecimento?: string | null;
  endLogradouro?: string | null;
  endNumero?: string | null;
  bairro?: string | null;
  municipio?: string | null;
  cnpj?: string | number | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
  distancia?: number | string | null;
};
type RawRecord = { produto?: RawProduto | null; estabelecimento?: RawEstabelecimento | null };
type RawResponse<T = RawRecord> = {
  codigo?: number;
  descricao?: string;
  totalPaginas?: number;
  totalRegistros?: number;
  resultado?: T[] | null;
};
/** Registro bruto do /sugestao/ (autocomplete do site): `{ gtin: number, descricao: string, foto: string }`. */
type RawSugestao = { gtin?: string | number | null; descricao?: string | null; foto?: string | null };

export type PdhSuggestion = { gtin: string; descricao: string };

type Session = { cookie: string; csrf: string; createdAt: number };

let cachedSession: Session | null = null;
let pendingSession: Promise<Session> | null = null;

function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  return fetch(input, { ...init, signal: controller.signal, redirect: "manual", cache: "no-store" })
    .catch((err: unknown) => {
      if (err instanceof Error && err.name === "AbortError") {
        throw new PdhError("timeout", `Preço da Hora não respondeu em ${TIMEOUT_MS / 1000} s`);
      }
      const detail = err instanceof Error ? err.message : String(err);
      throw new PdhError("network", `Falha de rede ao acessar o Preço da Hora: ${detail}`);
    })
    .finally(() => clearTimeout(timer));
}

function cookieHeaderFrom(headers: Headers): string {
  const raw = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  return raw
    .map((c) => c.split(";")[0]?.trim() ?? "")
    .filter(Boolean)
    .join("; ");
}

function isChallengeRedirect(res: Response): boolean {
  const location = res.headers.get("location") ?? "";
  return res.status >= 300 && res.status < 400 && /\/challenge\//.test(location);
}

async function openSession(): Promise<Session> {
  const res = await fetchWithTimeout(`${BASE_URL}/produtos/`, {
    method: "GET",
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*;q=0.8", "Accept-Language": "pt-BR,pt;q=0.9" },
  });
  if (res.status === 429 || isChallengeRedirect(res)) {
    throw new PdhError("challenge", "Preço da Hora exigiu verificação (captcha) para este endereço IP", res.status);
  }
  if (!res.ok) {
    throw new PdhError("network", `Preço da Hora respondeu ${res.status} ao abrir sessão`, res.status);
  }
  const html = await res.text();
  const csrf = html.match(/id="validate"\s+data-id="([^"]+)"/)?.[1];
  const cookie = cookieHeaderFrom(res.headers);
  if (!csrf || !/(^|;\s*)session=/.test(cookie)) {
    throw new PdhError("challenge", "Preço da Hora não forneceu sessão/token (possível bloqueio ou mudança no site)", res.status);
  }
  return { cookie, csrf, createdAt: Date.now() };
}

async function getSession(force = false): Promise<Session> {
  if (!force && cachedSession && Date.now() - cachedSession.createdAt < SESSION_TTL_MS) return cachedSession;
  if (!pendingSession) {
    pendingSession = openSession()
      .then((s) => {
        cachedSession = s;
        return s;
      })
      .finally(() => {
        pendingSession = null;
      });
  }
  return pendingSession;
}

function buildForm(params: SearchParams, pagina: number): URLSearchParams {
  return new URLSearchParams({
    termo: params.gtin ? "" : (params.termo ?? ""),
    gtin: params.gtin ?? "",
    cnpj: "",
    horas: String(params.horas ?? 72),
    anp: "",
    codmun: "",
    latitude: String(params.lat),
    longitude: String(params.lng),
    raio: String(params.raioKm ?? 10),
    precomax: "0",
    precomin: "0",
    pagina: String(pagina),
    ordenar: "preco.asc",
    categorias: "",
    processo: "carregar",
    totalCategorias: "",
    totalRegistros: "0",
    totalPaginas: "0",
    pageview: "lista",
  });
}

/** POST em um endpoint XHR do site (`/produtos/` ou `/sugestao/`), com a mesma sessão/CSRF e detecção de bloqueio. */
async function postProdutos<T = RawRecord>(
  session: Session,
  body: URLSearchParams,
  path: "/produtos/" | "/sugestao/" = "/produtos/",
): Promise<RawResponse<T>> {
  const res = await fetchWithTimeout(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "*/*",
      "Accept-Language": "pt-BR,pt;q=0.9",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Origin: BASE_URL,
      Referer: `${BASE_URL}/produtos/`,
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRFToken": session.csrf,
      Cookie: session.cookie,
    },
    body,
  });

  if (res.status === 429 || isChallengeRedirect(res)) {
    throw new PdhError("challenge", "Preço da Hora bloqueou a busca (captcha/limite de requisições)", res.status);
  }
  if (res.status === 401 || res.status === 403) {
    throw new PdhError("unauthorized", "Preço da Hora recusou a sessão (token CSRF/cookie inválidos)", res.status);
  }
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (!contentType.includes("json")) {
    // Página HTML no lugar de JSON = challenge servido inline.
    throw new PdhError("challenge", `Preço da Hora devolveu HTML em vez de JSON (status ${res.status})`, res.status);
  }
  let json: RawResponse<T>;
  try {
    json = JSON.parse(text) as RawResponse<T>;
  } catch {
    throw new PdhError("invalid_response", "Resposta do Preço da Hora não é JSON válido", res.status);
  }
  if (!res.ok) {
    throw new PdhError("network", `Preço da Hora respondeu ${res.status}: ${json.descricao ?? text.slice(0, 120)}`, res.status);
  }
  if (json.codigo === 70) {
    throw new PdhError("unauthorized", `Preço da Hora: ${json.descricao ?? "acesso não autorizado"}`, res.status);
  }
  if (json.codigo === 50) {
    // 202 { codigo: 50, descricao: "Nenhum resultado encontrado!" }
    return { ...json, resultado: [], totalPaginas: 0 };
  }
  if (json.codigo === 30) {
    // 202 { codigo: 30, descricao: "Nenhum parâmetro de busca foi informado." }
    throw new PdhError("bad_request", `Preço da Hora: ${json.descricao ?? "parâmetros inválidos"}`, res.status);
  }
  if (json.codigo !== 80 && !Array.isArray(json.resultado)) {
    throw new PdhError("invalid_response", `Preço da Hora: código ${json.codigo ?? "?"} ${json.descricao ?? ""}`.trim(), res.status);
  }
  return json;
}

/** POST com uma renovação de sessão em caso de 401/codigo 70. */
async function postWithRetry<T = RawRecord>(
  body: URLSearchParams,
  path: "/produtos/" | "/sugestao/" = "/produtos/",
): Promise<RawResponse<T>> {
  const session = await getSession();
  try {
    return await postProdutos<T>(session, body, path);
  } catch (err) {
    if (err instanceof PdhError && err.kind === "unauthorized") {
      cachedSession = null;
      const fresh = await getSession(true);
      return postProdutos<T>(fresh, body, path);
    }
    throw err;
  }
}

// ---------- mapeamento ----------

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function digits(v: unknown): string {
  return v == null ? "" : String(v).replace(/\D+/g, "");
}

function normalizeGtin(produto: RawProduto): string | null {
  // codProduto vem como string (preserva zeros à esquerda); gtin vem como número.
  for (const candidate of [produto.codProduto, produto.gtin]) {
    const d = digits(candidate);
    if (d.length >= 8 && d.length <= 14 && /[1-9]/.test(d)) return d;
  }
  return null;
}

function normalizeCnpj(v: unknown): string | null {
  let d = digits(v);
  if (d.length === 13) d = "0" + d; // veio como número e perdeu o zero à esquerda
  return d.length === 14 ? d : null;
}

function parseDate(v: string | null | undefined): string | null {
  if (!v) return null;
  // "2026-09-01 22:40:06-00:00" → ISO (o servidor devolve em UTC).
  const iso = v.trim().replace(" ", "T").replace(/-00:00$/, "Z");
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function cleanText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t ? t : null;
}

function buildAddress(e: RawEstabelecimento): string | null {
  const logradouro = cleanText(e.endLogradouro);
  const numero = cleanText(e.endNumero)?.replace(/^0+(?=\d)/, "") ?? null;
  const bairro = cleanText(e.bairro);
  const street = [logradouro, numero].filter(Boolean).join(", ");
  return [street, bairro].filter(Boolean).join(" - ") || null;
}

export function mapRawRecord(rec: RawRecord): PdhResult | null {
  const p = rec.produto ?? {};
  const e = rec.estabelecimento ?? {};
  const descricao = cleanText(p.descricao);
  const nome = cleanText(e.nomeEstabelecimento);
  const data = parseDate(p.data);
  const unitario = toNumber(p.precoUnitario);
  const preco = unitario && unitario > 0 ? unitario : toNumber(p.precoLiquido);
  if (!descricao || !nome || !data || !preco || preco <= 0) return null;

  return {
    descricao,
    gtin: normalizeGtin(p),
    preco: Math.round(preco * 100) / 100,
    unidade: cleanText(p.unidade),
    data,
    loja: {
      nome,
      cnpj: normalizeCnpj(e.cnpj),
      endereco: buildAddress(e),
      cidade: cleanText(e.municipio),
      lat: toNumber(e.latitude),
      lng: toNumber(e.longitude),
      distanciaKm: toNumber(e.distancia),
    },
  };
}

// ---------- API pública ----------

export async function searchPrecoDaHora(params: SearchParams): Promise<PdhResult[]> {
  const termo = params.termo?.trim() ?? "";
  const gtin = digits(params.gtin ?? "");
  if (!termo && !gtin) throw new PdhError("bad_request", "Informe `termo` ou `gtin`");
  if (!Number.isFinite(params.lat) || !Number.isFinite(params.lng)) {
    throw new PdhError("bad_request", "`lat` e `lng` são obrigatórios");
  }
  const max = Math.min(Math.max(1, Math.floor(params.maxResultados ?? PAGE_SIZE)), PAGE_SIZE * MAX_PAGES);
  const normalized: SearchParams = {
    ...params,
    termo,
    gtin: gtin || undefined,
    raioKm: Math.max(1, params.raioKm ?? 10),
    horas: Math.max(1, params.horas ?? 72),
  };

  const out: PdhResult[] = [];
  let pagina = 1;
  let totalPaginas = 1;
  while (out.length < max && pagina <= totalPaginas && pagina <= MAX_PAGES) {
    normalized.onRequest?.();
    const json = await postWithRetry(buildForm(normalized, pagina));
    totalPaginas = typeof json.totalPaginas === "number" ? json.totalPaginas : 1;
    const rows = Array.isArray(json.resultado) ? json.resultado : [];
    for (const rec of rows) {
      const mapped = mapRawRecord(rec);
      if (mapped) out.push(mapped);
      if (out.length >= max) break;
    }
    if (rows.length < PAGE_SIZE) break;
    pagina++;
  }
  return out;
}

/**
 * Autocomplete do site: `POST /sugestao/` (form `item=<termo>`) → produtos reais com código de barras vendidos na Bahia.
 * Resposta observada (02/09/2026, "oleo de coco"):
 *   `{ codigo: 80, dataConsulta, resultado: [{ gtin: number, descricao: string, foto: string }], totalRegistros, tempoResposta }`.
 * `gtin` vem como número: convertido com `String(n)`; só aceitamos 8–14 dígitos (os demais são descartados).
 * Mesmo limite de bloqueio do `/produtos/` (~20 POSTs / 15 min por IP) — cachear por termo (product_suggestions).
 */
export async function suggestPrecoDaHora(termo: string): Promise<PdhSuggestion[]> {
  const item = termo.replace(/\s+/g, " ").trim();
  if (!item) throw new PdhError("bad_request", "Informe `termo`");
  const json = await postWithRetry<RawSugestao>(new URLSearchParams({ item }), "/sugestao/");
  const rows = Array.isArray(json.resultado) ? json.resultado : [];
  const seen = new Set<string>();
  const out: PdhSuggestion[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const gtin = typeof row.gtin === "number" ? String(row.gtin) : digits(row.gtin);
    const descricao = cleanText(row.descricao);
    if (!/^\d{8,14}$/.test(gtin) || !/[1-9]/.test(gtin) || !descricao || seen.has(gtin)) continue;
    seen.add(gtin);
    out.push({ gtin, descricao });
  }
  return out;
}

/** Só para testes: descarta a sessão em cache. */
export function resetPrecoDaHoraSession(): void {
  cachedSession = null;
}
