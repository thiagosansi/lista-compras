// Categorização de itens da lista (fase 5): UMA chamada ao Groq para um lote de nomes → categoria de CATEGORIES.
// Só no servidor. O chamador cacheia em `item_categories`; aqui não há persistência.

import { CATEGORIES, DEFAULT_CATEGORY, isCategory, type Category } from "@/lib/categories";
import { chatJson } from "@/lib/llm/groq";
import { normalizeName } from "@/lib/normalize";

/** Máximo de nomes por chamada (o route handler já limita a 50). */
export const MAX_NAMES_PER_CALL = 50;

type LlmOutput = { itens?: { nome?: unknown; categoria?: unknown }[] };

const EXAMPLES: [string, Category][] = [
  ["arroz", "Mercearia"],
  ["manteiga", "Frios e refrigerados"],
  ["margarina", "Frios e refrigerados"],
  ["manteiga vegetal", "Frios e refrigerados"],
  ["queijo", "Frios e refrigerados"],
  ["requeijão", "Frios e refrigerados"],
  ["iogurte", "Frios e refrigerados"],
  ["presunto", "Frios e refrigerados"],
  ["mortadela", "Frios e refrigerados"],
  ["leite (caixinha/UHT)", "Mercearia"],
  ["leite integral", "Mercearia"],
  ["leite em pó", "Mercearia"],
  ["leite condensado", "Mercearia"],
  ["creme de leite", "Mercearia"],
  ["achocolatado", "Mercearia"],
  ["café", "Mercearia"],
  ["queijo ralado (pacote de prateleira)", "Mercearia"],
  ["ovos", "Frios e refrigerados"],
  ["banana", "Hortifruti"],
  ["detergente", "Limpeza"],
  ["papel higiênico", "Higiene e beleza"],
  ["cerveja", "Bebidas"],
  ["frango", "Açougue e peixaria"],
  ["pão", "Padaria"],
  ["bolo", "Padaria"],
  ["sorvete", "Congelados"],
  ["pizza congelada", "Congelados"],
  ["hambúrguer congelado", "Congelados"],
  ["polpa de fruta", "Congelados"],
  ["fralda", "Bebê"],
  ["ração", "Pet"],
];

const SYSTEM_PROMPT = [
  "Você classifica itens de uma lista de compras de supermercado no Brasil em seções do mercado.",
  "Para CADA item recebido, escolha exatamente UMA categoria desta lista (copie o nome exatamente como está):",
  ...CATEGORIES.map((c) => `- ${c}`),
  "",
  "IMPORTANTE: classifique pela SEÇÃO FÍSICA do mercado onde o produto fica, não pelo tipo de alimento",
  "(ex.: nem todo laticínio fica na mesma seção — leite UHT em caixinha fica na prateleira, não na geladeira).",
  "",
  "Regras de seção:",
  "- Vão para \"Frios e refrigerados\" (geladeira/vitrine refrigerada): manteiga, margarina, manteiga vegetal,",
  "  queijo, requeijão, iogurte, presunto, mortadela, leite pasteurizado/fresco (geladeira) e ovos.",
  "- Vão para \"Mercearia\" (prateleira seca): leite UHT/longa vida (caixinha), leite em pó, leite condensado,",
  "  creme de leite, achocolatado, café, arroz, feijão, óleo, açúcar, biscoito, massa, molho, enlatados,",
  "  grãos, temperos e doces. Queijo ralado vendido em pacote de prateleira (não refrigerado) também é",
  "  \"Mercearia\", mesmo sendo um laticínio.",
  "- Vão para \"Congelados\" (freezer): sorvete, pizza congelada, hambúrguer congelado, polpa de fruta e",
  "  outros itens vendidos congelados.",
  "- Vão para \"Padaria\": pão e bolo.",
  "- Vão para \"Açougue e peixaria\": carne, frango e peixe frescos (não enlatados/congelados industrializados).",
  "- Vão para \"Hortifruti\": frutas, verduras e legumes.",
  "- Produtos de limpeza da casa ficam em \"Limpeza\"; produtos de higiene pessoal ficam em \"Higiene e beleza\".",
  `- Se não tiver certeza ou o item não for de supermercado, use "${DEFAULT_CATEGORY}".`,
  "",
  "Exemplos:",
  ...EXAMPLES.map(([nome, cat]) => `- ${nome} → ${cat}`),
  "",
  "Responda SOMENTE com JSON no formato:",
  '{ "itens": [ { "nome": "<nome exatamente como recebido>", "categoria": "<categoria da lista>" } ] }',
  "Inclua todos os itens recebidos, na mesma ordem, sem inventar itens novos.",
].join("\n");

/**
 * Classifica os nomes em categorias de `CATEGORIES` numa única chamada ao Groq (`reasoning_effort: low`).
 * Devolve só os nomes cuja categoria veio válida (`isCategory`); os que faltarem ficam a cargo do chamador
 * (normalmente `DEFAULT_CATEGORY`, sem cachear). Lança `LlmError` se o Groq falhar.
 */
export async function categorizeNames(nomes: string[]): Promise<Record<string, Category>> {
  const unique: string[] = [];
  const byKey = new Map<string, string[]>();
  for (const raw of nomes) {
    const nome = raw.replace(/\s+/g, " ").trim();
    const key = normalizeName(nome);
    if (!nome || !key) continue;
    const group = byKey.get(key);
    if (group) {
      if (!group.includes(nome)) group.push(nome);
    } else {
      byKey.set(key, [nome]);
      unique.push(nome);
    }
  }
  if (unique.length === 0) return {};
  if (unique.length > MAX_NAMES_PER_CALL) throw new Error(`No máximo ${MAX_NAMES_PER_CALL} nomes por chamada`);

  const output = await chatJson<LlmOutput>({
    system: SYSTEM_PROMPT,
    user: JSON.stringify({ itens: unique }),
    reasoningEffort: "low",
    temperature: 0,
    maxTokens: 4096,
  });

  const out: Record<string, Category> = {};
  for (const item of Array.isArray(output?.itens) ? output.itens : []) {
    if (typeof item?.nome !== "string" || !isCategory(item.categoria)) continue;
    const names = byKey.get(normalizeName(item.nome));
    if (!names) continue;
    for (const nome of names) out[nome] = item.categoria;
  }
  return out;
}
