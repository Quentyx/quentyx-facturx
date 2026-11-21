// SPDX-License-Identifier: LGPL-3.0-only
// Copyright (C) 2026 Anthony Renard
'use strict';
/*
 * LA FACTURE VISIBLE, en PDF/A-3, avec son XML Factur-X joint.
 *
 * Le moteur ne porte pas d identite visuelle. C est l INTERFACE qui decide du
 * style (choix pose le 2026-09-22) : un SaaS passe son GABARIT, ou a defaut un THEME
 * (couleurs, polices, logo) applique au gabarit neutre. Le moteur, lui, garantit
 * la conformite, quel que soit le dessin.
 *
 * La facture visible et le XML sortent des MEMES donnees analysees : c est ce
 * qui autorise la relation Alternative (memes informations sous deux formes).
 */

const path = require('path');
const M = require('./montants');
const { DocumentPdf, RESSOURCES } = require('./pdf/document');

const L = 595.28, H = 841.89, G = 48, HAUT = 48, BAS = 64;
const UNITES = { C62: '', H87: '', HUR: 'h', DAY: 'j', MON: 'mois', WEE: 'sem.', MIN: 'min', KGM: 'kg', MTR: 'm', LTR: 'l' };
const LIBELLES_TVA = { Z: '0 %', E: 'exonérée', AE: 'autoliq.', K: 'intracom.', G: 'export', O: 'hors champ' };
const MOYENS_LISIBLES = { carte: 'carte bancaire', virement: 'virement', virement_sepa: 'virement SEPA', prelevement: 'prélèvement SEPA', especes: 'espèces', cheque: 'chèque', autre: 'autre moyen' };

const dateFr = (iso) => (iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4) : '');

/**
 * LE GABARIT NEUTRE. Un SaaS qui a son propre design passe SON gabarit a
 * produire() : c est l interface qui decide du style, pas le moteur. Le
 * gabarit ne dessine que la page ; le XML, le PDF/A-3 et les metadonnees sont
 * poses par le moteur ensuite, quel que soit le gabarit. Et comme il ne peut
 * ecrire qu avec doc.police() et doc.image(), toute police qu il emploie est
 * embarquee : la conformite ne depend pas de lui.
 *
 * Il recoit : { doc, facture, totaux, theme, brouillon, M, dateFr,
 * LIBELLES_TVA, MOYENS_LISIBLES, RESSOURCES }.
 */
