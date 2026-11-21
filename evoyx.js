// SPDX-License-Identifier: LGPL-3.0-only
// Copyright (C) 2026 Anthony Renard
'use strict';
/*
 * QUENTYX FACTUR-X, moteur de facture electronique. Zero dependance.
 *
 * Profil EN 16931, PDF/A-3. Voir README.md.
 *
 *   valider(entree)            analyse, totaux, erreurs et avertissements. Ne leve jamais.
 *   produire(entree, options)  { pdf, xml, totaux, avertissements, nom_fichier }. Leve si invalide.
 *   versXml(entree)            le XML Factur-X seul.
 *   lire(pdfOuXml)             LIRE une facture recue, Factur-X, CII ou UBL : le meme contrat,
 *                              les montants declares, les ecarts, le controle. Ne leve jamais.
 *   ouvrirRegistre(dossier)    PALIER PRO : numerotation sans trou ni doublon, sur quentyx-journal.
 *                              Sans le Pro, refuse avec le code PALIER_PRO (lib/paliers.js).
 *   CATALOGUE                  ce que le moteur sait faire, lisible par un agent.
 */

const facture = require('./lib/facture');
const { versCII, PROFIL_EN16931 } = require('./lib/cii');
const { rendre } = require('./lib/rendu');
const paliers = require('./lib/paliers');
const { lire } = require('./lib/lecture');
const { version: VERSION } = require('./package.json');

const NIVEAU = 'EN 16931';

function erreurInvalide(a) {
  const e = new Error('facture invalide : ' + a.erreurs.map((x) => x.regle + ' ' + x.message).join(' ; '));
  e.erreurs = a.erreurs;
  return e;
}

function valider(entree, options) {
  return facture.analyser(entree, options);
}

function versXml(entree, options) {
  const a = facture.analyser(entree, options);
  if (!a.ok) throw erreurInvalide(a);
  return versCII(a.facture, a.totaux);
}

/**
 * options : { brouillon, date,
 *             gabarit: function(ctx), la mise en page du SaaS appelant (voir lib/rendu.js),
 *             theme: { accent, texte, doux, filet, fond, police, policeGras, logo } pour le gabarit neutre }
 * Un brouillon peut ne pas avoir de numero ; il est marque « sans valeur de facture ».
 */
function produire(entree, options) {
  const o = options || {};
  const a = facture.analyser(entree, { brouillon: !!o.brouillon });
  if (!a.ok) throw erreurInvalide(a);
  const xml = versCII(a.facture, a.totaux);
  const r = rendre(a.facture, a.totaux, xml, o);
  const avertissements = a.avertissements.slice();
  if (r.glyphes_absents.length) {
    avertissements.push({ regle: 'RENDU-GLYPHE', message: 'caracteres absents de la police, dessines en carre : ' + r.glyphes_absents.join(' ') });
  }
  const base = (a.facture.numero || 'brouillon').replace(/[^A-Za-z0-9._-]/g, '_');
  return { pdf: r.pdf, xml, pages: r.pages, totaux: a.totaux, avertissements, nom_fichier: base };
}

/** Rend un objet serialisable en JSON : les montants BigInt deviennent des chaines en centimes. */
function versJson(v) {
  return JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x)));
}

// Le Pro recoit l API du Libre, jamais un chemin vers ses fichiers.
const pro = paliers.charger({ analyser: facture.analyser, valider, produire, versXml, lire, VERSION });
const ouvrirRegistre = pro.operations.ouvrirRegistre || paliers.absente('ouvrirRegistre');
const ouvrirPlateforme = pro.operations.ouvrirPlateforme || paliers.absente('ouvrirPlateforme');
const PRO = { palier: 'pro', disponible: !!pro.operations.ouvrirRegistre };

