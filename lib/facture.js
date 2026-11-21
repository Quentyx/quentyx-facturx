// SPDX-License-Identifier: LGPL-3.0-only
// Copyright (C) 2026 Anthony Renard
'use strict';
/*
 * LA FACTURE, son contrat d entree, son calcul et ses regles.
 *
 * `analyser(entree)` ne leve jamais : il rend la facture normalisee, ses totaux,
 * ses ERREURS et ses AVERTISSEMENTS. Une erreur empeche de produire. Un
 * avertissement se lit et se tranche par l appelant : le moteur ne sait pas si
 * la vente est entre entreprises, ni quel est le regime de TVA du vendeur.
 *
 * Chaque erreur porte le CODE de la regle EN 16931 qu elle applique (BR-...),
 * ou FR-... pour une obligation francaise. Un code se retrouve dans la norme,
 * une phrase non.
 */

const M = require('./montants');

const TYPES = { facture: '380', avoir: '381' };

// UNTDID 5305, ceux que l EN 16931 admet et que le moteur sait ventiler.
const CATEGORIES = {
  S:  'TVA au taux normal ou reduit',
  Z:  'TVA au taux zero',
  E:  'exoneration de TVA',
  AE: 'autoliquidation',
  K:  'livraison intracommunautaire',
  G:  'exportation hors Union europeenne',
  O:  'hors du champ de la TVA',
};
const MOTIF_REQUIS = new Set(['E', 'AE', 'K', 'G', 'O']);   // BR-E-10, BR-AE-10, BR-IC-10, BR-G-10, BR-O-10
const TAUX_ZERO    = new Set(['Z', 'E', 'AE', 'K', 'G']);   // BR-Z-05, BR-E-05, BR-AE-05, BR-IC-05, BR-G-05
const ID_VENDEUR   = new Set(['S', 'Z', 'E', 'AE', 'K', 'G']); // BR-S-02 et suivantes
const ID_ACHETEUR  = new Set(['AE', 'K']);                  // BR-AE-02, BR-IC-02

// UNTDID 4461, moyens de paiement.
const MOYENS = {
  virement: '30', virement_sepa: '58', carte: '48', prelevement: '59',
  especes: '10', cheque: '20', autre: '1',
};

const txt = (v) => (v === null || v === undefined ? '' : String(v).trim());
const sansEspace = (v) => txt(v).replace(/\s+/g, '');

