'use strict';
// BR-61 (EN 16931) : un virement porte l IBAN du compte a crediter. Constate le 21/11/2026 : une plateforme
// agreee (Super PDP) rejette la facture sans lui, alors que Mustang la laisse passer.
const test = require('node:test');
const assert = require('node:assert');
const fx = require('../evoyx');

const base = (paiement) => ({
  numero: 'F-1', date_emission: '2026-11-21', date_echeance: '2026-12-21',
  vendeur: { nom: 'A', siren: '732829320', tva: 'FR44732829320', courriel: 'a@a.fr', adresse: { ligne1: '1 rue', code_postal: '44000', ville: 'Nantes', pays: 'FR' } },
  acheteur: { nom: 'B', siren: '552100554', courriel: 'b@b.fr', adresse: { ligne1: '2 rue', code_postal: '75001', ville: 'Paris', pays: 'FR' } },
  lignes: [{ libelle: 'X', quantite: '1', prix_unitaire_ht: '10.00', tva: { categorie: 'S', taux: '20' } }],
  paiement,
});

test('BR-61 : virement sans IBAN refuse, avec IBAN accepte ; carte sans IBAN acceptee', () => {
  for (const moyen of ['virement', 'virement_sepa']) {
    const v = fx.valider(base({ moyen }));
    assert.strictEqual(v.ok, false);
    assert.ok(v.erreurs.some((e) => e.regle === 'BR-61'));
    assert.strictEqual(fx.valider(base({ moyen, iban: 'FR76 3000 6000 0112 3456 7890 189' })).ok, true);
  }
  assert.strictEqual(fx.valider(base({ moyen: 'carte' })).ok, true);
});

test('BT-23 absent : avertissement qui nomme les codes des plateformes agreees', () => {
  const v = fx.valider(base({ moyen: 'carte' }));
  const a = v.avertissements.find((x) => x.regle === 'FR-CADRE');
  assert.ok(a && /BR-FR-08/.test(a.message) && /S1/.test(a.message));
});
