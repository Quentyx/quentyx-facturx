'use strict';
/*
 * LA LECTURE D UNE FACTURE RECUE.
 *
 * La preuve la plus forte : une facture lue puis reecrite par le moteur rend
 * EXACTEMENT le XML d origine, octet pour octet. Rien n est perdu, rien n est
 * invente.
 *
 * Les fichiers de test/donnees/ ne viennent PAS de ce moteur (voir leur README) :
 * UBL converti par Mustang, Factur-X assemble par PDFBox, PDF a flux d objets
 * ecrit par pdf-lib. Un lecteur qui ne lirait que ses propres fichiers ne
 * prouverait rien.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fx = require('../evoyx');
const { base, gabaritMaison } = require('./_facture');

const donnee = (f) => fs.readFileSync(path.join(__dirname, 'donnees', f));

const cas = {
  'taux normal et reduit': () => base(),
  'franchise en base, reglee par carte': () => Object.assign(base(), {
    lignes: [{ libelle: 'Abonnement', prix_unitaire_ht: 39, tva: { categorie: 'E' } }],
    exonerations: { E: { motif: 'TVA non applicable, art. 293 B du CGI', code: 'VATEX-FR-FRANCHISE' } },
    vendeur: Object.assign(base().vendeur, { tva: '', id_fiscal: '123456789' }),
    paiement: { moyen: 'carte', deja_paye: '39', reference: 'sq-1' }, date_echeance: '',
  }),
  'avoir': () => Object.assign(base(), { type: 'avoir', numero: 'AV-2026-0001',
    references: { facture_precedente: { numero: 'T-2026-0001', date: '2026-10-01' } } }),
  'abonnement, livraison, commande et contrat': () => Object.assign(base(), {
    periode: { debut: '2026-10-01', fin: '2026-10-31' }, date_livraison: '2026-10-01',
    references: { commande: 'CMD-7', contrat: 'CTR-2026' },
    acheteur: Object.assign(base().acheteur, { reference: 'SERVICE-ACHATS', tva: 'FR32987654321' }),
    lignes: [{ id: 'A1', reference: 'ABO-M', libelle: 'Abonnement', description: 'Offre mensuelle', unite: 'MON',
      quantite: '1', prix_unitaire_ht: '49.9', tva: { categorie: 'S', taux: 20 }, periode: { debut: '2026-10-01', fin: '2026-10-31' } }],
    paiement: { moyen: 'prelevement', iban: 'FR7630006000011234567890189', reference: 'RUM-1', conditions: 'Preleve a 30 jours' },
  }),
};

for (const [nom, fabrique] of Object.entries(cas)) {
  test('aller-retour par notre PDF, octet pour octet : ' + nom, () => {
    const p = fx.produire(fabrique());
    const l = fx.lire(p.pdf);
    assert.strictEqual(l.ok, true, l.erreur);
    assert.strictEqual(l.format, 'facturx');
    assert.strictEqual(l.profil, 'urn:cen.eu:en16931:2017');
    assert.strictEqual(l.xml, p.xml, 'le XML joint est celui que le moteur a ecrit');
    assert.strictEqual(fx.versXml(l.facture), p.xml, 'la facture lue se reecrit a l identique');
    assert.deepStrictEqual(l.ecarts, []);
    assert.deepStrictEqual(l.non_lus, []);
    assert.deepStrictEqual(l.notes, []);
    assert.strictEqual(l.controle.ok, true);
    assert.deepStrictEqual({ pa: l.pdf.piece_jointe, rel: l.pdf.relation, pdfa: l.pdf.pdfa_declare, profil: l.pdf.profil_declare },
      { pa: 'factur-x.xml', rel: 'Alternative', pdfa: '3B', profil: 'EN 16931' });
  });
}

test('le PDF d un gabarit maison se lit comme les autres', () => {
  const p = fx.produire(base(), { gabarit: gabaritMaison });
  assert.strictEqual(fx.versXml(fx.lire(p.pdf).facture), p.xml);
});

test('un XML CII seul, en Buffer ou en chaine', () => {
  const xml = fx.versXml(base());
  for (const s of [xml, Buffer.from(xml)]) {
    const l = fx.lire(s);
    assert.strictEqual(l.format, 'cii');
    assert.strictEqual(l.pdf, null);
    assert.strictEqual(fx.versXml(l.facture), xml);
  }
});

test('les prefixes du fichier ne comptent pas, seuls les espaces de noms', () => {
  const xml = fx.versXml(base());
  const autre = xml.replace(/ram:/g, 'a:').replace(/xmlns:ram=/, 'xmlns:a=').replace(/rsm:/g, 'r:').replace(/xmlns:rsm=/, 'xmlns:r=');
  assert.notStrictEqual(autre, xml);
  assert.strictEqual(fx.versXml(fx.lire(autre).facture), xml);
});

/* ─── Fichiers etrangers ──────────────────────────────────────────────────── */

