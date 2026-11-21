'use strict';
/*
 * ESSAI ORACLE : les validateurs officiels, Mustang et veraPDF, jugent nos factures.
 * Un oracle n est pas une dependance : le moteur ne s en sert jamais, il sert a
 * prouver que le moteur est juste. Lance seulement sur demande, il demarre un
 * conteneur Java jetable, sans reseau :
 *
 *   FACTURX_ORACLE=1 npm test
 *
 * Emplacement du validateur : FACTURX_ORACLES, ou a defaut ../_labo/oracles-facturx/
 * a cote du dossier du moteur.
 */
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fx = require('../evoyx');
const { base, gabaritMaison } = require('./_facture');

const ORACLES = process.env.FACTURX_ORACLES || path.join(__dirname, '..', '..', '_labo', 'oracles-facturx');
const JAR = fs.existsSync(ORACLES) ? fs.readdirSync(ORACLES).find((f) => /^Mustang-CLI-.*\.jar$/.test(f)) : null;
const actif = process.env.FACTURX_ORACLE === '1' && JAR;

function mustang(nom, pdf) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-oracle-'));
  try {
    fs.writeFileSync(path.join(d, nom + '.pdf'), pdf);
    const sortie = execFileSync('docker', ['run', '--rm', '--network', 'none', '-v', ORACLES + ':/o:ro', '-v', d + ':/s:ro', '-w', '/tmp',
      'eclipse-temurin:21-jre', 'java', '-Xmx1g', '-jar', '/o/' + JAR, '--no-notices', '--action', 'validate', '--source', '/s/' + nom + '.pdf'],
    { stdio: ['ignore', 'pipe', 'ignore'], timeout: 180000 }).toString();
    return {
      statut: (/<summary status="(\w+)"/.exec(sortie) || [])[1],
      erreurs: [...sortie.matchAll(/<error[^>]*>([^<]{0,200})/g)].map((m) => m[1]),
      avertissements: [...sortie.matchAll(/\[ID ([A-Z0-9_-]+)\]/g)].map((m) => m[1]),
    };
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}

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
};

cas['gabarit maison d un SaaS'] = () => Object.assign(base(), { __gabarit: gabaritMaison });

for (const [nom, fabrique] of Object.entries(cas)) {
  test('Mustang et veraPDF : ' + nom, { skip: actif ? false : 'FACTURX_ORACLE=1 et le validateur sont necessaires' }, () => {
    const f = fabrique();
    const options = f.__gabarit ? { gabarit: f.__gabarit } : {};
    delete f.__gabarit;
    const r = mustang(nom.replace(/\W+/g, '-'), fx.produire(f, options).pdf);
    assert.deepStrictEqual(r.erreurs, [], 'erreurs : ' + r.erreurs.join(' | '));
    assert.strictEqual(r.statut, 'valid');
    const restants = r.avertissements.filter((a) => a !== 'PEPPOL-EN16931-R008');
    assert.deepStrictEqual(restants, [], 'avertissements : ' + restants.join(' '));
  });
}

/*
 * LA LECTURE face a l oracle : Mustang convertit notre CII en UBL et assemble
 * un Factur-X avec PDFBox, a chaque passage. La lecture doit retrouver le XML
 * d origine octet pour octet, et Mustang doit juger l UBL valide.
 */
function mustangConvertir(nom, xml) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-oracle-lire-'));
  fs.chmodSync(d, 0o777);
  const java = (...a) => execFileSync('docker', ['run', '--rm', '--network', 'none', '-v', ORACLES + ':/o:ro', '-v', d + ':/s', '-w', '/tmp',
    'eclipse-temurin:21-jre', 'java', '-Xmx1g', '-jar', '/o/' + JAR, '--disable-file-logging', ...a],
  { stdio: ['ignore', 'pipe', 'ignore'], timeout: 180000 }).toString();
  try {
    fs.writeFileSync(path.join(d, nom + '.xml'), xml);
    java('--action', 'ubl', '--source', '/s/' + nom + '.xml', '--out', '/s/' + nom + '-ubl.xml');
    let jugement;
    try { jugement = java('--no-notices', '--action', 'validate', '--source', '/s/' + nom + '-ubl.xml'); }
    catch (e) { jugement = String(e.stdout || ''); }                 // un fichier invalide fait sortir Mustang en erreur
    java('--action', 'pdf', '--language', 'fr', '--source', '/s/' + nom + '.xml', '--out', '/s/' + nom + '-vue.pdf');
    java('--action', 'combine', '--source', '/s/' + nom + '-vue.pdf', '--source-xml', '/s/' + nom + '.xml', '--out', '/s/' + nom + '-fx.pdf',
      '--format', 'fx', '--version', '2', '--profile', 'E', '--attachments', '', '--no-additional-attachments');
    return {
      ubl: fs.readFileSync(path.join(d, nom + '-ubl.xml')),
      pdf: fs.readFileSync(path.join(d, nom + '-fx.pdf')),
      statutUbl: (/<summary status="(\w+)"/.exec(jugement) || [])[1],
    reglesUbl: [...new Set([...jugement.matchAll(/\[ID ([A-Z0-9_-]+)\]/g)].map((x) => x[1]))].sort(),
    };
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}

// Releve le 2026-11-21 : l UBL d AVOIR que Mustang 2.26.0 tire de notre CII (valide) est juge
// INVALIDE par Mustang lui-meme (DueDate mal placee, CreditNoteDocumentReference au lieu
// d InvoiceDocumentReference). C est un fichier du monde reel : la lecture doit le comprendre.
const UBL_INVALIDE_CONNU = { avoir: ['BR-55', 'UBL-CR-039', 'UBL-SR-07'] };

for (const [nom, fabrique] of Object.entries(cas)) {
  test('Mustang convertit, le moteur relit : ' + nom, { skip: actif ? false : 'FACTURX_ORACLE=1 et le validateur sont necessaires' }, () => {
    const f = fabrique();
    delete f.__gabarit;
    const xml = fx.versXml(f);
    const m = mustangConvertir(nom.replace(/\W+/g, '-'), xml);
    if (UBL_INVALIDE_CONNU[nom]) {
      assert.strictEqual(m.statutUbl, 'invalid', 'si Mustang corrige son UBL, retirer ce cas de UBL_INVALIDE_CONNU');
      assert.deepStrictEqual(m.reglesUbl, UBL_INVALIDE_CONNU[nom]);
    } else {
      assert.strictEqual(m.statutUbl, 'valid', 'Mustang juge son propre UBL');
    }
    const ubl = fx.lire(m.ubl);
    assert.strictEqual(ubl.format, 'ubl');
    assert.deepStrictEqual(ubl.non_lus, []);
    assert.strictEqual(fx.versXml(ubl.facture), xml, 'UBL relu, reecrit a l identique');
    const pdf = fx.lire(m.pdf);
    assert.strictEqual(pdf.ok, true, pdf.erreur);
    assert.strictEqual(fx.versXml(pdf.facture), xml, 'Factur-X PDFBox relu, reecrit a l identique');
  });
}
