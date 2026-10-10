# NFC-e Bahia — importação de cupons

Pesquisa feita em 01/09/2026 com `curl` contra o portal real e validada com fixtures
sintéticas. Nenhuma chave de acesso real é mantida neste repositório.

## URLs

| Uso | URL | Observação |
| --- | --- | --- |
| QR code impresso (NFC-e 4.0, QR v2) | `http://nfe.sefaz.ba.gov.br/servicos/nfce/qrcode.aspx?p=<chave44>\|<versão>\|<ambiente>\|<idCSC>\|<hash40>` | É o que o app lê. Sem o hash válido (40 hex) a página devolve erro (`#lblInformacao`). |
| Consulta por chave (formulário) | `http://nfe.sefaz.ba.gov.br/servicos/nfce/modulos/geral/NFCEC_consulta_chave_acesso.aspx` | **Tem captcha** (`txt_cod_antirobo` + `../AntiRobo/NFCEC_anti_robo.aspx`). Importar só pela chave não é possível. |
| DANFE sintético (com itens) | `http://nfe.sefaz.ba.gov.br/servicos/nfce/Modulos/Geral/NFCEC_consulta_danfe.aspx` | Só funciona com o cookie de sessão criado pelo `qrcode.aspx`; sem ele redireciona para o formulário com captcha. |
| Visão completa em abas | `.../Modulos/Geral/NFCEC_consulta_abas.aspx` | Postback ASP.NET a partir do DANFE; aba "Produtos e Serviços" traz o **GTIN** (`Código EAN Comercial`). |

Fluxo real de redirects (cookie `ASP.NET_SessionId` obrigatório entre eles):

```
GET qrcode.aspx?p=...           → 302 NFCEC_consulta_chave_acesso.aspx?chave_acesso_qrcode=<chave>  (Set-Cookie)
GET consulta_chave_acesso...    → 302 NFCEC_consulta_danfe.aspx
GET NFCEC_consulta_danfe.aspx   → 200 HTML (utf-8, ~15 KB)
```

`fetch` do Node não repassa cookies entre redirects, por isso `src/lib/nfce/fetch.ts` segue os redirects manualmente.

Outras constatações:

- `https://nfe.sefaz.ba.gov.br` responde, mas a cadeia de certificados é incompleta: Node (`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`) e curl falham. O QR code usa `http://` e o app força `http`.
- Sem captcha no caminho do QR code. Sem rate limit percebido nos testes.
- Só o host `nfe.sefaz.ba.gov.br` e o path `/servicos/nfce/qrcode.aspx` são aceitos (proteção contra SSRF).
- As fixtures de validação usam dados sintéticos; nenhuma chave de acesso real é necessária para os testes.

## Estrutura do HTML (DANFE sintético)

Layout "nfceMob" gerado por XSLT (`arquivos_xslt/nfceMob.css`). O conteúdo aparece duas vezes: em base64 dentro de `__VIEWSTATE` e renderizado dentro de `<span id="txt_xslt">`. O parser usa só o segundo.

```html
<div class="txtCenter">
  <div id="u20" class="txtTopo">NOME DO EMITENTE</div>           <!-- pode vir duplamente escapado: &amp;amp; -->
  <div class="text">CNPJ: 11.322.064/0012-88</div>
  <div class="text">LOGRADOURO, NUMERO, COMPLEMENTO, BAIRRO, MUNICIPIO, UF</div>   <!-- partes vazias viram ", ," -->
</div>
<table id="tabResult">
  <tr id="Item + 1">
    <td>
      <span class="txtTit">DESCRIÇÃO</span>
      <span class="RCod">(Código: 2478)</span>            <!-- cProd do emitente; às vezes é o próprio EAN -->
      <span class="Rqtd"><strong>Qtde.:</strong>16,182</span>
      <span class="RUN"><strong>UN: </strong>L</span>
      <span class="RvlUnit"><strong>Vl. Unit.:</strong> 6,18</span>
    </td>
    <td class="txtTit noWrap">Vl. Total<br><span class="valor">100,00</span></td>
  </tr>
</table>
<div id="totalNota">
  <div id="linhaTotal"><label>Qtd. total de itens:</label><span class="totalNumb">1</span></div>
  <div id="linhaTotal"><label>Valor total R$:</label><span class="totalNumb">…</span></div>      <!-- só quando há desconto -->
  <div id="linhaTotal"><label>Descontos R$:</label><span class="totalNumb">…</span></div>        <!-- idem -->
  <div id="linhaTotal" class="linhaShade"><label>Valor a pagar R$:</label><span class="totalNumb txtMax">100,00</span></div>
  <div id="linhaForma"><label>Forma de pagamento:</label>…</div>
</div>
<div id="infos">
  <li><strong>Número: </strong>242758<strong> Série: </strong>1<strong> Emissão: </strong>24/07/2025 18:18:27-03:00 - Via Consumidor …</li>
  <li>… <strong>Chave de acesso:</strong><br><span class="chave">CHAVE-FICTICIA</span></li>
  <li><strong>CPF: </strong>…</li>                                  <!-- consumidor; não é armazenado -->
</div>
```

