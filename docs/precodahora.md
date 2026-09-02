# Preço da Hora BA — integração (API privada, não oficial)

Resultado do spike de viabilidade (`scripts/pdh-spike.mjs`, rodado em 01/09/2026 de um IP residencial em Salvador)
e referência do cliente `src/lib/precodahora/client.ts`.

## TL;DR

- **Funciona sem captcha** a partir de um IP residencial: GET para pegar sessão + token, POST para buscar.
  Busca por termo ("leite integral": 1.622 registros, 4 páginas) e por GTIN (7896051130079: 24 registros) retornaram
  JSON completo com preço, data, loja, CNPJ, endereço, lat/lng e distância.
- Não há API pública; usamos os mesmos endpoints que o site (Flask + jQuery). Pode mudar/quebrar sem aviso.
- Anti-bot: reCAPTCHA v2 em `/challenge/`. O site redireciona para lá quando a chamada XHR recebe **HTTP 429**.
  Não vimos 429 durante o spike (poucas dezenas de chamadas), mas é o cenário provável para IPs de datacenter (Vercel)
  ou muitas buscas em sequência. **Precisa ser verificado após o deploy.**
- Referências lidas: `Pedneri1/precodahora-api` (Node), `igorpereirag/precodahora_api` (Java), `danielmark/precodahora` (PHP).
  Os três fazem o mesmo fluxo abaixo; o site também expõe `POST /sugestao/` (`item=...`) para autocomplete (não usamos).

## Fluxo de sessão

1. `GET https://precodahora.ba.gov.br/produtos/` (ou `/`) com `User-Agent` de navegador.
   - Devolve `Set-Cookie: session=<Flask signed cookie>` (contém o `csrf_token`), `token=...` e `cookiesession1=...`
     (balanceador). **Só o cookie `session` é obrigatório** (testado).
   - No HTML: `<meta id="validate" data-id="<token CSRF>" />`. É este valor que vai no header `X-CSRFToken`.
     (Os wrappers procuram `#validate`; hoje é um `<meta>`, não `<input>`.)
   - Há também `<meta id="rc" data-id="" />` e o markup oculto do reCAPTCHA (`data-sitekey`) em **toda** página —
     a presença de `data-sitekey` no HTML não significa bloqueio.
2. `POST https://precodahora.ba.gov.br/produtos/`
   - Headers: `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`, `X-CSRFToken: <token>`, `Cookie: session=...`.
     `X-Requested-With: XMLHttpRequest`, `Origin`, `Referer` e `User-Agent` não foram exigidos, mas enviamos por segurança.
   - Body (form): `termo`, `gtin`, `cnpj`, `horas` (72), `anp`, `codmun`, `latitude`, `longitude`, `raio` (km),
     `precomax` (0), `precomin` (0), `pagina` (1..N), `ordenar` (`preco.asc` | `preco.desc`), `categorias`,
     `processo` (`carregar`), `totalCategorias`, `totalRegistros`, `totalPaginas`, `pageview` (`lista`).
     O conjunto mínimo que funcionou: `termo|gtin`, `latitude`, `longitude`, `raio`, `horas`, `pagina`, `ordenar`.
   - Paginação fixa em **25 registros por página** (`registrosporPagina`); `totalPaginas` vem na resposta.

O token CSRF é validado contra o cookie `session` (WTF-CSRF): token e cookie precisam ser da **mesma** sessão.
Não observamos expiração no spike; o cliente renova a cada 20 min ou ao receber 401/`codigo 70`.

## Respostas observadas

| Situação | HTTP | Body |
| --- | --- | --- |
| Sucesso | 200 `application/json` | `{ codigo: 80, dataConsulta, pagina, totalRegistros, totalPaginas, registrosporPagina: 25, registrosdaPagina, dias, categorias[], centro{latitude,longitude,raio}, intervaloPreco{min,max}, resultado[] }` |
| Sem resultados | 202 `application/json` | `{ codigo: 50, descricao: "Nenhum resultado encontrado!" }` |
| Sem `termo`/`gtin` | 202 `application/json` | `{ codigo: 30, descricao: "Nenhum parâmetro de busca foi informado." }` |
| Cookie/CSRF ausente ou inválido | 401 `application/json` | `{ codigo: 70, descricao: "Acesso não autorizado!" }` |
| Bloqueio anti-bot (não reproduzido) | 429 (o JS do site faz `location.href = '/challenge/'`) | página HTML com reCAPTCHA v2 (`data-sitekey="6LduItEU..."`) |

O front-end do site trata `status === 429 → /challenge/` e `status === 205 → reaproveita o JSON anterior`.

### Registro bruto (`resultado[i]`)

```json
{
  "produto": {
    "score": null, "codProduto": "7898939247015", "farmaciaPopular": false, "tipoNFe": 65,
    "gtin": 7898939247015, "anp": null, "ncm": 4012010, "cod_nfce": "23804419215",
    "ncmGrupo": "LEITES E DERIVADOS", "descricao": "LEITE LEITISSIMO INTEGRAL 1X1LT",
    "precoUnitario": 12.2900000483, "precoLiquido": 2.46, "precoBruto": 2.46, "desconto": 9.8300000483,
    "unidade": "UN", "data": "2026-09-01 22:40:06-00:00",
    "intervalo": "há 1 hora(s), 54 minuto(s) e 0 segundo(s)", "timeSpan": 6840,
    "foto": "https://api.precodahora.ba.gov.br/v1/images/7898939247015"
  },
  "estabelecimento": {
    "nomeEstabelecimento": "ALMACEN PEPE HORTO", "endLogradouro": "AVENIDA SANTA LUZIA", "endNumero": "000985",
    "cep": "40295050", "bairro": "HORTO FLORESTAL", "codMunicipio": 2927408, "municipio": "SALVADOR", "uf": "BA",
    "cnpj": "60238520000169", "farmaciaPopular": false, "telefone": "7132518050",
    "latitude": -13.0038732, "longitude": -38.4859516, "tentativa": 2, "distancia": 3.3682
  }
}
```

