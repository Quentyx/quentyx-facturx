# quentyx-facturx

[English](README.md) · **Français**

**Factures électroniques françaises en Node.js, sans aucune dépendance.** J’ai écrit ce moteur
pour produire et lire des factures Factur-X conformes à la réforme de la facturation électronique :
un PDF/A-3 lisible par un humain, avec le XML au profil EN 16931 joint, lisible par une machine.

- **Produire** une facture ou un avoir en Factur-X EN 16931, PDF/A-3B.
- **Lire** une facture reçue : Factur-X, CII ou UBL 2.1.
- **Valider** une facture contre les règles EN 16931 et les obligations françaises, avant de l’émettre.
- **Zéro dépendance** : le PDF, les polices, le XML et les montants sont écrits par le moteur lui-même.
- **Prouvé** par les validateurs officiels Mustang et veraPDF (voir [Preuves](#preuves)).

## Installer

```bash
npm install quentyx-facturx
```

Node.js 18 ou plus récent.

## Produire une facture

```js
const fs = require('fs');
const fx = require('quentyx-facturx');

const { pdf, avertissements } = fx.produire({
  numero: 'F-2026-0001',
  date_emission: '2026-11-21',
  date_echeance: '2026-12-21',
  vendeur: {
    nom: 'Mon Entreprise', siren: '123456789', tva: 'FR12123456789',
    courriel: 'factures@mon-entreprise.fr',
    adresse: { ligne1: '1 rue de la Paix', code_postal: '44000', ville: 'Nantes', pays: 'FR' },
  },
  acheteur: {
    nom: 'Client SAS', siren: '987654321',
    adresse: { ligne1: '2 avenue du Client', code_postal: '75001', ville: 'Paris', pays: 'FR' },
  },
  lignes: [{ libelle: 'Conseil', quantite: 2, prix_unitaire_ht: '450.00', tva: { categorie: 'S', taux: 20 } }],
  paiement: { moyen: 'virement', iban: 'FR7630006000011234567890189' },
  notes: [
    { code: 'PMD', texte: 'Pénalités de retard : trois fois le taux d’intérêt légal.' },
    { code: 'PMT', texte: 'Indemnité forfaitaire de recouvrement : 40 €.' },
    { code: 'AAB', texte: 'Pas d’escompte pour paiement anticipé.' },
  ],
});

fs.writeFileSync('F-2026-0001.pdf', pdf);
```

Les montants s’écrivent en nombres ou en chaînes ; à l’intérieur, tout est compté en centimes
entiers. Un flottant approximatif est refusé, jamais arrondi en silence.

`avertissements` signale ce qui manque pour la réforme sans empêcher de produire (par exemple
l’adresse électronique de l’acheteur). Une **erreur** empêche de produire : chacune porte le code
de la règle qu’elle applique (`BR-…` pour l’EN 16931, `FR-…` pour une obligation française).

## Lire une facture reçue

Depuis le 1er septembre 2026, votre entreprise doit pouvoir **recevoir** des factures
électroniques. `lire` ramène les trois syntaxes de la réforme au même contrat que celui d’entrée :
une facture reçue se valide, se recalcule et se reproduit avec les mêmes fonctions.

```js
const r = fx.lire(fs.readFileSync('facture-recue.pdf'));   // ou un XML CII ou UBL
r.facture    // la facture, au même contrat que celui de produire()
r.declares   // les montants tels que l’émetteur les a écrits
r.ecarts     // ce qui ne tombe pas juste quand je recompte : [{ champ, declare, calcule }]
r.controle   // erreurs et avertissements EN 16931 et français
r.non_lus    // les éléments du fichier que le moteur ne porte pas encore
```

J’ai voulu trois garanties :

- **Rien n’est corrigé en silence.** Un total faux reste faux dans `declares`, et l’écart se lit
  dans `ecarts`.
- **Rien n’est perdu sans le dire.** Chaque élément non lu est nommé dans `non_lus`, par son chemin.
- **`lire` ne lève jamais.** Un fichier illisible rend `{ ok: false, code, erreur }`.

Un fichier reçu peut venir de n’importe qui : les déclarations `DOCTYPE` (entités externes) sont
refusées, un PDF chiffré est refusé, les tailles sont bornées. Le lecteur de PDF comprend aussi
les flux d’objets compressés : je l’ai éprouvé sur des fichiers écrits par d’autres logiciels
(Mustang, PDFBox, pdf-lib), et chaque facture relue se réécrit à l’identique, octet pour octet.

## Votre style, ma conformité

Le moteur n’impose aucune identité visuelle. Passez votre propre gabarit à
`produire(facture, { gabarit })`, ou un **thème** (couleurs, polices TrueType, logo PNG) au gabarit
neutre : le moteur pose ensuite le XML, les métadonnées PDF/A-3 et les polices embarquées, quel
que soit votre dessin. Exemples dans [`exemples/sortie/`](exemples/sortie/).

## Ligne de commande

```bash
npx quentyx-facturx catalogue                  # le contrat complet, lisible par un agent
npx quentyx-facturx valider  facture.json
npx quentyx-facturx produire facture.json --sortie dossier/
npx quentyx-facturx lire     facture-recue.pdf
```

Toutes les commandes répondent en JSON. `catalogue` décrit chaque opération et chaque champ :
c’est la page à donner à un modèle de langue qui doit se servir du moteur.

## Libre et Pro

| | Libre | Pro |
|---|---|---|
| Produire, valider, lire (Factur-X, CII, UBL) | ✓ | ✓ |
| **Registre** : numérotation continue sans trou ni doublon, même entre plusieurs processus | | ✓ |
| Une seule facture par paiement (`reference_unique`) | | ✓ |
| Piste d’audit de chaque facture émise | | ✓ |
| Prochainement : profil EXTENDED-CTC-FR, connecteurs aux plateformes agréées, archivage | | ✓ |
| Licence | LGPL-3.0 | commerciale |
| Prix | gratuit | **15 € par mois ou 150 € par an**, factures illimitées, une entreprise |

Le Pro se branche sur le Libre sans changer une ligne de votre code : sans lui, une opération Pro
répond avec le code `PALIER_PRO`. Les achats du Pro ouvrent prochainement.

## Preuves

| Ce qui est prouvé | Par |
|---|---|
| PDF/A-3, EN 16931 et règles françaises BR-FR, sur une facture à plusieurs taux, une franchise en base, un avoir et un gabarit maison | **Mustang 2.26.0 et veraPDF**, zéro erreur |
| La lecture : Mustang convertit nos factures en UBL et les assemble en Factur-X avec PDFBox, le moteur les relit à l’identique | **Mustang 2.26.0** |
| 55 essais ordinaires, 63 avec les validateurs officiels | `npm test`, `FACTURX_ORACLE=1 npm test` |

## Limites actuelles

- Remises et frais au niveau du document : non pris en charge à la production, signalés à la lecture.
- Profils EXTENDED et EXTENDED-CTC-FR : non produits pour l’instant.
- Transmission à une plateforme agréée : hors du moteur pour l’instant.

## Licence

Le palier Libre est sous **GNU LGPL-3.0** ([`COPYING.LESSER`](COPYING.LESSER), qui complète
[`COPYING`](COPYING)) : vous pouvez l’utiliser dans un logiciel fermé ; si vous modifiez le moteur
lui-même et le distribuez, vos modifications restent libres. Le palier Pro est sous licence
commerciale.

© 2026 Anthony Renard
