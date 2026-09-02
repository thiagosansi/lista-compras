// Cliente mínimo do Groq (endpoint OpenAI-compatível) — só `fetch` nativo. Só no servidor (usa GROQ_API_KEY).
// Docs: https://console.groq.com/docs/api-reference
// `response_format: { type: "json_object" }` exige que a palavra "JSON" apareça no prompt.

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
// gpt-oss-120b: na avaliação (docs/matching.md) o 20b errou muito com `reasoning_effort: low` e estourou o limite
// de tokens/min do plano gratuito com `medium`; o 120b em `low` acertou os casos difíceis com ~700 tokens de saída.
const DEFAULT_MODEL = "openai/gpt-oss-120b";
const TIMEOUT_MS = 20_000;
/** Backoff padrão quando o Groq não manda `retry-after`. */
const DEFAULT_BACKOFF_MS = 1_000;
/** Se o `retry-after` pedir mais que isto, não vale esperar dentro da requisição: desiste. */
const MAX_BACKOFF_MS = 30_000;

export type LlmErrorKind = "rate_limit" | "timeout" | "network" | "invalid_json" | "api";

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly status: number | undefined;
  /** Em 429: quanto o Groq pediu para esperar (ms), se informou. */
  readonly retryAfterMs: number | undefined;
  constructor(kind: LlmErrorKind, message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = "LlmError";
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export type ChatJsonOptions = {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  /** Esforço de raciocínio: "low"|"medium"|"high" nos gpt-oss; "none"|"default" nos qwen3. Omitido = default do modelo. */
  reasoningEffort?: "none" | "default" | "low" | "medium" | "high";
};

export type LlmUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Latência total medida no cliente (ms), incluindo retry. */
  latencyMs: number;
  model: string;
};

type ChatCompletion = {
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  model?: string;
  error?: { message?: string; type?: string; code?: string; failed_generation?: string };
};

export function getModel(): string {
  return process.env.GROQ_MODEL?.trim() || DEFAULT_MODEL;
}

export function isLlmConfigured(): boolean {
  return Boolean(process.env.GROQ_API_KEY?.trim());
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestOnce(body: string, apiKey: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body,
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new LlmError("timeout", `Groq não respondeu em ${TIMEOUT_MS / 1000} s`);
    }
    throw new LlmError("network", `Falha de rede ao acessar o Groq: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function errorFromResponse(res: Response): Promise<LlmError> {
  let detail = "";
  let code = "";
  try {
    const json = (await res.json()) as ChatCompletion;
    detail = json.error?.message ?? "";
    code = json.error?.code ?? "";
    // 400 json_validate_failed: o modelo não produziu JSON válido; a amostra ajuda a ajustar o prompt.
    const sample = json.error?.failed_generation;
    if (sample) detail += ` | failed_generation: ${sample.slice(0, 300)}`;
  } catch {
    // corpo não-JSON: fica só o status
  }
  const message = `Groq respondeu ${res.status}${detail ? `: ${detail}` : ""}`;
  const retryAfter = parseRetryAfter(res.headers.get("retry-after")) ?? undefined;
  const kind: LlmErrorKind =
    res.status === 429 ? "rate_limit" : code === "json_validate_failed" ? "invalid_json" : "api";
  return new LlmError(kind, message, res.status, retryAfter);
}

/**
 * Chamada de chat com resposta JSON. Faz 1 retry em 429/5xx respeitando `retry-after`,
 * timeout de 20 s por tentativa. Devolve o objeto parseado e métricas de uso.
 */
export async function chatJsonWithMeta<T>(opts: ChatJsonOptions): Promise<{ data: T; usage: LlmUsage }> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) throw new LlmError("api", "GROQ_API_KEY não configurada");

  const model = getModel();
  const body = JSON.stringify({
    model,
    temperature: opts.temperature ?? 0,
    max_tokens: opts.maxTokens ?? 2048,
    ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
  });

  const started = Date.now();
  let res = await requestOnce(body, apiKey);

  if (res.status === 429 || res.status >= 500) {
    const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
    const wait = retryAfter ?? DEFAULT_BACKOFF_MS;
    if (wait > MAX_BACKOFF_MS) throw await errorFromResponse(res);
    await res.body?.cancel().catch(() => undefined);
    await sleep(wait);
    res = await requestOnce(body, apiKey);
  }
  if (!res.ok) throw await errorFromResponse(res);

  let completion: ChatCompletion;
  try {
    completion = (await res.json()) as ChatCompletion;
  } catch {
    throw new LlmError("invalid_json", "Resposta do Groq não é JSON válido", res.status);
  }
  const choice = completion.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new LlmError("invalid_json", "Groq devolveu resposta sem conteúdo", res.status);
  }
  if (choice?.finish_reason === "length") {
    throw new LlmError("invalid_json", "Resposta do Groq truncada (max_tokens)", res.status);
  }

  let data: T;
  try {
    data = JSON.parse(stripCodeFence(content)) as T;
  } catch {
    throw new LlmError("invalid_json", `Conteúdo do Groq não é JSON: ${content.slice(0, 120)}`, res.status);
  }

  return {
    data,
    usage: {
      promptTokens: completion.usage?.prompt_tokens ?? 0,
      completionTokens: completion.usage?.completion_tokens ?? 0,
      totalTokens: completion.usage?.total_tokens ?? 0,
      latencyMs: Date.now() - started,
      model: completion.model ?? model,
    },
  };
}

export async function chatJson<T>(opts: ChatJsonOptions): Promise<T> {
  return (await chatJsonWithMeta<T>(opts)).data;
}

/** Alguns modelos embrulham o JSON em ```json ... ``` mesmo com response_format. */
function stripCodeFence(s: string): string {
  const t = s.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1] : t;
}
