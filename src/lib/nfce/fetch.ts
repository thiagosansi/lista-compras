/**
 * Download do DANFE NFC-e na Sefaz-BA a partir do conteúdo do QR code.
 *
 * Fluxo real (ver docs/nfce.md):
 *   GET  http://nfe.sefaz.ba.gov.br/servicos/nfce/qrcode.aspx?p=<chave>|<versão>|<amb>|<idCSC>|<hash>
 *     → 302 NFCEC_consulta_chave_acesso.aspx?chave_acesso_qrcode=<chave>   (Set-Cookie ASP.NET_SessionId)
 *     → 302 NFCEC_consulta_danfe.aspx                                       (exige o cookie)
 *     → 200 HTML sintético com os itens.
 * `fetch` do Node não repassa cookies entre redirects, então os redirects são seguidos à mão.
 *
 * A consulta só pela chave (44 dígitos) exige captcha na Sefaz-BA, portanto não é suportada.
 * HTTPS do host tem cadeia de certificados incompleta (falha no Node); o QR usa http e mantemos http.
 */

import { parseNfceHtml, parseProductsTab, mergeGtins, type ParsedReceipt } from "./parse";

export class NfceFetchError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "NfceFetchError";
    this.status = status;
  }
}

const SEFAZ_HOST = "nfe.sefaz.ba.gov.br";
const QRCODE_PATH = "/servicos/nfce/qrcode.aspx";
const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

export type NfceTarget = { url: string; accessKey: string };

/**
 * Interpreta o texto do QR code (URL da Sefaz-BA) ou uma chave de 44 dígitos.
 * Só aceita o host oficial da Sefaz-BA (evita SSRF) e normaliza para http.
 */
export function resolveNfceTarget(input: string): NfceTarget {
  const text = input.trim();
  if (!text) throw new NfceFetchError("Informe o link do QR code do cupom.", 400);

  if (/^\d{44}$/.test(text.replace(/\s+/g, ""))) {
    throw new NfceFetchError(
      "A Sefaz-BA exige captcha na consulta só pela chave. Escaneie o QR code impresso no cupom ou cole o link completo.",
      422,
    );
  }

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    throw new NfceFetchError("Link do cupom inválido.", 400);
  }
  if (url.hostname.toLowerCase() !== SEFAZ_HOST) {
    throw new NfceFetchError("Só cupons da Sefaz-BA (nfe.sefaz.ba.gov.br) são aceitos por enquanto.", 422);
  }
  if (url.pathname.toLowerCase() !== QRCODE_PATH) {
    throw new NfceFetchError("Link do QR code não reconhecido. Use o QR code impresso no cupom.", 422);
  }
  const p = url.searchParams.get("p") ?? "";
  const accessKey = p.split("|")[0]?.replace(/\D+/g, "") ?? "";
  if (!/^\d{44}$/.test(accessKey)) {
    throw new NfceFetchError("O link do QR code não contém uma chave de acesso válida.", 422);
  }
  if (p.split("|").length < 5) {
    throw new NfceFetchError("O link do QR code está incompleto (faltam parâmetros de validação).", 422);
  }
  url.protocol = "http:";
  return { url: url.toString(), accessKey };
}

type Session = { cookies: Map<string, string> };

