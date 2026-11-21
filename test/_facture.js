'use strict';
// Fabrique de factures d essai. Chaque essai part d une facture valide et en change UNE chose.
const base = () => ({
  type: 'facture', numero: 'T-2026-0001', date_emission: '2026-10-01', date_echeance: '2026-10-31',
  vendeur: { nom: 'Vendeur Essai', mention_legale: 'EI', siren: '123456789', tva: 'FR12123456789', courriel: 'factures@vendeur.fr',
    adresse: { ligne1: '1 rue A', code_postal: '44000', ville: 'Nantes', pays: 'FR' } },
  acheteur: { nom: 'Acheteur Essai SAS', siren: '987654321', adresse_electronique: { valeur: '987654321', schema: '0225' },
    adresse: { ligne1: '2 rue B', code_postal: '75001', ville: 'Paris', pays: 'FR' } },
  lignes: [
    { libelle: 'Service A', quantite: 3, prix_unitaire_ht: '19.99', tva: { categorie: 'S', taux: 20 } },
    { libelle: 'Livre', quantite: '2', prix_unitaire_ht: '12.5', tva: { categorie: 'S', taux: '5.5' } },
  ],
  paiement: { moyen: 'virement', iban: 'FR76 3000 6000 0112 3456 7890 189' },
  notes: [{ code: 'PMD', texte: 'Penalites.' }, { code: 'PMT', texte: 'Indemnite 40 euros.' }, { code: 'AAB', texte: 'Pas d escompte.' }],
  cadre_facturation: 'S1',
});
const path = require('path');

/** Un gabarit maison minimal, comme un SaaS pourrait en ecrire un. */
const gabaritMaison = ({ doc, facture, totaux, M, RESSOURCES }) => {
  const police = doc.police(path.join(RESSOURCES, 'polices', 'DejaVuSans.ttf'));
  const page = doc.nouvellePage();
  page.rectangle(0, 780, 595.28, 61.89, { remplir: '#0B052F' });
  page.texte(40, 800, 'Mon SaaS, facture ' + facture.numero, police, 16, '#F4F1E8');
  page.texte(40, 700, 'Total TTC : ' + M.frMontant(totaux.total_ttc), police, 12, '#0B052F');
};

module.exports = { base, gabaritMaison };
