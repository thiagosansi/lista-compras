/**
 * Testes leves do parser (sem framework). Como rodar (na raiz do projeto):
 *
 *   OUT=/tmp/nfce-test && pnpm exec tsc src/lib/nfce/parse.ts src/lib/nfce/parse.test.ts \
 *     --outDir "$OUT" --module commonjs --target es2022 --types node --skipLibCheck \
 *   && node --test "$OUT/parse.test.js"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  isValidGtin,
  mergeGtins,
  parseBrDateTime,
  parseBrNumber,
  parseNfceHtml,
  parseProductsTab,
  NfceParseError,
} from "./parse";

function fixture(name: string): string {
  // Compilado para fora do src: resolve a partir da raiz do projeto.
  return readFileSync(path.join(process.cwd(), "src/lib/nfce/__fixtures__", name), "utf8");
}

test("parseBrNumber", () => {
  assert.equal(parseBrNumber("1.234,56"), 1234.56);
  assert.equal(parseBrNumber("16,182"), 16.182);
  assert.equal(parseBrNumber("0.00"), 0);
  assert.equal(parseBrNumber("R$ 7,89"), 7.89);
  assert.equal(parseBrNumber(""), null);
  assert.equal(parseBrNumber("abc"), null);
});

test("parseBrDateTime", () => {
  assert.equal(parseBrDateTime("24/07/2025 18:18:27-03:00"), "2025-07-24T18:18:27-03:00");
  assert.equal(parseBrDateTime("15/10/2021 12:54:13"), "2021-10-15T12:54:13-03:00");
  assert.equal(parseBrDateTime("xx"), null);
});

test("isValidGtin", () => {
  assert.equal(isValidGtin("7891000100103"), true); // EAN-13 válido
  assert.equal(isValidGtin("7891000100104"), false);
  assert.equal(isValidGtin("2478"), false);
  assert.equal(isValidGtin("00000000"), false);
});

test("parseNfceHtml lê o DANFE sintético real da Sefaz-BA", () => {
  const r = parseNfceHtml(fixture("danfe-ba-sintetico.html"));
  assert.equal(r.accessKey, "00000000000000000000000000000000000000000000");
  assert.equal(r.store.cnpj, "11322064001288");
  assert.equal(r.store.name, "SOBRAL & FILHOS COMERCIO DE COMBUSTIVEIS LTDA -POSTO SAO");
  assert.equal(r.store.address, "AV GENERAL GRACA LESSA, 305, ENGENHO VELHO DE BROTAS, SALVADOR, BA");
  assert.equal(r.store.city, "SALVADOR");
  assert.equal(r.issuedAt, "2025-07-24T18:18:27-03:00");
  assert.equal(r.total, 100);
  assert.equal(r.items.length, 1);
  assert.deepEqual(r.items[0], {
    description: "GASOLINA COMUM Bico 10",
    code: "2478",
    gtin: null,
    quantity: 16.182,
    unit: "L",
    unitPrice: 6.18,
    total: 100,
  });
});

test("parseNfceHtml: vários itens, desconto e código GTIN", () => {
  const html = `
<span id="txt_xslt">
<div class="txtCenter">
  <div id="u20" class="txtTopo">MERCADO &amp;amp; CIA LTDA</div>
  <div class="text">CNPJ: 22.839.426/0001-76</div>
  <div class="text">RUA ITABUNA, 196, TERREO, RIO VERMELHO, SALVADOR, BA</div>
</div>
<table id="tabResult">
  <tr id="Item + 1"><td><span class="txtTit">ARROZ TIPO 1 5KG</span><span class="RCod">(Código: 7891000100103)</span><br>
    <span class="Rqtd"><strong>Qtde.:</strong>2</span><span class="RUN"><strong>UN: </strong>UN</span>
    <span class="RvlUnit"><strong>Vl. Unit.:</strong>&nbsp;27,9</span></td>
    <td class="txtTit noWrap">Vl. Total<br><span class="valor">55,80</span></td></tr>
  <tr id="Item + 2"><td><span class="txtTit">BANANA PRATA</span><span class="RCod">(Código: 00958)</span><br>
    <span class="Rqtd"><strong>Qtde.:</strong>1,235</span><span class="RUN"><strong>UN: </strong>KG</span>
    <span class="RvlUnit"><strong>Vl. Unit.:</strong>&nbsp;1.234,56</span></td>
    <td class="txtTit noWrap">Vl. Total<br><span class="valor">1.524,68</span></td></tr>
</table>
<div id="totalNota">
  <div id="linhaTotal"><label>Qtd. total de itens:</label><span class="totalNumb">2</span></div>
  <div id="linhaTotal"><label>Valor total R$:</label><span class="totalNumb">1.580,48</span></div>
  <div id="linhaTotal"><label>Descontos R$:</label><span class="totalNumb">5,00</span></div>
  <div id="linhaTotal" class="linhaShade"><label>Valor a pagar R$:</label><span class="totalNumb txtMax">1.575,48</span></div>
</div>
<li><strong>Número: </strong>179850<strong> Série: </strong>1<strong> Emissão: </strong>01/10/2023 23:00:15-03:00  - Via Consumidor</li>
<span class="chave">1111 1111 1111 1111 1111 1111 1111 1111 1111 1111 1111</span>
</span>`;
  const r = parseNfceHtml(html);
  assert.equal(r.accessKey, "11111111111111111111111111111111111111111111");
  assert.equal(r.store.name, "MERCADO & CIA LTDA");
  assert.equal(r.store.city, "SALVADOR");
  assert.equal(r.total, 1575.48);
  assert.equal(r.issuedAt, "2023-10-01T23:00:15-03:00");
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].gtin, "7891000100103");
  assert.equal(r.items[0].unitPrice, 27.9);
  assert.equal(r.items[1].gtin, null);
  assert.equal(r.items[1].code, "00958");
  assert.equal(r.items[1].quantity, 1.235);
  assert.equal(r.items[1].unit, "KG");
  assert.equal(r.items[1].unitPrice, 1234.56);
  assert.equal(r.items[1].total, 1524.68);
});

test("parseNfceHtml: página de erro do qrcode.aspx", () => {
  const html = `<span id="lblInformacao" class="validacao">[QRCode v2.00]: Problema(s) apresentado(s) no QR Code: <br /> Hash do QR Code diferente de 40 caracteres. <br /></span>`;
  assert.throws(() => parseNfceHtml(html), (e: unknown) => e instanceof NfceParseError && /Hash do QR Code/.test(e.message));
});

test("parseNfceHtml: página de captcha (consulta por chave)", () => {
  const html = `<form><input name="txt_cod_antirobo" /><img id="img_captcha" src="x" /></form>`;
  assert.throws(() => parseNfceHtml(html), (e: unknown) => e instanceof NfceParseError && /captcha/i.test(e.message));
});

test("parseProductsTab + mergeGtins", () => {
  const rows = parseProductsTab(fixture("abas-produtos-ba.html"));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { number: 1, description: "GASOLINA COMUM Bico 10", code: "2478", gtin: null });

  const tab = fixture("abas-produtos-ba.html").replace(
    '<label>Código EAN Comercial</label><span class="linha">SEM GTIN</span>',
    '<label>Código EAN Comercial</label><span class="linha">7891000100103</span>',
  );
  const withGtin = parseProductsTab(tab);
  assert.equal(withGtin[0].gtin, "7891000100103");

  const receipt = parseNfceHtml(fixture("danfe-ba-sintetico.html"));
  const merged = mergeGtins(receipt, withGtin);
  assert.equal(merged.items[0].gtin, "7891000100103");
  // Produto diferente na mesma posição não é aceito.
  const other = mergeGtins(receipt, [{ number: 1, description: "OUTRO", code: "999", gtin: "7891000100103" }]);
  assert.equal(other.items[0].gtin, null);
});
