// SPDX-License-Identifier: LGPL-3.0-only
// Copyright (C) 2026 Anthony Renard
'use strict';
/*
 * MONTANTS. Aucun flottant dans un calcul de facture.
 *
 * Un montant se tient en CENTIMES, un prix, une quantite ou un taux en
 * DIX-MILLIEMES, toujours en BigInt. Le flottant de JavaScript donne
 * 0.1 + 0.2 = 0.30000000000000004 : sur une facture, un centime d ecart entre
 * les lignes et le total suffit a la faire rejeter, les regles BR-CO-10 a
 * BR-CO-17 de l EN 16931 comparent les sommes au centime pres.
 */

const DIX_MILLE = 10000n;
const ESPACE_FINE = String.fromCharCode(0x202F);
const INSECABLE = String.fromCharCode(0x00A0);

function lireDecimal(v, echelle, quoi) {
  if (v === null || v === undefined || v === '') throw new Error(quoi + ' manquant');
  if (typeof v === 'bigint') throw new Error(quoi + ' : attendu un nombre ou une chaine, pas un BigInt');
  let s = typeof v === 'number'
    ? (Number.isFinite(v) ? v.toString() : 'x')
    : String(v).trim().replace(',', '.');
  if (/e/i.test(s)) s = Number(s).toFixed(12);
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(quoi + ' invalide : ' + v);
  const chiffres = echelle.toString().length - 1;
  const frac = (m[3] || '').replace(/0+$/, '');
  if (frac.length > chiffres) {
    throw new Error(quoi + ' : au plus ' + chiffres + ' decimales, recu ' + v);
  }
  const val = BigInt(m[2]) * echelle + BigInt((frac + '0'.repeat(chiffres)).slice(0, chiffres) || '0');
  return m[1] ? -val : val;
}

const centimes     = (v, quoi) => lireDecimal(v, 100n, quoi || 'montant');
const dixMilliemes = (v, quoi) => lireDecimal(v, DIX_MILLE, quoi || 'valeur');

/** Division arrondie au plus proche, les demis s eloignent de zero : l arrondi commercial. */
function diviserArrondi(n, d) {
  const negatif = (n < 0n) !== (d < 0n);
  const a = n < 0n ? -n : n;
  const b = d < 0n ? -d : d;
  const q = (2n * a + b) / (2n * b);
  return negatif ? -q : q;
}

/** Net d une ligne en centimes : quantite x prix, tous deux en dix-milliemes. */
const netLigne = (quantite4, prix4) => diviserArrondi(quantite4 * prix4, 1000000n);

/** TVA en centimes : base en centimes x taux en dix-milliemes de point / 100. */
const montantTva = (baseCentimes, taux4) => diviserArrondi(baseCentimes * taux4, 1000000n);

function versTexte(n, chiffres) {
  const negatif = n < 0n;
  const a = negatif ? -n : n;
  const e = 10n ** BigInt(chiffres);
  const s = (a / e).toString() + (chiffres ? '.' + (a % e).toString().padStart(chiffres, '0') : '');
  return (negatif ? '-' : '') + s;
}

/** Montant pour le XML : point decimal, toujours deux decimales. */
const xmlMontant = (c) => versTexte(c, 2);

/** Quantite, prix ou taux pour le XML : zeros inutiles retires. */
function xmlDecimal(n4) {
  const s = versTexte(n4, 4).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

/** Montant a la francaise : 1 234,56 EUR, espaces insecables. */
function frMontant(c, devise) {
  const negatif = c < 0n;
  const [e, f] = versTexte(negatif ? -c : c, 2).split('.');
  const groupes = e.replace(/\B(?=(\d{3})+(?!\d))/g, ESPACE_FINE);
  const symbole = (!devise || devise === 'EUR') ? '€' : devise;
  return (negatif ? '-' : '') + groupes + ',' + f + INSECABLE + symbole;
}

/** Prix unitaire a la francaise : au centime, ou jusqu a 4 decimales s il en porte. */
function frPrix(prix4, devise) {
  if (prix4 % 100n === 0n) return frMontant(prix4 / 100n, devise);
  const symbole = (!devise || devise === 'EUR') ? '€' : devise;
  return xmlDecimal(prix4).replace('.', ',') + INSECABLE + symbole;
}

/** Decimal a la francaise : 1,5 ou 20. */
const frDecimal = (n4) => xmlDecimal(n4).replace('.', ',');

module.exports = {
  centimes, dixMilliemes, diviserArrondi, netLigne, montantTva,
  xmlMontant, xmlDecimal, frMontant, frPrix, frDecimal, ESPACE_FINE, INSECABLE,
};
