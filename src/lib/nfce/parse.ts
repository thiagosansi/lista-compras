/**
 * Parser do DANFE NFC-e "sintético" da Sefaz-BA
 * (http://nfe.sefaz.ba.gov.br/servicos/nfce/Modulos/Geral/NFCEC_consulta_danfe.aspx).
 *
 * Sem dependências: o HTML é lido com regex sobre a estrutura fixa gerada pelo XSLT
 * (layout "nfceMob", o mesmo usado por vários estados). Ver docs/nfce.md.
 */

export type ParsedItem = {
  description: string;
  /** Código interno do produto no emitente (cProd). */
  code: string | null;
  /** GTIN/EAN quando o código informado é um GTIN válido (ou quando enriquecido pela aba Produtos). */
  gtin: string | null;
  quantity: number;
  unit: string | null;
  unitPrice: number;
  total: number;
};

export type ParsedReceipt = {
  accessKey: string;
  store: { cnpj: string; name: string; address: string | null; city: string | null };
  /** ISO 8601 com fuso (ex.: 2025-07-24T18:18:27-03:00) ou null. */
  issuedAt: string | null;
  total: number | null;
  items: ParsedItem[];
};

export class NfceParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NfceParseError";
  }
}

// ---------- utilidades de texto ----------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  aacute: "á",
  agrave: "à",
  atilde: "ã",
  acirc: "â",
  eacute: "é",
  ecirc: "ê",
  iacute: "í",
  oacute: "ó",
  otilde: "õ",
  ocirc: "ô",
  uacute: "ú",
  uuml: "ü",
  ccedil: "ç",
  Aacute: "Á",
  Agrave: "À",
  Atilde: "Ã",
  Acirc: "Â",
  Eacute: "É",
  Ecirc: "Ê",
  Iacute: "Í",
  Oacute: "Ó",
  Otilde: "Õ",
  Ocirc: "Ô",
  Uacute: "Ú",
  Uuml: "Ü",
  Ccedil: "Ç",
  ordm: "º",
  ordf: "ª",
  deg: "°",
};