Página de erro do `qrcode.aspx`: `<span id="lblInformacao" class="validacao">…</span>` (ex.: "Hash do QR Code diferente de 40 caracteres", "Parâmetros essenciais ausentes").

### Aba "Produtos e Serviços" (GTIN)

Dois postbacks (campos `__VIEWSTATE`, `__VIEWSTATEGENERATOR`, `__EVENTVALIDATION` da página anterior):

1. `POST NFCEC_consulta_danfe.aspx` com `btn_visualizar_abas=Visualizar em Abas` → 302 `NFCEC_consulta_abas.aspx`.
2. `POST NFCEC_consulta_abas.aspx` com `btn_aba_produtos.x=12&btn_aba_produtos.y=12` (botão de imagem) → HTML com `<span id="uc_aba_produtos_txt_xslt">`.

Cada produto é `<table class="toggle">` (Número, Descrição, Qtd., Unidade Comercial, Valor) seguido de `<table class="toggable" id="table-N">` com `<label>Código do Produto</label><span class="linha">…</span>`, `<label>Código EAN Comercial</label><span class="linha">7891…</span>` (ou `SEM GTIN`), `Valor unitário de comercialização` etc.

Essa etapa é opcional em `fetchNfce()` (falha silenciosa) e só preenche `gtin` quando o EAN tem dígito verificador válido e o item bate por código ou descrição.

## Código

- `src/lib/nfce/parse.ts` — `parseNfceHtml(html)`, `parseProductsTab(html)`, `mergeGtins()`, utilitários (`parseBrNumber`, `parseBrDateTime`, `isValidGtin`). Sem dependências.
- `src/lib/nfce/fetch.ts` — `resolveNfceTarget(texto)` valida o QR; `fetchNfce(texto)` baixa (timeout 15 s, User-Agent de navegador, cookies manuais) e devolve `{ receipt, sourceUrl, enriched }`.
- `src/lib/nfce/parse.test.ts` + `__fixtures__/` — HTML real anonimizado (CPF/vendedor). Rodar:

  ```sh
  OUT=/tmp/nfce-test && pnpm exec tsc src/lib/nfce/parse.ts src/lib/nfce/parse.test.ts \
    --outDir "$OUT" --module commonjs --target es2022 --types node --skipLibCheck --esModuleInterop \
  && node --test "$OUT/parse.test.js"
  ```

- `src/app/api/nfce/importar/route.ts` — `POST { url }`: 400 entrada inválida, 401/403 sem sessão/casa, 409 "Cupom já importado", 422 QR inválido/chave sem QR/parse, 502/504 Sefaz fora. Grava `stores` (upsert por CNPJ), `receipts`, `receipt_items`, `price_observations` (source `nfce`, `price` = valor unitário, `observed_at` = emissão).
- `src/app/cupom/page.tsx` + `src/components/cupom/*` — leitor de QR (`BarcodeDetector` nativo ou `jsqr` a cada 250 ms), campo para colar o link, resumo do cupom, últimos 10 cupons.

## Pendências / limitações

- Importar só pela chave de 44 dígitos: bloqueado pelo captcha da Sefaz-BA. O app orienta a escanear o QR.
- Cupons de outros estados: rejeitados (host diferente). Cada UF tem portal próprio.
- O layout sintético é o mesmo em vários estados (RJ, RS, MG…), mas os redirects/cookies são específicos da BA.
- Validado com um cupom de 1 item sem GTIN; cupom de supermercado com vários itens e desconto foi coberto só por fixture sintética baseada em um printout real do mesmo layout.
