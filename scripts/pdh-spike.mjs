#!/usr/bin/env node
// Spike de viabilidade do Preço da Hora BA (https://precodahora.ba.gov.br).
// Node 22, só fetch nativo. Uso: node scripts/pdh-spike.mjs
//
// Fluxo descoberto (ver docs/precodahora.md):
//   1. GET /produtos/ → cookie `session` (Flask) + <meta id="validate" data-id="<csrf>">
//   2. POST /produtos/ (form-urlencoded) com Cookie + X-CSRFToken → JSON { codigo: 80, resultado: [...] }
//   Falhas: 401 { codigo: 70, descricao: "Acesso não autorizado!" } (sessão/CSRF inválidos),
//           429 → o site redireciona para /challenge/ (reCAPTCHA v2).

const BASE = "https://precodahora.ba.gov.br";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const SALVADOR = { lat: -12.9777, lng: -38.5016 };

function parseSetCookie(headers) {
  const raw = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  return raw
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

async function openSession() {
  const res = await fetch(`${BASE}/produtos/`, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    redirect: "manual",
  });
  const html = await res.text();
  const cookie = parseSetCookie(res.headers);
  const csrf = html.match(/id="validate"\s+data-id="([^"]+)"/)?.[1] ?? null;
  console.log(`[sessão] GET /produtos/ → ${res.status} ${res.headers.get("content-type")}`);
  console.log(`[sessão] cookies: ${cookie.replace(/=([^;]{12})[^;]*/g, "=$1…")}`);
  console.log(`[sessão] csrf: ${csrf ? csrf.slice(0, 24) + "…" : "NÃO ENCONTRADO"}`);
  // Obs.: toda página embute o markup (oculto) do reCAPTCHA, então `data-sitekey` no HTML
  // NÃO indica bloqueio. Challenge real = redirect para /challenge/ ou página sem #validate.
  if (/\/challenge\//.test(res.headers.get("location") ?? "") || !csrf) {
    console.log("[sessão] !!! bloqueado: redirect para /challenge/ ou página sem token");
  }
  return { cookie, csrf };
}

async function search(session, params) {
  const body = new URLSearchParams({
    termo: params.termo ?? "",
    gtin: params.gtin ?? "",
    cnpj: "",
    horas: String(params.horas ?? 72),
    anp: "",
    codmun: "",
    latitude: String(params.lat),
    longitude: String(params.lng),
    raio: String(params.raio ?? 10),
    precomax: "0",
    precomin: "0",
    pagina: String(params.pagina ?? 1),
    ordenar: "preco.asc",
    categorias: "",
    processo: "carregar",
    totalCategorias: "",
    totalRegistros: "0",
    totalPaginas: "0",
    pageview: "lista",
  });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(`${BASE}/produtos/`, {
      method: "POST",
      redirect: "manual",
      signal: ctrl.signal,
      headers: {
        "User-Agent": UA,
        Accept: "*/*",
        "Accept-Language": "pt-BR,pt;q=0.9",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Origin: BASE,
        Referer: `${BASE}/produtos/`,
        "X-Requested-With": "XMLHttpRequest",
        "X-CSRFToken": session.csrf ?? "",
        Cookie: session.cookie,
      },
      body,
    });
    const ct = res.headers.get("content-type") ?? "";
    const text = await res.text();
    console.log(`[busca] POST /produtos/ → ${res.status} ${ct} (${text.length} bytes)`);
    if (!ct.includes("json")) {
      console.log("[busca] !!! resposta não é JSON (challenge/HTML?). Primeiros 300 chars:");
      console.log(text.slice(0, 300));
      return null;
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

function printResults(label, json) {
  if (!json) return;
  const { resultado = [], ...meta } = json;
  console.log(`\n=== ${label}`);
  console.log(
    `codigo=${meta.codigo} totalRegistros=${meta.totalRegistros} totalPaginas=${meta.totalPaginas} ` +
      `registrosporPagina=${meta.registrosporPagina} dias=${meta.dias} ` +
      `intervaloPreco=${JSON.stringify(meta.intervaloPreco)}`,
  );
  if (meta.codigo !== 80) {
    console.log("!!! codigo != 80:", JSON.stringify(meta));
    return;
  }
  for (const r of resultado.slice(0, 3)) {
    console.log(JSON.stringify(r, null, 2));
  }
}

const session = await openSession();
if (!session.csrf) {
  console.error("Sem token CSRF; abortando.");
  process.exit(1);
}

const termo = await search(session, { termo: "leite integral", ...SALVADOR, raio: 10, horas: 72 });
printResults('termo="leite integral" (Salvador, 10 km, 72 h)', termo);

const gtin = await search(session, { gtin: "7896051130079", ...SALVADOR, raio: 10, horas: 72 });
printResults("gtin=7896051130079 (Salvador, 10 km, 72 h)", gtin);
