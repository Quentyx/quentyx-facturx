'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { analyser } = require('../lib/facture');
const { base } = require('./_facture');
const regles = (r) => r.erreurs.map((e) => e.regle);

test('la facture de base est valide et sans avertissement', () => {
  const r = analyser(base());
  assert.deepStrictEqual(r.erreurs, []);
  assert.deepStrictEqual(r.avertissements, []);
});
test('ventilation par taux, TVA calculee sur la base de chaque groupe (BR-CO-17)', () => {
  const t = analyser(base()).totaux;
  assert.strictEqual(t.lignes_ht, 8497n);                 // 59,97 + 25,00
  assert.deepStrictEqual(t.ventilation.map((g) => [g.categorie, g.taux, g.base, g.tva]),
    [['S', 200000n, 5997n, 1199n], ['S', 55000n, 2500n, 138n]]);   // 11,994 -> 11,99 ; 1,375 -> 1,38
  assert.strictEqual(t.total_ttc, 8497n + 1199n + 138n);
});
test('franchise en base : categorie E, taux zero, motif obligatoire (BR-E-10)', () => {
  const f = base();
  f.lignes = [{ libelle: 'Abonnement', prix_unitaire_ht: 39, tva: { categorie: 'E' } }];
  f.vendeur.tva = ''; f.vendeur.id_fiscal = '123456789';
  assert.ok(regles(analyser(f)).includes('BR-E-10'));
  f.exonerations = { E: { motif: 'TVA non applicable, art. 293 B du CGI' } };
  const r = analyser(f);
  assert.deepStrictEqual(r.erreurs, []);
  assert.strictEqual(r.totaux.total_tva, 0n);
});
test('categorie E sans identifiant fiscal du vendeur : BR-E-02', () => {
  const f = base();
  f.lignes = [{ libelle: 'x', prix_unitaire_ht: 1, tva: { categorie: 'E' } }];
  f.exonerations = { E: { motif: 'm' } }; f.vendeur.tva = '';
  assert.ok(regles(analyser(f)).includes('BR-E-02'));
});
test('chaque defaut porte le code de sa regle', () => {
  const f = base();
  f.numero = ''; f.date_emission = '2026-02-30'; f.vendeur.nom = ''; f.acheteur.adresse = { pays: 'FR' };
  f.vendeur.siren = '12'; f.lignes[0].prix_unitaire_ht = '-1'; f.lignes[1].tva = { categorie: 'S', taux: 0 };
  const r = regles(analyser(f));
  for (const code of ['BR-02', 'BR-03', 'BR-06', 'FR-ADRESSE', 'FR-SIREN', 'BR-27', 'BR-S-05']) assert.ok(r.includes(code), code + ' attendu dans ' + r);
});
test('un brouillon peut ne pas avoir de numero', () => {
  const f = base(); f.numero = '';
  assert.ok(analyser(f, { brouillon: true }).ok);
});
test('montant du sans echeance ni conditions : BR-CO-25', () => {
  const f = base(); f.date_echeance = '';
  assert.ok(regles(analyser(f)).includes('BR-CO-25'));
  f.paiement.deja_paye = analyser(base()).totaux.total_ttc.toString().replace(/(\d\d)$/, '.$1');
  assert.ok(analyser(f).ok, 'une facture reglee n a pas besoin d echeance');
});
test('deja paye superieur au total : BR-CO-16', () => {
  const f = base(); f.paiement.deja_paye = '10000';
  assert.ok(regles(analyser(f)).includes('BR-CO-16'));
});
test('hors champ : pas de taux, pas de numero de TVA (BR-O-02, BR-O-05)', () => {
  const f = base();
  f.lignes = [{ libelle: 'x', prix_unitaire_ht: 1, tva: { categorie: 'O', taux: 0 } }];
  f.exonerations = { O: { motif: 'Hors champ' } };
  const r = regles(analyser(f));
  assert.ok(r.includes('BR-O-05') && r.includes('BR-O-02'));
});
test('mentions francaises manquantes : avertissements, pas erreurs', () => {
  const f = base(); f.notes = []; f.cadre_facturation = ''; f.acheteur.siren = '';
  const r = analyser(f);
  assert.ok(r.ok);
  assert.deepStrictEqual(r.avertissements.map((a) => a.regle).sort(),
    ['FR-CADRE', 'FR-ESCOMPTE', 'FR-INDEMNITE', 'FR-PENALITES', 'FR-SIREN-ACHETEUR']);
});