const CATALOGUE = {
  moteur: 'quentyx-facturx',
  version: VERSION,
  role: 'Produire des factures electroniques francaises conformes : PDF/A-3 lisible par un humain, XML Factur-X EN 16931 joint, lisible par une machine.',
  style: 'le moteur ne porte aucune identite visuelle : l interface appelante fournit son gabarit ou son theme, le moteur garantit la conformite',
  norme: { format: 'Factur-X 1.0 (CII D16B)', profil: PROFIL_EN16931, niveau: NIVEAU, pdf: 'PDF/A-3B', relation_piece_jointe: 'Alternative' },
  operations: {
    valider: { entree: 'facture', rend: '{ ok, facture, totaux, erreurs[{regle,message}], avertissements[{regle,message}] }', effet: 'aucun' },
    produire: { entree: 'facture complete avec numero, ou brouillon', options: '{ gabarit: fonction de mise en page du SaaS appelant, ou theme: { accent, polices TTF, logo PNG } pour le gabarit neutre }', rend: '{ pdf, xml, pages, totaux, avertissements, nom_fichier }', effet: 'aucun, rien n est ecrit' },
    lire: { entree: 'Buffer d un PDF Factur-X ou ZUGFeRD, ou XML CII ou UBL 2.1 (facture, avoir)', rend: '{ ok, format facturx|cii|ubl, syntaxe, profil, type_code, facture (meme contrat qu en entree), declares (montants ecrits par l emetteur), ecarts [{champ, declare, calcule}], controle { ok, erreurs, avertissements }, non_lus [chemins], notes, pdf { piece_jointe, relation, pdfa_declare, profil_declare }, xml } ou { ok: false, code LECTURE-..., erreur }', effet: 'aucun', securite: 'DOCTYPE refuse, PDF chiffre refuse, tailles bornees' },
    mcp: { entree: 'npx -y quentyx-facturx mcp (stdio)', rend: 'un serveur MCP : facturx_catalogue, facturx_valider, facturx_produire, facturx_lire, facturx_xml ; avec le Pro, facturx_emettre, facturx_lister, facturx_relire', effet: 'lit et ecrit sous FACTURX_DOSSIER (par defaut le dossier courant), jamais ailleurs' },
    'registre.emettre': { ...PRO, entree: 'facture sans numero, reference_unique facultative', rend: '{ numero, facture, deja }', effet: 'attribue le numero suivant et consigne la facture dans le journal' },
    'registre.lister': { ...PRO, rend: '[{ numero, date, reference, total_ttc_centimes, seq }]', effet: 'aucun' },
    'registre.relire': { ...PRO, entree: 'numero', rend: 'la facture emise, telle que consignee', effet: 'aucun' },
    plateforme: { ...PRO, entree: 'ouvrirPlateforme({ fournisseur: superpdp, environnement: bac_a_sable|production, client_id, client_secret }), sinon FACTURX_SUPERPDP_ENV, FACTURX_SUPERPDP_CLIENT_ID, FACTURX_SUPERPDP_CLIENT_SECRET',
      rend: '{ compte, adresses, annuaire(siren), entreprises, controler, envoyer(facture|fichier, { reference, regle }), factures({ sens emises|recues, mois, apres, limite }), detail, fichier(id, format), lire(id), evenements(id), statuer(id, statut, { motif, note, montant }), ereporting { apercu, lister, lire, declarer }, identitesEssai, factureEssai }',
      effet: 'envoyer, statuer et ereporting.declarer transmettent a la plateforme agreee ; avant, l environnement reel du compte doit etre celui declare, et le Libre relit la facture : une facture non conforme ne part pas' },
  },
  facture: {
    type: 'facture | avoir',
    numero: 'attribue par le registre, ou fourni',
    date_emission: 'AAAA-MM-JJ, obligatoire',
    date_echeance: 'AAAA-MM-JJ, obligatoire si un montant reste du sans conditions de paiement',
    devise: 'EUR par defaut',
    periode: '{ debut, fin } en AAAA-MM-JJ, pour un abonnement',
    cadre_facturation: 'BT-23, code de la reforme francaise, facultatif',
    reference_unique: 'identifiant externe (paiement, commande) : une seule facture par reference dans un registre',
    vendeur: '{ nom, siren, siret, tva, id_fiscal, mention_legale (EI...), courriel, adresse { ligne1, ligne2, ligne3, code_postal, ville, pays } }',
    acheteur: 'meme forme que vendeur, plus reference (BT-10)',
    lignes: '[{ libelle, description, reference, quantite, unite (UN/ECE Rec 20, C62 par defaut), prix_unitaire_ht, tva { categorie S|Z|E|AE|K|G|O, taux }, periode }]',
    exonerations: '{ E: { motif, code } } : motif obligatoire pour E, AE, K, G, O. Franchise en base : "TVA non applicable, art. 293 B du CGI"',
    paiement: '{ moyen carte|virement|virement_sepa|prelevement|especes|cheque|autre, deja_paye, conditions, iban, reference }',
    notes: '[{ code PMD|PMT|AAB|..., texte }] : penalites de retard, indemnite de 40 euros, escompte',
    references: '{ commande, contrat, facture_precedente { numero, date } }',
  },
  paliers: {
    libre: 'valider, produire, versXml, lire : verifier, produire et lire une facture EN 16931, seul, sans autre moteur',
    pro: { present: pro.present, nom: pro.nom || 'quentyx-facturx-pro', version: pro.version || null,
      role: 'registre : numerotation continue et chronologique sans trou ni doublon, une facture par paiement, piste d audit ; plateforme agreee : Super PDP (envoi, reception, cycle de vie, annuaire, controle, e-reporting)',
      absent: 'une operation Pro absente refuse avec le code PALIER_PRO' },
  },
  montants: 'nombres ou chaines, 2 decimales pour un montant, 4 pour un prix, une quantite ou un taux. Un flottant approximatif est refuse, jamais arrondi en silence.',
  limites: [
    'remises et frais au niveau du document non pris en charge : a la lecture, ils sont signales et laissent un ecart',
    'profils EXTENDED et EXTENDED-CTC-FR non produits',
    'transmission a une plateforme agreee : palier Pro seulement, premier pilote Super PDP',
    'polices TrueType seulement, PNG 8 bits seulement',
  ],
};

module.exports = {
  valider, produire, versXml, versJson, lire,
  ouvrirRegistre, ouvrirPlateforme,
  CATALOGUE, NIVEAU, VERSION,
};