function gabaritNeutre(ctx) {
  const { doc, facture: f, totaux: t, theme, brouillon } = ctx;
  const R = doc.police(theme.police);
  const B = doc.police(theme.policeGras);
  const logo = theme.logo ? doc.image(theme.logo) : null;

  let page, y;
  const nouvellePage = () => { page = doc.nouvellePage(L, H); y = HAUT; };
  const ecrire = (x, yy, s, police, taille, c) => {
    if (s) page.texte(x, H - yy, s, police, taille, c || theme.texte);
  };
  const aDroite = (xDroite, yy, s, police, taille, c) => ecrire(xDroite - police.police.largeur(s, taille), yy, s, police, taille, c);
  const couper = (police, texte, taille, largeurMax) => {
    const lignes = [];
    for (const para of String(texte || '').split('\n')) {
      let courante = '';
      for (let mot of para.split(/\s+/).filter(Boolean)) {
        while (police.police.largeur(mot, taille) > largeurMax && mot.length > 1) {
          let k = mot.length - 1;
          while (k > 1 && police.police.largeur(mot.slice(0, k), taille) > largeurMax) k--;
          if (courante) { lignes.push(courante); courante = ''; }
          lignes.push(mot.slice(0, k)); mot = mot.slice(k);
        }
        const essai = courante ? courante + ' ' + mot : mot;
        if (!courante || police.police.largeur(essai, taille) <= largeurMax) courante = essai;
        else { lignes.push(courante); courante = mot; }
      }
      lignes.push(courante);
    }
    return lignes.filter((l, i, a) => l || (i > 0 && i < a.length - 1));
  };
  const bloc = (x, yy, lignes, police, taille, interligne, c, largeurMax) => {
    for (const l of lignes) {
      for (const morceau of largeurMax ? couper(police, l, taille, largeurMax) : [l]) {
        ecrire(x, yy, morceau, police, taille, c); yy += interligne;
      }
    }
    return yy;
  };

  nouvellePage();

  // ── En-tete : vendeur a gauche, titre et references a droite ─────────────
  let yG = HAUT;
  if (logo) {
    const h = 44, l = h * logo.largeur / logo.hauteur;
    page.image(logo, G, H - yG - h, l, h);
    yG += h + 12;
  }
  const v = f.vendeur;
  const mentionCourte = v.mention_legale && v.mention_legale.length <= 12;
  yG = bloc(G, yG + 11, [v.nom + (mentionCourte ? ' ' + v.mention_legale : '')], B, 12.5, 16, theme.texte, 250);
  const lignesVendeur = [
    mentionCourte ? '' : v.mention_legale,
    v.adresse.ligne1, v.adresse.ligne2, v.adresse.ligne3,
    [v.adresse.code_postal, v.adresse.ville].filter(Boolean).join(' ') + (v.adresse.pays !== 'FR' ? ', ' + v.adresse.pays : ''),
    v.siret ? 'SIRET ' + v.siret : (v.siren ? 'SIREN ' + v.siren : ''),
    v.tva ? 'TVA ' + v.tva : '',
    v.courriel,
  ].filter(Boolean);
  yG = bloc(G, yG, lignesVendeur, R, 8.6, 12, theme.doux, 250);

  const titre = brouillon ? 'BROUILLON' : (f.type === 'avoir' ? 'AVOIR' : 'FACTURE');
  aDroite(L - G, HAUT + 20, titre, B, 22, theme.accent);
  let yD = HAUT + 40;
  if (brouillon) { aDroite(L - G, yD, 'Document sans valeur de facture', R, 8.6, theme.doux); yD += 14; }
  aDroite(L - G, yD, 'N° ' + (f.numero || 'à attribuer'), B, 10.5, theme.texte); yD += 15;
  const refs = [
    'Date : ' + dateFr(f.date_emission),
    f.date_echeance ? 'Échéance : ' + dateFr(f.date_echeance) : '',
    f.periode && f.periode.debut ? 'Période : ' + dateFr(f.periode.debut) + ' au ' + dateFr(f.periode.fin) : '',
    f.references.commande ? 'Commande : ' + f.references.commande : '',
    f.references.facture_precedente && f.references.facture_precedente.numero
      ? 'Corrige la facture ' + f.references.facture_precedente.numero : '',
  ].filter(Boolean);
  for (const r of refs) { aDroite(L - G, yD, r, R, 8.8, theme.doux); yD += 12.5; }

  // ── Acheteur ──────────────────────────────────────────────────────────────
  const a = f.acheteur;
  const xA = L - G - 230;
  let yA = Math.max(yD + 14, yG - 30);
  const lignesAcheteur = [
    a.adresse.ligne1, a.adresse.ligne2, a.adresse.ligne3,
    [a.adresse.code_postal, a.adresse.ville].filter(Boolean).join(' ') + (a.adresse.pays !== 'FR' ? ', ' + a.adresse.pays : ''),
    a.siret ? 'SIRET ' + a.siret : (a.siren ? 'SIREN ' + a.siren : ''),
    a.tva ? 'TVA ' + a.tva : '',
    a.reference ? 'Votre référence : ' + a.reference : '',
  ].filter(Boolean);
  const hauteurA = 30 + couper(B, a.nom, 10.5, 210).length * 14 + lignesAcheteur.length * 12;
  page.rectangle(xA, H - yA - hauteurA, 230, hauteurA, { remplir: theme.fond });
  ecrire(xA + 10, yA + 15, 'FACTURÉ À', B, 7, theme.doux);
  let yB = bloc(xA + 10, yA + 30, [a.nom], B, 10.5, 14, theme.texte, 210);
  bloc(xA + 10, yB, lignesAcheteur, R, 8.6, 12, theme.doux, 210);
  y = Math.max(yG, yA + hauteurA) + 26;

  // ── Lignes ────────────────────────────────────────────────────────────────
  const xTot = L - G, xTva = xTot - 88, xPu = xTva - 50, xQte = xPu - 78, largDesig = xQte - 44 - G - 8;
  const enteteTableau = () => {
    page.rectangle(G, H - y - 20, L - 2 * G, 20, { remplir: theme.fond });
    ecrire(G + 6, y + 13.5, 'Désignation', B, 7.8, theme.doux);
    aDroite(xQte, y + 13.5, 'Qté', B, 7.8, theme.doux);
    aDroite(xPu, y + 13.5, 'Prix unit. HT', B, 7.8, theme.doux);
    aDroite(xTva, y + 13.5, 'TVA', B, 7.8, theme.doux);
    aDroite(xTot - 6, y + 13.5, 'Total HT', B, 7.8, theme.doux);
    y += 28;
  };
  enteteTableau();
  for (const l of f.lignes) {
    const lib = couper(R, l.libelle, 9.2, largDesig);
    const det = [];
    if (l.description) det.push(...couper(R, l.description, 7.8, largDesig));
    if (l.periode && (l.periode.debut || l.periode.fin)) det.push('Du ' + dateFr(l.periode.debut) + ' au ' + dateFr(l.periode.fin));
    const hauteur = lib.length * 12 + det.length * 10.5 + 10;
    if (y + hauteur > H - BAS - 20) { nouvellePage(); enteteTableau(); }
    const y0 = y + 9;
    bloc(G + 6, y0, lib, R, 9.2, 12, theme.texte);
    bloc(G + 6, y0 + lib.length * 12, det, R, 7.8, 10.5, theme.doux);
    const unite = UNITES[l.unite] !== undefined ? UNITES[l.unite] : l.unite;
    aDroite(xQte, y0, M.frDecimal(l.quantite) + (unite ? ' ' + unite : ''), R, 9.2);
    aDroite(xPu, y0, M.frPrix(l.prix, f.devise), R, 9.2);
    aDroite(xTva, y0, l.categorie === 'S' ? M.frDecimal(l.taux) + ' %' : LIBELLES_TVA[l.categorie], R, 8.4, theme.doux);
    aDroite(xTot - 6, y0, M.frMontant(l.net, f.devise), R, 9.2);
    y += hauteur;
    page.ligne(G, H - y + 2, L - G, H - y + 2, theme.filet, 0.5);
    y += 6;
  }

  // ── Totaux a droite, mentions a gauche ────────────────────────────────────
  const lignesTotaux = [['Total HT', M.frMontant(t.lignes_ht, f.devise), R]];
  for (const g of t.ventilation) {
    const lib = g.categorie === 'S' ? 'TVA ' + M.frDecimal(g.taux) + ' %' : 'TVA ' + LIBELLES_TVA[g.categorie];
    lignesTotaux.push([lib, M.frMontant(g.tva, f.devise), R]);
  }
  lignesTotaux.push(['Total TTC', M.frMontant(t.total_ttc, f.devise), B]);
  if (t.deja_paye) lignesTotaux.push(['Déjà payé', '-' + M.frMontant(t.deja_paye, f.devise), R]);
  lignesTotaux.push(['Net à payer', M.frMontant(t.net_a_payer, f.devise), B]);

  const mentions = [];
  for (const g of t.ventilation) if (g.motif) mentions.push(g.motif);
  const p = f.paiement;
  if (p.moyen) mentions.push('Paiement : ' + (MOYENS_LISIBLES[p.moyen] || p.moyen)
    + (t.deja_paye && t.net_a_payer === 0n ? ', facture réglée' : ''));
  if (p.conditions) mentions.push(p.conditions);
  if (p.iban) mentions.push('IBAN ' + p.iban.replace(/(.{4})/g, '$1 ').trim());
  if (p.reference) mentions.push('Référence de paiement : ' + p.reference);

  const xT = L - G - 210;
  const hauteurTotaux = lignesTotaux.length * 17 + 10;
  const lignesMentions = mentions.flatMap((m) => couper(R, m, 8.4, xT - G - 24));
  const besoin = Math.max(hauteurTotaux, lignesMentions.length * 11.5) + 20;
  if (y + besoin > H - BAS) nouvellePage();
  y += 10;
  let yT = y;
  lignesTotaux.forEach(([lib, val, police], i) => {
    const derniere = i === lignesTotaux.length - 1;
    if (derniere) page.rectangle(xT, H - yT - 20, 210, 22, { remplir: theme.fond });
    if (lib === 'Total TTC') page.ligne(xT, H - yT + 4, L - G, H - yT + 4, theme.filet, 0.6);
    const c = derniere ? theme.accent : theme.texte;
    ecrire(xT + 8, yT + (derniere ? 14 : 12), lib, police, derniere ? 10.5 : 9, c);
    aDroite(L - G - 8, yT + (derniere ? 14 : 12), val, police, derniere ? 10.5 : 9, c);
    yT += 17;
  });
  bloc(G, y + 12, lignesMentions, R, 8.4, 11.5, theme.texte);
  y = Math.max(yT + 10, y + 12 + lignesMentions.length * 11.5) + 18;

  // ── Notes legales : penalites, indemnite, escompte, et le reste ───────────
  const notes = f.notes.flatMap((n) => couper(R, n.texte, 7.6, L - 2 * G));
  if (notes.length) {
    if (y + notes.length * 10 > H - BAS) nouvellePage();
    page.ligne(G, H - y + 6, L - G, H - y + 6, theme.filet, 0.5);
    y = bloc(G, y + 18, notes, R, 7.6, 10, theme.doux);
  }

  // ── Pied de page, sur chaque page ─────────────────────────────────────────
  const total = doc.pages.length;
  doc.pages.forEach((pg, i) => {
    page = pg;
    const identite = [v.nom + (mentionCourte ? ' ' + v.mention_legale : ''), v.siren ? 'SIREN ' + v.siren : ''].filter(Boolean).join(' · ');
    page.ligne(G, BAS - 18, L - G, BAS - 18, theme.filet, 0.5);
    ecrire(G, H - BAS + 32, identite, R, 7.2, theme.doux);
    aDroite(L - G, H - BAS + 32, 'Facture électronique Factur-X EN 16931' + (total > 1 ? ' · page ' + (i + 1) + ' sur ' + total : ''), R, 7.2, theme.doux);
  });

}