Observações sobre os dados:

- `data` vem em UTC com sufixo `-00:00` (bate com `dataConsulta` e o `intervalo`). Convertida para ISO `Z`.
- `precoUnitario` é o preço unitário da nota; `precoLiquido`/`desconto` são pouco confiáveis (descontos de cupom
  inteiro aparecem em um item só: 12,29 → 2,46). **Usamos `precoUnitario`**, com fallback para `precoLiquido`.
- `gtin` vem como número (pode perder zero à esquerda); `codProduto` é string — preferimos `codProduto`.
- `cnpj` veio como string com 14 dígitos; nos wrappers antigos era número (13 dígitos sem o zero) — tratamos os dois.
- `unidade` observadas: `UN`, `UND`, `UND1`, `PC`, `CX`, `L`, `LT`. `tipoNFe`: 65 (NFC-e) e 55 (NF-e).
- `endNumero` vem com zeros à esquerda (`000985`). Endereço montado como `LOGRADOURO, 985 - BAIRRO`.
- `distancia` em km a partir de `latitude/longitude` enviados.

## Mapeamento para `PdhResult` (`src/lib/database.types.ts`)

| `PdhResult` | origem |
| --- | --- |
| `descricao` | `produto.descricao` |
| `gtin` | `produto.codProduto` (8–14 dígitos) senão `produto.gtin`; senão `null` |
| `preco` | `produto.precoUnitario` > 0, senão `produto.precoLiquido`; 2 casas |
| `unidade` | `produto.unidade` |
| `data` | `produto.data` → ISO UTC |
| `loja.nome` | `estabelecimento.nomeEstabelecimento` |
| `loja.cnpj` | `estabelecimento.cnpj` (14 dígitos, completa zero à esquerda se vier com 13) |
| `loja.endereco` | `endLogradouro, endNumero - bairro` |
| `loja.cidade` | `estabelecimento.municipio` |
| `loja.lat/lng` | `estabelecimento.latitude/longitude` |
| `loja.distanciaKm` | `estabelecimento.distancia` |

Registros sem descrição, loja, data ou preço > 0 são descartados.

## Cliente (`src/lib/precodahora/client.ts`)

- `searchPrecoDaHora({ termo?, gtin?, lat, lng, raioKm = 10, horas = 72, maxResultados = 25 })` → `PdhResult[]`
  (ordenado por preço crescente, pagina até `maxResultados`, teto 100).
- Sessão (cookie + CSRF) em cache de módulo, com dedupe de renovação concorrente; TTL 20 min; renovada uma vez ao
  receber 401/`codigo 70`.
- Timeout de 15 s por requisição (`AbortController`).
- `PdhError { kind: "challenge" | "unauthorized" | "timeout" | "network" | "invalid_response" | "bad_request" }`;
  `blocked === true` para `challenge`/`unauthorized` (a rota `atualizar` para de buscar os itens restantes).
  Consideramos challenge: HTTP 429, redirect para `/challenge/`, ou HTML no lugar de JSON.

## Rotas

- `POST /api/precos/buscar` — body `{ termo?, gtin?, lat, lng, raioKm?, horas? }` → `{ ok: true, resultados }`;
  400 em body inválido, 401 sem login, 502 quando o Preço da Hora falhar/bloquear.
- `POST /api/precos/atualizar` — body `{ listId }` → `{ ok: true, itens, observacoes, falhas[] }`.
  Itens não marcados; GTIN quando houver, senão `termo = name`; lat/lng do household (fallback centro de Salvador);
  até 8 resultados por item; pool de 3 buscas em paralelo; `stores` por CNPJ (senão nome+endereço, casando com o
  índice único parcial); `price_observations` com `source = "precodahora"`, duplicatas ignoradas (23505).
  Como o índice único usa expressões (`coalesce(gtin,'')`, coluna gerada), não dá para usar `onConflict` do PostgREST;
  o lote é inserido de uma vez e, se houver 23505, reinserido linha a linha ignorando as duplicadas.

## Limitações / riscos

- **IP da Vercel**: datacenters costumam cair no 429 → `/challenge/`. Verificar nos logs após o deploy
  (erro `PdhError kind=challenge`). Se bloquear, alternativas: rodar a busca a partir de outra origem
  (ex.: Cloudflare Worker, VPS barata, ou o próprio celular via rota client-side — CORS não permite),
  ou reduzir a frequência (cache por termo/dia).
- **Rate limit desconhecido**: mantemos ≤ 3 buscas em paralelo e ≤ 4 páginas por busca.
- **Formato pode mudar**: o cliente trata todos os campos como opcionais e descarta registros incompletos.
- **Cobertura**: só notas emitidas na BA nas últimas `horas`; itens com nome genérico ("pão") trazem muita coisa
  irrelevante — o casamento fino com o item fica por conta de `best_prices` (trigram/GTIN).
- Rodar `node scripts/pdh-spike.mjs` de novo é a forma mais rápida de checar se o fluxo continua válido.
