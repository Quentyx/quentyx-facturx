'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fx = require('../evoyx');
const { base } = require('./_facture');

const xml = fx.versXml(base());
const avant = (a, b, depuis) => { const d = depuis ? xml.indexOf(depuis) : 0; const i = xml.indexOf(a, d), j = xml.indexOf(b, d); assert.ok(i >= 0 && j >= 0 && i < j, a + ' doit preceder ' + b); };

test('profil EN 16931 declare', () => {
  assert.match(xml, /<ram:GuidelineSpecifiedDocumentContextParameter>\s*<ram:ID>urn:cen\.eu:en16931:2017<\/ram:ID>/);
  assert.doesNotMatch(xml, /minimum/i);
});
test('ordre du schema CII respecte aux endroits sensibles', () => {
  avant('<rsm:ExchangedDocumentContext>', '<rsm:ExchangedDocument>');
  avant('<ram:IncludedSupplyChainTradeLineItem>', '<ram:ApplicableHeaderTradeAgreement>');
  avant('<ram:ApplicableHeaderTradeAgreement>', '<ram:ApplicableHeaderTradeDelivery');
  avant('<ram:InvoiceCurrencyCode>', '<ram:SpecifiedTradeSettlementPaymentMeans>');
  avant('<ram:SpecifiedTradeSettlementPaymentMeans>', '<ram:ApplicableTradeTax>', '<ram:ApplicableHeaderTradeSettlement>');
  avant('<ram:CalculatedAmount>', '<ram:BasisAmount>', '<ram:ApplicableHeaderTradeSettlement>');
  avant('<ram:LineTotalAmount>84.97', '<ram:TaxBasisTotalAmount>', '<ram:SpecifiedTradeSettlementHeaderMonetarySummation>');
  avant('<ram:GrandTotalAmount>', '<ram:DuePayableAmount>');
});
test('totaux du XML egaux aux totaux calcules', () => {
  const t = fx.valider(base()).totaux;
  assert.match(xml, new RegExp('<ram:GrandTotalAmount>' + (Number(t.total_ttc) / 100).toFixed(2) + '</ram:GrandTotalAmount>'));
  assert.match(xml, /<ram:TaxTotalAmount currencyID="EUR">13\.37<\/ram:TaxTotalAmount>/);
});
test('identifiants : SIREN en 0002, TVA en VA, IBAN sans espace', () => {
  assert.match(xml, /<ram:ID schemeID="0002">123456789<\/ram:ID>/);
  assert.match(xml, /<ram:ID schemeID="VA">FR12123456789<\/ram:ID>/);
  assert.match(xml, /<ram:IBANID>FR7630006000011234567890189<\/ram:IBANID>/);
});
test('les caracteres speciaux sont echappes', () => {
  const f = base(); f.acheteur.nom = 'A & B <SAS>';
  assert.match(fx.versXml(f), /A &amp; B &lt;SAS&gt;/);
});
test('XML bien forme selon lxml, un analyseur qui n est pas le notre', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const f = path.join(d, 'f.xml');
  fs.writeFileSync(f, xml);
  try { execFileSync('python3', ['-c', 'import lxml'], { stdio: 'ignore' }); } catch (_) { return t.skip('lxml absent'); }
  execFileSync('python3', ['-c', 'import sys; from lxml import etree; etree.parse(sys.argv[1])', f]);
});