const THEME_NEUTRE = {
  accent: '#1F3A5F', texte: '#1B1B22', doux: '#5F5F6B', filet: '#DADAE0', fond: '#F3F4F7',
  police: path.join(RESSOURCES, 'polices', 'DejaVuSans.ttf'),
  policeGras: path.join(RESSOURCES, 'polices', 'DejaVuSans-Bold.ttf'),
  logo: null,
};

function rendre(f, t, xml, options) {
  const o = options || {};
  const theme = Object.assign({}, THEME_NEUTRE, o.theme || {});
  const gabarit = o.gabarit || gabaritNeutre;
  if (typeof gabarit !== 'function') throw new Error('gabarit : une fonction est attendue');
  const titreDoc = (f.type === 'avoir' ? 'Avoir ' : 'Facture ') + (f.numero || 'brouillon');
  const doc = new DocumentPdf({ titre: titreDoc, auteur: f.vendeur.nom, sujet: titreDoc + ', ' + f.acheteur.nom, date: o.date || new Date() });

  gabarit({ doc, facture: f, totaux: t, theme, brouillon: !!o.brouillon, M, dateFr, LIBELLES_TVA, MOYENS_LISIBLES, RESSOURCES });
  if (!doc.pages.length) throw new Error('le gabarit n a produit aucune page');

  doc.declarerFacturx('EN 16931', 'factur-x.xml');
  doc.joindre('factur-x.xml', Buffer.from(xml, 'utf8'), {
    mime: 'text/xml', relation: 'Alternative', description: 'Facture au format Factur-X, profil EN 16931',
  });
  const absents = new Set();
  for (const p of doc.polices) for (const c of p.police.manquants) absents.add(c);
  return { pdf: doc.enOctets(), pages: doc.pages.length, glyphes_absents: [...absents] };
}

module.exports = { rendre, gabaritNeutre, THEME_NEUTRE };
