'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const fx = require('../evoyx');
const { encoderPng } = require('../lib/pdf/png');
const { base, gabaritMaison } = require('./_facture');

const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-pdf-'));
test.after(() => fs.rmSync(dossier, { recursive: true, force: true }));
const aPoppler = (() => { try { execFileSync('pdfinfo', ['-v'], { stdio: 'ignore' }); return true; } catch (_) { return false; } })();

function structure(pdf) {
  const s = pdf.toString('latin1');
  const sx = +/startxref\n(\d+)/.exec(s)[1];
  assert.strictEqual(s.slice(sx, sx + 4), 'xref', 'startxref pointe sur la table');
  const lignes = s.slice(sx).split('\n');
  const n = +lignes[1].split(' ')[1];
  for (let k = 1; k < n; k++) {
    const off = +lignes[2 + k].slice(0, 10);
    assert.ok(s.startsWith(k + ' 0 obj', off), 'objet ' + k + ' a son decalage');
  }
  for (const m of s.matchAll(/\/Length (\d+) >>\nstream\n/g)) {
    assert.strictEqual(s.slice(m.index + m[0].length + +m[1], m.index + m[0].length + +m[1] + 10), '\nendstream');
  }
  return s;
}

test('PDF/A-3 : en-tete binaire, XMP, OutputIntent, piece jointe Alternative', () => {
  const r = fx.produire(base());
  const s = structure(r.pdf);
  assert.ok(s.startsWith('%PDF-1.7\n%'));
  assert.ok(r.pdf[10] > 127 && r.pdf[11] > 127, 'commentaire binaire en ligne 2');
  assert.match(s, /<pdfaid:part>3<\/pdfaid:part>/);
  assert.match(s, /<fx:ConformanceLevel>EN 16931<\/fx:ConformanceLevel>/);
  assert.match(s, /<fx:DocumentFileName>factur-x\.xml<\/fx:DocumentFileName>/);
  assert.match(s, /\/OutputIntents \[<< \/Type \/OutputIntent \/S \/GTS_PDFA1/);
  assert.match(s, /\/AFRelationship \/Alternative/);
  assert.match(s, /\/Subtype \/text#2fxml/);
  assert.match(s, /\/AF \[\d+ 0 R\]/);
  assert.match(s, /\/ID \[<[0-9A-F]{32}> <[0-9A-F]{32}>\]/);
  assert.doesNotMatch(s, /\/Type \/Metadata[^>]*\/Filter/, 'le flux XMP ne doit pas etre compresse');
});

test('le XML joint est exactement celui produit', () => {
  const r = fx.produire(base());
  const s = r.pdf.toString('latin1');
  const m = /\/Type \/EmbeddedFile[^]*?\/Length (\d+) >>\nstream\n/.exec(s);
  const debut = m.index + m[0].length;
  const joint = zlib.inflateSync(r.pdf.subarray(debut, debut + +m[1])).toString('utf8');
  assert.strictEqual(joint, r.xml);
});

test('facture longue : plusieurs pages, en-tete de tableau repete, pied numerote', (t) => {
  const f = base();
  f.lignes = Array.from({ length: 70 }, (_, i) => ({
    libelle: 'Prestation numero ' + (i + 1) + ' avec un libelle assez long pour passer a la ligne dans la colonne',
    description: i % 3 ? '' : 'Motconstitueduneseulepiecequinepeutpassecouperauxespacesetdoitquandmemeresterdanslacolonne',
    quantite: 1 + (i % 4), prix_unitaire_ht: '10.5', tva: { categorie: 'S', taux: i % 2 ? 20 : 10 } }));
  const px = Buffer.alloc(40 * 20 * 4, 200); for (let i = 3; i < px.length; i += 4) px[i] = i % 8 ? 255 : 0;
  const r = fx.produire(f, { theme: { logo: encoderPng(40, 20, 4, px), accent: '#7A2E2E' } });
  structure(r.pdf);
  assert.ok(r.pages >= 3, 'au moins 3 pages, obtenu ' + r.pages);
  if (!aPoppler) return t.skip('poppler absent');
  const fichier = path.join(dossier, 'longue.pdf');
  fs.writeFileSync(fichier, r.pdf);
  const texte = execFileSync('pdftotext', ['-layout', fichier, '-']).toString();
  assert.strictEqual((texte.match(/Désignation/g) || []).length, r.pages, 'en-tete de tableau sur chaque page');
  assert.match(texte, new RegExp('page ' + r.pages + ' sur ' + r.pages));
  assert.match(texte, /Prestation numero 70/);
});

test('rendu : aucune encre hors des marges, sur chaque page', (t) => {
  if (!aPoppler) return t.skip('poppler absent');
  const f = base();
  f.acheteur.nom = 'Une raison sociale particulierement longue pour eprouver le retour a la ligne du bloc acheteur SAS';
  const fichier = path.join(dossier, 'marges.pdf');
  fs.writeFileSync(fichier, fx.produire(f).pdf);
  execFileSync('pdftoppm', ['-r', '72', '-gray', fichier, path.join(dossier, 'rendu')]);
  for (const img of fs.readdirSync(dossier).filter((x) => x.startsWith('rendu') && x.endsWith('.pgm'))) {
    const b = fs.readFileSync(path.join(dossier, img));
    const [, w, h] = b.toString('latin1', 0, 30).split(/\s+/).map(Number);
    const px = b.subarray(b.length - w * h);
    let minX = w, maxX = 0;
    for (let i = 0; i < px.length; i++) if (px[i] < 235) { const x = i % w; if (x < minX) minX = x; if (x > maxX) maxX = x; }
    assert.ok(minX >= 44 && maxX <= w - 44, img + ' : encre de ' + minX + ' a ' + maxX);
  }
});

test('texte extractible par un outil tiers : accents, euro, numero', (t) => {
  if (!aPoppler) return t.skip('poppler absent');
  const fichier = path.join(dossier, 'texte.pdf');
  fs.writeFileSync(fichier, fx.produire(base()).pdf);
  const texte = execFileSync('pdftotext', [fichier, '-']).toString();
  for (const attendu of ['FACTURE', 'N° T-2026-0001', 'FACTURÉ À', 'Désignation', 'Net à payer', '€']) {
    assert.ok(texte.includes(attendu), attendu + ' absent du texte extrait');
  }
  const polices = execFileSync('pdffonts', [fichier]).toString();
  assert.match(polices, /CID TrueType\s+Identity-H\s+yes yes yes/);
});

test('brouillon : sans numero, marque comme tel', () => {
  const f = base(); f.numero = '';
  const r = fx.produire(f, { brouillon: true });
  assert.strictEqual(r.nom_fichier, 'brouillon');
  assert.throws(() => fx.produire(f), /BR-02/);
});


test('gabarit maison : le style est a l interface, la conformite reste au moteur', () => {
  const r = fx.produire(base(), { gabarit: gabaritMaison });
  const s = structure(r.pdf);
  assert.strictEqual(r.pages, 1);
  assert.match(s, /<fx:ConformanceLevel>EN 16931<\/fx:ConformanceLevel>/);
  assert.match(s, /\/AFRelationship \/Alternative/);
  assert.throws(() => fx.produire(base(), { gabarit: () => {} }), /aucune page/);
  assert.throws(() => fx.produire(base(), { gabarit: 'rouge' }), /fonction/);
});

test('un caractere que la police ne sait pas dessiner est signale', () => {
  const f = base(); f.lignes[0].libelle = 'Service ' + String.fromCodePoint(0x6F22);
  const r = fx.produire(f);
  assert.ok(r.avertissements.some((a) => a.regle === 'RENDU-GLYPHE'));
});