test('UBL 2.1 converti par Mustang : la facture', () => {
  const l = fx.lire(donnee('mustang-ubl-facture.xml'));
  assert.strictEqual(l.format, 'ubl');
  assert.strictEqual(l.syntaxe, 'UBL');
  assert.deepStrictEqual(l.non_lus, []);
  assert.deepStrictEqual(l.ecarts, []);
  assert.strictEqual(fx.versXml(l.facture), donnee('origine-facture.xml').toString());
});

test('UBL 2.1 converti par Mustang : l avoir (CreditNote) et sa facture d origine', () => {
  const l = fx.lire(donnee('mustang-ubl-avoir.xml'));
  assert.strictEqual(l.facture.type, 'avoir');
  assert.deepStrictEqual(l.facture.references.facture_precedente, { numero: 'T-2026-0001', date: '2026-10-01' });
  assert.deepStrictEqual(l.non_lus, []);
  assert.strictEqual(fx.versXml(l.facture), donnee('origine-avoir.xml').toString());
});

test('Factur-X assemble par Mustang et PDFBox : /EF indirect, PDF/A-3U', () => {
  const l = fx.lire(donnee('mustang-facturx-pdfbox.pdf'));
  assert.strictEqual(l.ok, true, l.erreur);
  assert.strictEqual(l.pdf.pdfa_declare, '3U');
  assert.strictEqual(l.xml, donnee('origine-facture.xml').toString());
  assert.strictEqual(fx.versXml(l.facture), l.xml);
});

test('PDF ecrit par pdf-lib : fiche de fichier cachee dans un flux d objets compresse', () => {
  const pdf = donnee('pdflib-flux-objets.pdf');
  assert.ok(pdf.includes('ObjStm') && !pdf.includes('Filespec'), 'le jeu d essai doit cacher la fiche');
  const l = fx.lire(pdf);
  assert.strictEqual(l.ok, true, l.erreur);
  assert.strictEqual(fx.versXml(l.facture), donnee('origine-facture.xml').toString());
});

/* ─── Ce que la lecture signale ───────────────────────────────────────────── */

test('un total faux se signale en ecart, jamais corrige en silence', () => {
  const xml = fx.versXml(base()).replace(/<ram:GrandTotalAmount>[^<]+</, '<ram:GrandTotalAmount>999.99<');
  const l = fx.lire(xml);
  assert.strictEqual(l.ok, true);
  assert.strictEqual(l.declares.total_ttc, '999.99');
  const e = l.ecarts.find((x) => x.champ === 'total_ttc');
  assert.deepStrictEqual(e, { champ: 'total_ttc', declare: '999.99', calcule: require('../lib/montants').xmlMontant(fx.valider(base()).totaux.total_ttc) });
});

