#!/usr/bin/env -S pnpm dlx tsx
// Avaliação real do juiz de correspondência (fase 4), sem Next.
// Uso: pnpm dlx tsx scripts/match-eval.mjs [--items "Leite integral,Arroz 5kg"] [--raio 10] [--horas 72] [--max 60] [--cache DIR]
//   --pausa MS: espera entre itens (poupa o Preço da Hora, que bloqueia rajadas). Default 3000.
//   --cache DIR: guarda/reaproveita as respostas do Preço da Hora por termo (para iterar nos prompts sem repetir buscas).
// Lê GROQ_API_KEY (e GROQ_MODEL, opcional) de .env.local. Precisa de IP residencial (Preço da Hora bloqueia datacenter).
//
// Importa os módulos .ts do projeto via tsx (resolve os aliases `@/` do tsconfig). Nada é gravado no banco.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeName } from "../src/lib/normalize.ts";
import { searchPrecoDaHora, PdhError } from "../src/lib/precodahora/client.ts";
import { planSearches, judgeMatches, findExcludedWord, MAX_CANDIDATES } from "../src/lib/llm/matching.ts";
import { getModel } from "../src/lib/llm/groq.ts";

const envFile = join(process.cwd(), ".env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);
if (!process.env.GROQ_API_KEY) {
  console.error("GROQ_API_KEY não encontrada em .env.local");
  process.exit(1);
}

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

const SALVADOR = { lat: -12.9777, lng: -38.5016 };
const raioKm = Number(arg("raio", 10));
const horas = Number(arg("horas", 72));
const maxResultados = Number(arg("max", 60));
const pausaMs = Number(arg("pausa", 3000));
const cacheDir = arg("cache", "");
if (cacheDir) mkdirSync(cacheDir, { recursive: true });
async function searchCached(params) {
  const file = cacheDir ? join(cacheDir, `${normalizeName(params.termo).replace(/ /g, "_")}-${params.maxResultados}.json`) : null;
  if (file && existsSync(file)) {
    console.log(`   (Preço da Hora: usando cache ${file})`);
    return JSON.parse(readFileSync(file, "utf8"));
  }
  const out = await searchPrecoDaHora(params);
  if (file) writeFileSync(file, JSON.stringify(out));
  return out;
}

const itemNames = arg("items", "Leite integral,Arroz 5kg,Café 500g,Manteiga,Papel higiênico 12 rolos")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const items = itemNames.map((name, i) => ({ id: String(i + 1), name }));

const brl = (n) => `R$ ${n.toFixed(2).replace(".", ",")}`;
const usageTotals = { calls: 0, promptTokens: 0, completionTokens: 0, latencyMs: 0 };
function account(meta, label) {
  const u = meta.usage;
  usageTotals.calls++;
  usageTotals.promptTokens += u.promptTokens;
  usageTotals.completionTokens += u.completionTokens;
  usageTotals.latencyMs += u.latencyMs;
  console.log(`   [groq ${label}] ${u.latencyMs} ms, ${u.promptTokens} in / ${u.completionTokens} out tokens`);
}

console.log(`Modelo: ${getModel()} | Salvador ${SALVADOR.lat},${SALVADOR.lng} | raio ${raioKm} km | ${horas} h | máx ${maxResultados} resultados/item`);
console.log(`Itens: ${itemNames.join(" | ")}\n`);

// 1. Plano de busca (uma chamada)
let plans = {};
const planMeta = { usage: null };
try {
  const t0 = Date.now();
  plans = await planSearches(items, planMeta);
  console.log(`1) planSearches: ${Object.keys(plans).length}/${items.length} itens planejados em ${Date.now() - t0} ms`);
  account(planMeta, "plan");
} catch (err) {
  console.log(`1) planSearches FALHOU: ${err?.message ?? err} — usando o nome do item como termo`);
}
for (const it of items) {
  const p = plans[it.id] ?? { termo: it.name, excluir: [] };
  console.log(`   ${it.name.padEnd(28)} → termo="${p.termo}" excluir=[${p.excluir.join(", ")}]${p.observacao ? ` obs: ${p.observacao}` : ""}`);
}
console.log("");

// 2-3. Busca + juiz, item a item (sequencial para não estressar o Preço da Hora)
const summary = [];
for (const [idx, it] of items.entries()) {
  const plan = plans[it.id] ?? { termo: it.name, excluir: [] };
  if (idx > 0 && pausaMs > 0) await new Promise((r) => setTimeout(r, pausaMs));
  console.log(`== ${it.name} (termo "${plan.termo}")`);
  let resultados = [];
  const t0 = Date.now();
  try {
    resultados = await searchCached({ termo: plan.termo, ...SALVADOR, raioKm, horas, maxResultados });
  } catch (err) {
    const kind = err instanceof PdhError ? ` [${err.kind}]` : "";
    console.log(`   Preço da Hora FALHOU${kind}: ${err?.message ?? err}\n`);
    summary.push({ item: it.name, termo: plan.termo, erro: String(err?.message ?? err) });
    if (err instanceof PdhError && err.blocked) break;
    continue;
  }
  const pdhMs = Date.now() - t0;
  const lojas = new Set(resultados.map((r) => r.loja.cnpj ?? `${r.loja.nome}|${r.loja.endereco ?? ""}`));
  console.log(`   Preço da Hora: ${resultados.length} resultados, ${lojas.size} lojas distintas, ${pdhMs} ms`);

  // Filtro por palavras de `excluir` (sobre a descrição normalizada)
  const excluidos = new Map(); // key -> { descricao, palavra }
  const candidatosMap = new Map(); // key -> { description, gtin, price, lojas:Set }
  for (const r of resultados) {
    const key = normalizeName(r.descricao);
    const word = findExcludedWord(key, plan.excluir);
    if (word) {
      if (!excluidos.has(key)) excluidos.set(key, { descricao: r.descricao, palavra: word });
      continue;
    }
    const c = candidatosMap.get(key);
    if (!c) candidatosMap.set(key, { description: r.descricao, gtin: r.gtin, price: r.preco, lojas: new Set([r.loja.nome]) });
    else {
      if (r.preco < c.price) c.price = r.preco;
      if (!c.gtin && r.gtin) c.gtin = r.gtin;
      c.lojas.add(r.loja.nome);
    }
  }
  // Mesmo GTIN de uma descrição excluída = mesmo produto (como faz a rota).
  const gtinsExcluidos = new Map();
  for (const r of resultados) {
    const key = normalizeName(r.descricao);
    if (excluidos.has(key) && r.gtin && !gtinsExcluidos.has(r.gtin)) gtinsExcluidos.set(r.gtin, r.descricao);
  }
  for (const [key, c] of candidatosMap) {
    const twin = c.gtin ? gtinsExcluidos.get(c.gtin) : undefined;
    if (!twin) continue;
    candidatosMap.delete(key);
    excluidos.set(key, { descricao: c.description, palavra: `mesmo GTIN de "${twin}"` });
  }
  const candidatos = [...candidatosMap.values()];
  console.log(`   Descrições distintas: ${candidatos.length} candidatas (${Math.min(candidatos.length, MAX_CANDIDATES)} enviadas ao juiz), ${excluidos.size} descartadas por palavra excluída/GTIN`);
  for (const { descricao, palavra } of [...excluidos.values()].slice(0, 5)) {
    console.log(`     - excluída (${palavra.startsWith("mesmo") ? palavra : `"${palavra}"`}): ${descricao}`);
  }

  // Juiz
  let verdicts = [];
  const judgeMeta = { usage: null };
  try {
    verdicts = await judgeMatches({ name: it.name }, candidatos, judgeMeta);
    account(judgeMeta, "judge");
  } catch (err) {
    console.log(`   judgeMatches FALHOU: ${err?.message ?? err}\n`);
    summary.push({ item: it.name, termo: plan.termo, resultados: resultados.length, lojas: lojas.size, erro: String(err?.message ?? err) });
    continue;
  }
  const byKey = new Map(verdicts.map((v) => [normalizeName(v.description), v]));
  const semVeredicto = candidatos.filter((c) => !byKey.has(normalizeName(c.description)));
  const aceitos = candidatos.filter((c) => byKey.get(normalizeName(c.description))?.isMatch === true).sort((a, b) => a.price - b.price);
  const rejeitados = candidatos.filter((c) => byKey.get(normalizeName(c.description))?.isMatch === false).sort((a, b) => a.price - b.price);
  const lojasAceitas = new Set();
  for (const c of aceitos) for (const l of c.lojas) lojasAceitas.add(l);
  console.log(`   Juiz: ${verdicts.length} veredictos (${aceitos.length} correspondem, ${rejeitados.length} rejeitadas, ${semVeredicto.length} sem veredicto) — ${lojasAceitas.size} lojas com produto correspondente`);
  console.log(`   5 mais baratas CORRESPONDENTES:`);
  for (const c of aceitos.slice(0, 5)) {
    const v = byKey.get(normalizeName(c.description));
    console.log(`     + ${brl(c.price).padStart(10)}  ${c.description}${c.gtin ? ` [${c.gtin}]` : ""}  — ${v.reason}`);
  }
  console.log(`   3 REJEITADAS (mais baratas):`);
  for (const c of rejeitados.slice(0, 3)) {
    const v = byKey.get(normalizeName(c.description));
    console.log(`     - ${brl(c.price).padStart(10)}  ${c.description}  — ${v.reason}`);
  }
  if (semVeredicto.length) console.log(`   Sem veredicto: ${semVeredicto.slice(0, 3).map((c) => c.description).join(" | ")}`);
  console.log("");
  summary.push({
    item: it.name,
    termo: plan.termo,
    resultados: resultados.length,
    lojas: lojas.size,
    candidatos: candidatos.length,
    excluidos: excluidos.size,
    aceitos: aceitos.length,
    rejeitados: rejeitados.length,
    semVeredicto: semVeredicto.length,
    lojasAceitas: lojasAceitas.size,
  });
}

console.log("== Resumo");
console.table(summary);
console.log(
  `Groq: ${usageTotals.calls} chamadas, ${usageTotals.promptTokens} tokens de entrada, ${usageTotals.completionTokens} de saída, ${usageTotals.latencyMs} ms somados`,
);
