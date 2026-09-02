# Catálogo de produtos, autocomplete e categorias (fase 5)

Referência das rotas `/api/produtos/*` e `/api/itens/categorizar` e dos helpers `src/lib/products/server.ts`,
`src/lib/llm/categorize.ts` e `suggestPrecoDaHora` em `src/lib/precodahora/client.ts`. Contexto em `SPEC-fase5.md`;
fluxo de sessão/CSRF/bloqueio do Preço da Hora em `docs/precodahora.md`.

## `POST /sugestao/` do Preço da Hora (autocomplete do site)

Mesma sessão (cookie `session` + `X-CSRFToken` do `<meta id="validate">`), mesmos headers e mesma detecção de bloqueio
do `/produtos/`. Form `item=<termo>`. Resposta real observada em 02/09/2026 (`item=oleo de coco`, 859 ms):

```json
{
  "codigo": 80,
  "dataConsulta": "2026-09-02 07:44:56.999466",
  "resultado": [
    { "gtin": 7898905356246, "descricao": "OLEO DE COCO COPRA EXTRA VIRGEM SCH 15ML", "foto": "http://images.precodahora.ba.gov.br/default" },
    { "gtin": 7898596080604, "descricao": "OLEO DE COCO SHOW EXTVIRG 200ML", "foto": "http://images.precodahora.ba.gov.br/default" }
  ],
  "totalRegistros": 10,
  "tempoResposta": 0.009342432022094727
}
```

- `gtin` vem como **número** (JSON), então pode perder zero à esquerda; convertemos com `String(n)` e só aceitamos
  8–14 dígitos (o resto é descartado). `descricao` vem em caixa alta, sem acento. `dataConsulta` não tem fuso.
- Devolveu no máximo 10 registros nesse teste (`totalRegistros: 10`). Não observamos "sem resultados" ao vivo; o cliente
  trata `codigo: 50` como lista vazia (igual ao `/produtos/`), `codigo: 70`/401 como sessão inválida (renova uma vez) e
  429/redirect para `/challenge/`/HTML no lugar de JSON como bloqueio (`PdhError.blocked`).
- Limite: o mesmo bloqueio por IP (~20 POSTs / 15 min). Por isso cada termo é cacheado em `product_suggestions` por 7 dias.

`suggestPrecoDaHora(termo): Promise<{ gtin: string; descricao: string }[]>` — dedup por gtin, ordem do site.

## `POST /api/produtos/sugerir`

Body `{ termo: string }`. Resposta `{ ok: true, sugestoes: ProductSuggestion[], fonteExterna: boolean, aviso?: string }`.

| Situação | Status |
| --- | --- |
| Sem login | 401 |
| Sem casa | 403 |
| `termo` com menos de 5 caracteres (espaços contam; espaços repetidos viram um) ou sem letras/dígitos | 400 |
| Preço da Hora bloqueado/indisponível | **200** com só o local e `fonteExterna: false` (+ `aviso`) |

Passos:

1. **Local (sempre)**: `products` com `gtin` não nulo e `normalized_name ilike '%<termKey>%'` (até 10); se o termo tem mais
   de uma palavra, também os que contêm **todas** as palavras (≥ 2 letras), até 10 no total. `termKey = normalizeName(termo)`.
2. **Externo**: `product_suggestions[termKey]` com `fetched_at` < 7 dias → usa os gtins cacheados (busca em `products`).
   Senão chama `/sugestao/`, faz `upsert` em `products` (`onConflict: "gtin"`, `name = descricao`, `category` preservada)
   e grava o cache (inclusive lista vazia, para não repetir a consulta). Se o PdH falhar e houver cache vencido, usa o
   vencido (`fonteExterna: true` + `aviso`); sem nada, `fonteExterna: false`.
3. **`ultimaCompra`**: observação mais recente do household com esse gtin e `source in ('nfce','manual')`
   (`{ loja: stores.name, preco, data }`).
4. **Ordem**: locais com compra (mais recente primeiro) → demais locais → externos (ordem do PdH). Dedup por gtin
   (local vence), máximo 12. `origem` = `"local"` ou `"precodahora"`.

## `GET /api/produtos/[gtin]?storeId=`

Resposta `{ ok: true, produto, precoSugerido, aviso? }` (`ProductLookup`). `gtin` com 8–14 dígitos (400 se inválido);
`storeId` opcional, uuid (400 se malformado). 401 sem login, 403 sem casa.

- Procura em `products`. Se não existir: `searchPrecoDaHora({ gtin, lat/lng da casa (fallback: centro de Salvador),
  raioKm: 30, horas: 720, maxResultados: 25 })`; com resultado, cria o produto com a descrição do primeiro e grava as
  observações como `precodahora` (lojas criadas/encontradas por CNPJ ou nome+endereço, duplicatas ignoradas).
  Se o PdH falhar/bloquear: `produto: null` + `aviso` (não é 5xx).
- `precoSugerido`: observação mais recente do gtin (qualquer fonte, visível ao household via RLS). Com `storeId`, tenta
  primeiro essa loja; se ela não tiver observação, cai para qualquer loja (o campo `loja` diz de onde veio).

## `POST /api/itens/categorizar`

Body `{ nomes: string[] }` (máx. 50; 400 acima disso ou com não-strings). Resposta
`{ ok: true, categorias: Record<nome, categoria>, falhas?: string[] }`.

1. `item_key = normalizeName(nome)`; consulta `item_categories` (cache **global**, não por casa).
2. Faltantes → **uma** chamada ao Groq (`categorizeNames` em `src/lib/llm/categorize.ts`: prompt em português com a lista
   `CATEGORIES` e exemplos, `reasoning_effort: low`, saída `{ "itens": [{ "nome", "categoria" }] }`, validada com
   `isCategory`). Grava `item_categories` com `source='llm'` via `upsert(..., { ignoreDuplicates: true })` — ON CONFLICT DO
   NOTHING, portanto nunca sobrescreve uma linha existente (inclusive `source='user'`).
3. Atualiza `list_items.category` das listas do household do usuário para os `normalized_name`s resolvidos (cache + IA),
   um `update` por categoria.
4. Nomes sem categoria (Groq indisponível, sem `GROQ_API_KEY`, resposta inválida) recebem `DEFAULT_CATEGORY` na resposta,
   **sem** gravar cache nem `list_items` (para tentar de novo depois). O motivo vai em `falhas`.

## Helpers (`src/lib/products/server.ts`)

`parseGtin`, `getHousehold(db, userId)` (primeira casa + lat/lng), `findProductByGtin`, `findProductsByGtins`,
`upsertProductsByGtin` (nome limitado a 200 caracteres, check da tabela), `lastPurchasesByGtin`, `suggestedPrice`,
`recordPdhObservations` (find-or-create de loja + insert ignorando duplicatas — mesma regra de `/api/precos/atualizar`).

## Pendências / notas

- Depende da migration `0004_compras.sql` (`products.category`, `list_items.category`, `item_categories`,
  `product_suggestions`); o código foi escrito contra `src/lib/database.types.ts`.
- `resolveStoreId`/insert de observações estão duplicados entre `src/lib/products/server.ts` e
  `src/app/api/precos/atualizar/route.ts` (candidato a extrair para um módulo comum).
- Teste ao vivo do `/sugestao/`: `node --experimental-strip-types <script>` importando `suggestPrecoDaHora` (1 POST).