function decodeEntitiesOnce(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

/** Decodifica entidades HTML; a Sefaz-BA às vezes codifica duas vezes (`&amp;amp;`), por isso repete até estabilizar. */
export function decodeEntities(input: string): string {
  let out = input;
  for (let i = 0; i < 3; i++) {
    const next = decodeEntitiesOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Remove tags, decodifica entidades e colapsa espaços. */
export function textOf(fragment: string): string {
  return decodeEntities(
    fragment
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\u00a0/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/** "1.234,56" → 1234.56; "16,182" → 16.182; "0.00" → 0. Retorna null se não for número. */
export function parseBrNumber(raw: string | null | undefined): number | null {
  if (!raw) return null;
  let s = raw.replace(/[^\d.,-]/g, "");
  if (!s) return null;
  if (s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if ((s.match(/\./g) ?? []).length > 1) {
    s = s.replace(/\./g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** "24/07/2025 18:18:27-03:00" → "2025-07-24T18:18:27-03:00". Sem fuso, assume -03:00 (Bahia). */
export function parseBrDateTime(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/(\d{2})\/(\d{2})\/(\d{4})(?:[ T]+(\d{2}):(\d{2})(?::(\d{2}))?)?\s*([+-]\d{2}:\d{2})?/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh = "00", mi = "00", ss = "00", tz = "-03:00"] = m;
  const iso = `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${tz}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

export function onlyDigits(input: string): string {
  return input.replace(/\D+/g, "");
}

/** Valida dígito verificador de GTIN-8/12/13/14 (módulo 10). */
export function isValidGtin(code: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  if (/^0+$/.test(code)) return false;
  const digits = code.split("").map(Number);
  const check = digits.pop()!;
  let sum = 0;
  // Da direita para a esquerda, pesos 3,1,3,1...
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += digits[i] * w;
  return (10 - (sum % 10)) % 10 === check;
}

function firstMatch(html: string, re: RegExp): string | null {
  const m = html.match(re);
  return m ? m[1] : null;
}

// ---------- parser principal ----------

/**
 * Lê o HTML da página "Consulta DANFE NFC-e" (visão sintética) da Sefaz-BA.
 * Lança NfceParseError se a página for de erro ou não tiver o layout esperado.
 */
export function parseNfceHtml(html: string): ParsedReceipt {
  // Página de erro do qrcode.aspx / consulta por chave.
  const errorMsg = firstMatch(html, /id="lblInformacao"[^>]*>([\s\S]*?)<\/span>/i);
  if (errorMsg && !/id="tabResult"/i.test(html)) {
    throw new NfceParseError(`Sefaz-BA: ${textOf(errorMsg)}`);
  }
  if (/txt_cod_antirobo|img_captcha/i.test(html) && !/id="tabResult"/i.test(html)) {
    throw new NfceParseError("A Sefaz-BA pediu captcha. Escaneie o QR code impresso no cupom.");
  }

  // Trabalha apenas sobre o trecho renderizado (evita o __VIEWSTATE, que repete o conteúdo em base64).
  const xsltStart = html.search(/<span id="txt_xslt">/i);
  const body = xsltStart >= 0 ? html.slice(xsltStart) : html;

  // Chave de acesso
  const chaveRaw = firstMatch(body, /class="chave"[^>]*>([\s\S]*?)<\/span>/i);
  const accessKey = chaveRaw ? onlyDigits(textOf(chaveRaw)) : "";
  if (!/^\d{44}$/.test(accessKey)) {
    throw new NfceParseError("Não foi possível ler a chave de acesso do cupom.");
  }

  // Emitente
  const name = textOf(firstMatch(body, /class="txtTopo"[^>]*>([\s\S]*?)<\/div>/i) ?? "");
  const textDivs = [...body.matchAll(/<div class="text">([\s\S]*?)<\/div>/gi)].map((m) => textOf(m[1]));
  const cnpjDivIndex = textDivs.findIndex((t) => /CNPJ/i.test(t));
  const cnpj = cnpjDivIndex >= 0 ? onlyDigits(textDivs[cnpjDivIndex]) : "";
  if (!/^\d{14}$/.test(cnpj)) {
    throw new NfceParseError("Não foi possível ler o CNPJ do emitente.");
  }
  const addressRaw = cnpjDivIndex >= 0 ? (textDivs[cnpjDivIndex + 1] ?? "") : "";
  const { address, city } = splitAddress(addressRaw);

  // Itens
  const tableHtml = firstMatch(body, /<table[^>]*id="tabResult"[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableHtml) {
    throw new NfceParseError("Não foi possível encontrar os itens do cupom.");
  }
  const items: ParsedItem[] = [];
  for (const row of tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const item = parseItemRow(row[1]);
    if (item) items.push(item);
  }
  if (items.length === 0) {
    throw new NfceParseError("O cupom não tem itens legíveis.");
  }

  // Totais
  const total =
    findTotal(body, /Valor a pagar R\$/i) ?? findTotal(body, /Valor total R\$/i) ?? sumOrNull(items.map((i) => i.total));

  // Emissão
  const issuedRaw = firstMatch(body, /Emiss[ãa]o:\s*<\/strong>\s*([\d/]+\s+[\d:]+(?:[+-]\d{2}:\d{2})?)/i);
  const issuedAt = parseBrDateTime(issuedRaw);

  return {
    accessKey,
    store: { cnpj, name: name || "Loja sem nome", address, city },
    issuedAt,
    total,
    items,
  };
}

function parseItemRow(rowHtml: string): ParsedItem | null {
  const description = textOf(firstMatch(rowHtml, /class="txtTit"[^>]*>([\s\S]*?)<\/span>/i) ?? "");
  if (!description) return null;

  const codeRaw = textOf(firstMatch(rowHtml, /class="RCod"[^>]*>([\s\S]*?)<\/span>/i) ?? "");
  const code = codeRaw.replace(/^\(?\s*C[óo]digo:\s*/i, "").replace(/\)\s*$/, "").trim() || null;

  const qtyRaw = textOf(firstMatch(rowHtml, /class="Rqtd"[^>]*>([\s\S]*?)<\/span>/i) ?? "").replace(/^Qtde\.?:\s*/i, "");
  const unitRaw = textOf(firstMatch(rowHtml, /class="RUN"[^>]*>([\s\S]*?)<\/span>/i) ?? "").replace(/^UN:\s*/i, "");
  const unitPriceRaw = textOf(firstMatch(rowHtml, /class="RvlUnit"[^>]*>([\s\S]*?)<\/span>/i) ?? "").replace(
    /^Vl\.?\s*Unit\.?:\s*/i,
    "",
  );
  const totalRaw = textOf(firstMatch(rowHtml, /class="valor"[^>]*>([\s\S]*?)<\/span>/i) ?? "");

  const quantity = parseBrNumber(qtyRaw) ?? 1;
  const total = parseBrNumber(totalRaw);
  let unitPrice = parseBrNumber(unitPriceRaw);
  if (unitPrice === null && total !== null && quantity > 0) unitPrice = round4(total / quantity);
  if (unitPrice === null || total === null) return null;

  const digits = code ? onlyDigits(code) : "";
  const gtin = code && digits === code && isValidGtin(digits) ? digits : null;

  return {
    description,
    code,
    gtin,
    quantity,
    unit: unitRaw ? unitRaw.toUpperCase() : null,
    unitPrice,
    total,
  };
}

/** "AV X, 305, , BAIRRO, SALVADOR, BA" → { address: "AV X, 305, BAIRRO, SALVADOR, BA", city: "SALVADOR" }. */
function splitAddress(raw: string): { address: string | null; city: string | null } {
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { address: null, city: null };
  const last = parts[parts.length - 1];
  const hasUf = /^[A-Z]{2}$/.test(last);
  const city = hasUf ? (parts[parts.length - 2] ?? null) : null;
  return { address: parts.join(", "), city };
}

function findTotal(body: string, label: RegExp): number | null {
  const re = new RegExp(`<label[^>]*>\\s*${label.source}[^<]*<\\/label>\\s*<span[^>]*>([\\s\\S]*?)<\\/span>`, "i");
  const raw = firstMatch(body, re);
  return raw ? parseBrNumber(textOf(raw)) : null;
}

function sumOrNull(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ---------- aba "Produtos e Serviços" (visão completa) ----------

export type ProductTabRow = { number: number; description: string; code: string | null; gtin: string | null };

/**
 * Lê a aba "Produtos e Serviços" (NFCEC_consulta_abas.aspx) para obter o GTIN (Código EAN Comercial)
 * de cada item. Retorna lista vazia se o HTML não tiver o layout esperado.
 */
export function parseProductsTab(html: string): ProductTabRow[] {
  const start = html.search(/id="uc_aba_produtos_txt_xslt"|id="Prod"/i);
  const body = start >= 0 ? html.slice(start) : html;
  const rows: ProductTabRow[] = [];
  // Cada produto: <table class="toggle"> (cabeçalho) seguido de <table class="toggable" id="table-N"> (detalhes).
  const blocks = body.split(/<table class="toggle"/i).slice(1);
  for (const block of blocks) {
    const number = parseInt(firstMatch(block, /<label>N[úu]mero<\/label>\s*<span[^>]*>([\s\S]*?)<\/span>/i) ?? "", 10);
    const description = textOf(firstMatch(block, /<label>Descri[çc][ãa]o<\/label>\s*<span[^>]*>([\s\S]*?)<\/span>/i) ?? "");
    const code = textOf(firstMatch(block, /<label>C[óo]digo do Produto<\/label>\s*<span[^>]*>([\s\S]*?)<\/span>/i) ?? "") || null;
    const eanRaw = textOf(firstMatch(block, /<label>C[óo]digo EAN Comercial<\/label>\s*<span[^>]*>([\s\S]*?)<\/span>/i) ?? "");
    const ean = onlyDigits(eanRaw);
    const gtin = ean && isValidGtin(ean) ? ean : null;
    if (!Number.isFinite(number) || !description) continue;
    rows.push({ number, description, code, gtin });
  }
  return rows;
}

/** Preenche `gtin` dos itens (por posição/número) com os dados da aba Produtos. Não altera o resto. */
export function mergeGtins(receipt: ParsedReceipt, products: ProductTabRow[]): ParsedReceipt {
  if (products.length === 0) return receipt;
  const byNumber = new Map(products.map((p) => [p.number, p] as const));
  return {
    ...receipt,
    items: receipt.items.map((item, i) => {
      if (item.gtin) return item;
      const p = byNumber.get(i + 1);
      if (!p?.gtin) return item;
      // Confere que é o mesmo produto (descrição ou código) antes de aceitar.
      const sameCode = !!item.code && !!p.code && item.code === p.code;
      const sameDesc = item.description.toLowerCase() === p.description.toLowerCase();
      return sameCode || sameDesc ? { ...item, gtin: p.gtin } : item;
    }),
  };
}
