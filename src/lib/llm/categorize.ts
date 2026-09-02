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
  ["leite", "Frios e laticínios"],
  ["banana", "Hortifruti"],
  ["detergente", "Limpeza"],
  ["papel higiênico", "Higiene e beleza"],
  ["cerveja", "Bebidas"],
  ["frango", "Açougue e peixaria"],
  ["pão", "Padaria"],
  ["pizza congelada", "Congelados"],
  ["fralda", "Bebê"],
  ["ração", "Pet"],
];

const SYSTEM_PROMPT = [
  "Você classifica itens de uma lista de compras de supermercado no Brasil em seções do mercado.",
  "Para CADA item recebido, escolha exatamente UMA categoria desta lista (copie o nome exatamente como está):",
  ...CATEGORIES.map((c) => `- ${c}`),
  "",
  "Regras:",
  "- Use o senso comum de onde o item fica num supermercado brasileiro.",
  `- Se não tiver certeza ou o item não for de supermercado, use "${DEFAULT_CATEGORY}".`,
  "- Laticínios, iogurtes, queijos, presunto, mortadela e manteiga ficam em \"Frios e laticínios\".",
  "- Carnes, frango, peixe e frutos do mar (frescos) ficam em \"Açougue e peixaria\".",
  "- Frutas, verduras, legumes e ovos ficam em \"Hortifruti\".",
  "- Enlatados, grãos, massas, óleos, temperos, biscoitos, doces e produtos de despensa ficam em \"Mercearia\".",
  "- Produtos de limpeza da casa ficam em \"Limpeza\"; produtos de higiene pessoal ficam em \"Higiene e beleza\".",
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