test('ce que le moteur ne sait pas porter est nomme dans non_lus', () => {
  const remise = '<ram:SpecifiedTradeAllowanceCharge><ram:ChargeIndicator><udt:Indicator>false</udt:Indicator></ram:ChargeIndicator>'
    + '<ram:ActualAmount>5.00</ram:ActualAmount></ram:SpecifiedTradeAllowanceCharge>';
  const xml = fx.versXml(base()).replace('<ram:SpecifiedTradeSettlementHeaderMonetarySummation>', remise + '<ram:SpecifiedTradeSettlementHeaderMonetarySummation>')
    .replace('<ram:TaxBasisTotalAmount>', '<ram:AllowanceTotalAmount>5.00</ram:AllowanceTotalAmount><ram:TaxBasisTotalAmount>');
  const l = fx.lire(xml);
  assert.ok(l.non_lus.some((c) => c.endsWith('ApplicableHeaderTradeSettlement/SpecifiedTradeAllowanceCharge')), JSON.stringify(l.non_lus));
  assert.ok(l.notes.some((n) => n.includes('remises')));
});

test('une regle francaise qui echoue n empeche ni la lecture ni le recomptage', () => {
  const xml = fx.versXml(base()).replace(/<ram:SpecifiedLegalOrganization>\s*<ram:ID schemeID="0002">123456789<\/ram:ID>\s*<\/ram:SpecifiedLegalOrganization>/, '')
    .replace(/<ram:GrandTotalAmount>[^<]+</, '<ram:GrandTotalAmount>1.00<');
  const l = fx.lire(xml);
  assert.strictEqual(l.ok, true);
  assert.strictEqual(l.controle.ok, false);
  assert.ok(l.controle.erreurs.some((e) => e.regle === 'FR-SIREN'));
  assert.ok(l.ecarts.some((e) => e.champ === 'total_ttc'));
});

test('un profil sans lignes (MINIMUM) se lit, et le dit', () => {
  const xml = fx.versXml(base()).replace(/<ram:IncludedSupplyChainTradeLineItem>[\s\S]*?<\/ram:IncludedSupplyChainTradeLineItem>\s*/g, '');
  const l = fx.lire(xml);
  assert.strictEqual(l.ok, true);
  assert.ok(l.notes.some((n) => n.includes('aucune ligne')));
  assert.ok(l.declares.total_ttc);
});

/* ─── Ce que la lecture refuse, sans jamais lever ─────────────────────────── */

test('refus nets, avec un code', () => {
  const doctype = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>';
  const pdfNu = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1');
  const attendus = [
    [doctype, 'LECTURE-XML-DOCTYPE'],
    ['<a><b></a>', 'LECTURE-XML'],
    ['<Commande xmlns="urn:x"/>', 'LECTURE-RACINE'],
    [Buffer.from([0x50, 0x4B, 3, 4, 0, 0]), 'LECTURE-FORMAT'],
    [pdfNu, 'LECTURE-PDF-SANS-XML'],
    [Buffer.alloc(0), 'LECTURE-FORMAT'],
    [undefined, 'LECTURE-FORMAT'],
  ];
  for (const [entree, code] of attendus) {
    const l = fx.lire(entree);
    assert.strictEqual(l.ok, false);
    assert.strictEqual(l.code, code, String(entree).slice(0, 40) + ' : ' + l.erreur);
  }
});

test('un fichier tronque ou abime ne fait jamais lever lire', () => {
  const pdf = fx.produire(base()).pdf;
  const xml = Buffer.from(fx.versXml(base()));
  for (const source of [pdf, xml]) {
    for (let k = 1; k < 40; k++) {
      const coupe = source.subarray(0, Math.floor(source.length * k / 40));
      const abime = Buffer.from(source); abime[Math.floor(source.length * k / 40)] ^= 0xFF;
      for (const s of [coupe, abime]) {
        const l = fx.lire(s);
        assert.ok(typeof l.ok === 'boolean');
      }
    }
  }
});