function dateValide(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function partie(p) {
  p = p || {};
  const a = p.adresse || {};
  const siret = sansEspace(p.siret);
  return {
    nom: txt(p.nom),
    siren: sansEspace(p.siren) || (siret.length === 14 ? siret.slice(0, 9) : ''),
    siret,
    tva: sansEspace(p.tva).toUpperCase(),
    id_fiscal: txt(p.id_fiscal),
    mention_legale: txt(p.mention_legale),
    courriel: txt(p.courriel),
    reference: txt(p.reference),
    // BT-34 / BT-49 : adresse ou la facture electronique est routee. Par defaut le courriel (EM).
    // Pour la reforme, l adresse de l annuaire se declare avec son schema, par exemple 0225.
    adresse_electronique: (p.adresse_electronique && txt(p.adresse_electronique.valeur))
      ? { valeur: txt(p.adresse_electronique.valeur), schema: txt(p.adresse_electronique.schema) || 'EM' }
      : { valeur: txt(p.courriel), schema: 'EM' },
    adresse: {
      ligne1: txt(a.ligne1), ligne2: txt(a.ligne2), ligne3: txt(a.ligne3),
      code_postal: txt(a.code_postal), ville: txt(a.ville),
      pays: (txt(a.pays) || 'FR').toUpperCase(),
    },
  };
}

function analyser(entree, options) {
  const opts = Object.assign({ brouillon: false }, options || {});
  const erreurs = [];
  const avertissements = [];
  const err = (regle, message) => erreurs.push({ regle, message });
  const avert = (regle, message) => avertissements.push({ regle, message });
  const e = entree || {};

  // ── En-tete ────────────────────────────────────────────────────────────────
  const type = txt(e.type || 'facture');
  if (!TYPES[type]) err('BR-04', 'type de document inconnu : ' + type + ' (facture ou avoir)');
  const numero = txt(e.numero);
  if (!numero && !opts.brouillon) err('BR-02', 'numero de facture manquant');
  const date_emission = txt(e.date_emission);
  if (!dateValide(date_emission)) err('BR-03', 'date d emission invalide, attendu AAAA-MM-JJ : ' + (date_emission || 'vide'));
  const date_echeance = txt(e.date_echeance);
  if (date_echeance && !dateValide(date_echeance)) err('BR-CO-25', 'date d echeance invalide : ' + date_echeance);
  const devise = (txt(e.devise) || 'EUR').toUpperCase();
  if (!/^[A-Z]{3}$/.test(devise)) err('BR-05', 'devise invalide : ' + devise);

  let periode = null;
  if (e.periode) {
    periode = { debut: txt(e.periode.debut), fin: txt(e.periode.fin) };
    if ((periode.debut && !dateValide(periode.debut)) || (periode.fin && !dateValide(periode.fin))) {
      err('BR-CO-19', 'periode de facturation invalide');
    } else if (periode.debut && periode.fin && periode.fin < periode.debut) {
      err('BR-29', 'la fin de la periode precede son debut');
    }
  }

  // ── Parties ────────────────────────────────────────────────────────────────
  const vendeur = partie(e.vendeur);
  const acheteur = partie(e.acheteur);
  if (!vendeur.nom) err('BR-06', 'nom du vendeur manquant');
  if (!acheteur.nom) err('BR-07', 'nom de l acheteur manquant');
  for (const [p, qui, rAdr, rPays] of [[vendeur, 'vendeur', 'BR-08', 'BR-09'], [acheteur, 'acheteur', 'BR-10', 'BR-11']]) {
    if (!/^[A-Z]{2}$/.test(p.adresse.pays)) err(rPays, 'code pays du ' + qui + ' invalide : ' + p.adresse.pays);
    // L EN 16931 n exige que le pays. Le Code de commerce (L441-9) exige l adresse des deux parties.
    if (!p.adresse.ligne1 || !p.adresse.code_postal || !p.adresse.ville) {
      err('FR-ADRESSE', 'adresse du ' + qui + ' incomplete : ligne1, code postal et ville sont obligatoires sur une facture francaise (' + rAdr + ')');
    }
  }
  if (vendeur.adresse.pays === 'FR' && !/^\d{9}$/.test(vendeur.siren)) {
    err('FR-SIREN', 'SIREN du vendeur manquant ou invalide (9 chiffres) : mention obligatoire');
  }
  if (!acheteur.adresse_electronique.valeur) {
    avert('BR-FR-12', 'adresse electronique de l acheteur (BT-49) absente : exigee par les regles francaises de la reforme');
  }
  if (!vendeur.adresse_electronique.valeur) {
    avert('BR-FR-13', 'adresse electronique du vendeur (BT-34) absente : exigee par les regles francaises de la reforme');
  }
  const date_livraison = txt(e.date_livraison);
  if (date_livraison && !dateValide(date_livraison)) err('BR-CO-19', 'date de livraison invalide : ' + date_livraison);
  if (acheteur.adresse.pays === 'FR' && !acheteur.siren) {
    avert('FR-SIREN-ACHETEUR', 'SIREN de l acheteur absent : mention obligatoire pour une vente entre entreprises depuis la reforme');
  }
  for (const p of [vendeur, acheteur]) {
    if (p.siret && !/^\d{14}$/.test(p.siret)) err('FR-SIRET', 'SIRET invalide (14 chiffres) : ' + p.siret);
  }

  // ── Lignes ─────────────────────────────────────────────────────────────────
  const lignes = [];
  if (!Array.isArray(e.lignes) || !e.lignes.length) err('BR-16', 'une facture porte au moins une ligne');
  (Array.isArray(e.lignes) ? e.lignes : []).forEach((l, i) => {
    l = l || {};
    const id = txt(l.id) || String(i + 1);
    const ou = 'ligne ' + id + ' : ';
    const libelle = txt(l.libelle);
    if (!libelle) err('BR-25', ou + 'libelle manquant');
    let quantite = null, prix = null, taux = null;
    try { quantite = M.dixMilliemes(l.quantite === undefined ? 1 : l.quantite, 'quantite'); }
    catch (x) { err('BR-22', ou + x.message); }
    try { prix = M.dixMilliemes(l.prix_unitaire_ht, 'prix unitaire HT'); }
    catch (x) { err('BR-26', ou + x.message); }
    if (prix !== null && prix < 0n) err('BR-27', ou + 'le prix unitaire ne peut pas etre negatif');
    const t = l.tva || {};
    const categorie = (txt(t.categorie) || 'S').toUpperCase();
    if (!CATEGORIES[categorie]) err('BR-CO-3', ou + 'categorie de TVA inconnue : ' + categorie);
    if (categorie === 'O') {
      if (t.taux !== undefined && t.taux !== null && t.taux !== '') err('BR-O-05', ou + 'une ligne hors champ ne porte pas de taux');
    } else {
      try { taux = M.dixMilliemes(t.taux === undefined ? (TAUX_ZERO.has(categorie) ? 0 : null) : t.taux, 'taux de TVA'); }
      catch (x) { err('BR-CO-4', ou + x.message); }
      if (taux !== null && categorie === 'S' && taux <= 0n) err('BR-S-05', ou + 'une ligne au taux normal porte un taux superieur a zero');
      if (taux !== null && TAUX_ZERO.has(categorie) && taux !== 0n) err('BR-' + categorie + '-05', ou + 'la categorie ' + categorie + ' impose un taux de zero');
    }
    const unite = txt(l.unite) || 'C62';
    if (!/^[A-Z0-9]{1,3}$/.test(unite)) err('BR-23', ou + 'code d unite invalide (UN/ECE Rec 20) : ' + unite);
    lignes.push({
      id, libelle, description: txt(l.description), reference: txt(l.reference),
      quantite, unite, prix, categorie, taux,
      net: (quantite !== null && prix !== null) ? M.netLigne(quantite, prix) : null,
      periode: l.periode ? { debut: txt(l.periode.debut), fin: txt(l.periode.fin) } : null,
    });
  });

  // ── Exonerations et identifiants fiscaux ───────────────────────────────────
  const exonerations = {};
  for (const [cat, x] of Object.entries(e.exonerations || {})) {
    exonerations[cat.toUpperCase()] = { motif: txt(x && x.motif), code: txt(x && x.code) };
  }
  const categoriesPresentes = new Set(lignes.map((l) => l.categorie));
  for (const cat of categoriesPresentes) {
    if (MOTIF_REQUIS.has(cat)) {
      const x = exonerations[cat];
      if (!x || (!x.motif && !x.code)) {
        err('BR-' + (cat === 'K' ? 'IC' : cat) + '-10', 'categorie ' + cat + ' (' + CATEGORIES[cat] + ') sans motif d exoneration. '
          + 'Franchise en base : { "motif": "TVA non applicable, art. 293 B du CGI" }');
      }
    }
    if (ID_VENDEUR.has(cat) && !vendeur.tva && !vendeur.id_fiscal) {
      err('BR-' + (cat === 'K' ? 'IC' : cat) + '-02', 'categorie ' + cat + ' : numero de TVA du vendeur ou identifiant fiscal requis (tva ou id_fiscal)');
    }
    if (ID_ACHETEUR.has(cat) && !acheteur.tva) {
      err('BR-' + (cat === 'K' ? 'IC' : cat) + '-02', 'categorie ' + cat + ' : numero de TVA de l acheteur requis');
    }
    if (cat === 'O' && (vendeur.tva || acheteur.tva)) {
      err('BR-O-02', 'une facture hors champ de la TVA ne porte pas de numero de TVA');
    }
  }

  // ── Paiement, notes, references ────────────────────────────────────────────
  const p = e.paiement || {};
  const moyen = txt(p.moyen);
  if (moyen && !MOYENS[moyen]) err('BR-49', 'moyen de paiement inconnu : ' + moyen + ' (' + Object.keys(MOYENS).join(', ') + ')');
  let deja_paye = 0n;
  if (p.deja_paye !== undefined && p.deja_paye !== null && p.deja_paye !== '') {
    try { deja_paye = M.centimes(p.deja_paye, 'montant deja paye'); } catch (x) { err('BR-CO-16', x.message); }
  }
  const paiement = {
    moyen, code: MOYENS[moyen] || '', deja_paye,
    conditions: txt(p.conditions), iban: sansEspace(p.iban).toUpperCase(), reference: txt(p.reference),
  };
  // BR-61 (EN 16931) : un virement porte le compte a crediter (BT-84). Constate le 21/11 : Super PDP
  // rejette la facture sans lui (CII-SR-470), alors que Mustang la laisse passer.
  if ((paiement.code === '30' || paiement.code === '58') && !paiement.iban) {
    err('BR-61', 'paiement par virement : l IBAN du compte a crediter (paiement.iban) est obligatoire');
  }

  const notes = (Array.isArray(e.notes) ? e.notes : [])
    .map((n) => (typeof n === 'string' ? { texte: txt(n), code: '' } : { texte: txt(n && n.texte), code: txt(n && n.code).toUpperCase() }))
    .filter((n) => n.texte);
  const codesNotes = new Set(notes.map((n) => n.code));
  if (!codesNotes.has('PMD')) avert('FR-PENALITES', 'taux des penalites de retard absent (note PMD) : obligatoire entre entreprises');
  if (!codesNotes.has('PMT')) avert('FR-INDEMNITE', 'indemnite forfaitaire de recouvrement de 40 euros absente (note PMT) : obligatoire entre entreprises');
  if (!codesNotes.has('AAB')) avert('FR-ESCOMPTE', 'conditions d escompte absentes (note AAB) : obligatoires, meme pour dire qu il n y en a pas');
  if (!txt(e.cadre_facturation)) avert('FR-CADRE', 'cadre de facturation (BT-23) absent : exige par les plateformes agreees (BR-FR-08), par exemple S1 (services), B1 (biens) ou M1 (mixte)');

  const refs = e.references || {};
  const references = {
    commande: txt(refs.commande), contrat: txt(refs.contrat),
    facture_precedente: refs.facture_precedente
      ? { numero: txt(refs.facture_precedente.numero), date: txt(refs.facture_precedente.date) } : null,
  };
  if (type === 'avoir' && !(references.facture_precedente && references.facture_precedente.numero)) {
    avert('BR-55', 'un avoir devrait citer la facture qu il corrige (references.facture_precedente)');
  }

  const facture = {
    type, typeCode: TYPES[type] || '380', numero, date_emission, date_echeance, devise, periode,
    cadre_facturation: txt(e.cadre_facturation),
    date_livraison,
    vendeur, acheteur, lignes, exonerations, paiement, notes, references,
  };

  let totaux = null;
  if (!erreurs.length) {
    totaux = calculer(facture);
    if (paiement.deja_paye > totaux.total_ttc) err('BR-CO-16', 'le montant deja paye depasse le total TTC');
    if (!date_echeance && totaux.net_a_payer > 0n && !paiement.conditions) {
      err('BR-CO-25', 'un montant reste du : date d echeance ou conditions de paiement obligatoires');
    }
  }
  return { ok: erreurs.length === 0, facture, totaux, erreurs, avertissements };
}

/** Totaux et ventilation de TVA. La TVA se calcule par categorie et taux, sur la base de chacune (BR-CO-17). */
function calculer(f) {
  const groupes = new Map();
  let lignes_ht = 0n;
  for (const l of f.lignes) {
    lignes_ht += l.net;
    const cle = l.categorie + '|' + (l.taux === null ? '' : l.taux.toString());
    if (!groupes.has(cle)) groupes.set(cle, { categorie: l.categorie, taux: l.taux, base: 0n });
    groupes.get(cle).base += l.net;
  }
  const ventilation = [...groupes.values()]
    .sort((a, b) => (a.categorie + a.taux).localeCompare(b.categorie + b.taux))
    .map((g) => Object.assign(g, {
      tva: g.taux === null ? 0n : M.montantTva(g.base, g.taux),
      motif: (f.exonerations[g.categorie] || {}).motif || '',
      code: (f.exonerations[g.categorie] || {}).code || '',
    }));
  const total_tva = ventilation.reduce((s, g) => s + g.tva, 0n);
  const total_ttc = lignes_ht + total_tva;
  return {
    lignes_ht, base_ht: lignes_ht, ventilation, total_tva, total_ttc,
    deja_paye: f.paiement.deja_paye, net_a_payer: total_ttc - f.paiement.deja_paye,
  };
}

module.exports = { analyser, calculer, TYPES, CATEGORIES, MOYENS, dateValide };