function cookieHeader(session: Session): string | undefined {
  if (session.cookies.size === 0) return undefined;
  return [...session.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
}

function absorbCookies(session: Session, res: Response) {
  const setCookies: string[] =
    typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie") ?? ""];
  for (const line of setCookies) {
    const first = line.split(";")[0]?.trim();
    if (!first) continue;
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    session.cookies.set(first.slice(0, eq), first.slice(eq + 1));
  }
}

/** GET/POST seguindo redirects manualmente e mantendo o cookie de sessão. */
async function request(
  session: Session,
  url: string,
  init: { method?: "GET" | "POST"; body?: string } = {},
): Promise<{ html: string; url: string }> {
  let current = url;
  let method = init.method ?? "GET";
  let body = init.body;

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "pt-BR,pt;q=0.9",
    };
    const cookie = cookieHeader(session);
    if (cookie) headers.Cookie = cookie;
    if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";

    let res: Response;
    try {
      res = await fetch(current, {
        method,
        headers,
        body: method === "POST" ? body : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      });
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new NfceFetchError(
        isTimeout ? "A Sefaz-BA demorou demais para responder. Tente de novo." : "Não foi possível acessar a Sefaz-BA.",
        504,
      );
    }
    absorbCookies(session, res);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new NfceFetchError("Resposta inesperada da Sefaz-BA (redirect sem destino).");
      current = new URL(location, current).toString();
      method = "GET";
      body = undefined;
      continue;
    }
    if (!res.ok) {
      throw new NfceFetchError(`A Sefaz-BA respondeu com erro (${res.status}).`);
    }
    return { html: await res.text(), url: current };
  }
  throw new NfceFetchError("A Sefaz-BA redirecionou vezes demais.");
}

function hiddenField(html: string, name: string): string | null {
  const m = html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`, "i"));
  return m ? m[1] : null;
}

function formBody(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

export type FetchedNfce = {
  receipt: ParsedReceipt;
  /** URL final da página sintética. */
  sourceUrl: string;
  /** true se a aba Produtos foi lida (GTINs preenchidos quando existem). */
  enriched: boolean;
};

/**
 * Baixa e interpreta o cupom. Com `withGtins` (padrão), tenta também abrir a aba
 * "Produtos e Serviços" (2 POSTs extras) para ler o GTIN de cada item; falhas nessa etapa são ignoradas.
 */
export async function fetchNfce(input: string, options: { withGtins?: boolean } = {}): Promise<FetchedNfce> {
  const target = resolveNfceTarget(input);
  const session: Session = { cookies: new Map() };

  const page = await request(session, target.url);
  let receipt = parseNfceHtml(page.html);
  if (receipt.accessKey !== target.accessKey) {
    throw new NfceFetchError("A Sefaz-BA devolveu um cupom diferente do QR code lido.");
  }

  let enriched = false;
  if (options.withGtins !== false) {
    try {
      const products = await fetchProductsTab(session, page);
      receipt = mergeGtins(receipt, products);
      enriched = true;
    } catch {
      // Enriquecimento é opcional: segue sem GTIN.
    }
  }

  return { receipt, sourceUrl: target.url, enriched };
}

async function fetchProductsTab(session: Session, page: { html: string; url: string }) {
  const vs = hiddenField(page.html, "__VIEWSTATE");
  const vsg = hiddenField(page.html, "__VIEWSTATEGENERATOR");
  const ev = hiddenField(page.html, "__EVENTVALIDATION");
  if (!vs || !vsg || !ev) throw new Error("viewstate ausente");

  // 1) "Visualizar em Abas" → 302 → NFCEC_consulta_abas.aspx
  const abas = await request(session, page.url, {
    method: "POST",
    body: formBody({
      __VIEWSTATE: vs,
      __VIEWSTATEGENERATOR: vsg,
      __EVENTVALIDATION: ev,
      hd_origem_chamada: "",
      btn_visualizar_abas: "Visualizar em Abas",
    }),
  });

  const vs2 = hiddenField(abas.html, "__VIEWSTATE");
  const vsg2 = hiddenField(abas.html, "__VIEWSTATEGENERATOR");
  const ev2 = hiddenField(abas.html, "__EVENTVALIDATION");
  if (!vs2 || !vsg2 || !ev2) throw new Error("viewstate das abas ausente");

  // 2) Aba "Produtos e Serviços" (botão de imagem: envia .x/.y)
  const produtos = await request(session, abas.url, {
    method: "POST",
    body: formBody({
      __EVENTTARGET: "",
      __EVENTARGUMENT: "",
      __VIEWSTATE: vs2,
      __VIEWSTATEGENERATOR: vsg2,
      __EVENTVALIDATION: ev2,
      hd_origem_chamada: "",
      "btn_aba_produtos.x": "12",
      "btn_aba_produtos.y": "12",
    }),
  });
  return parseProductsTab(produtos.html);
}
