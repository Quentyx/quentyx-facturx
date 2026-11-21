'use strict';
/*
 * Ecriture XML, sans dependance. Il ne s agit pas de lire du XML, seulement
 * d en produire un correct : echappement, elements facultatifs, indentation.
 * Aucune bibliotheque XML n est necessaire pour cela.
 */

// Caracteres interdits en XML 1.0 : controles sauf tabulation, saut de ligne, retour.
const INTERDITS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

function echapper(s) {
  return String(s).replace(INTERDITS, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Un element. Les enfants null, undefined, false ou vides sont omis : c est ce
 * qui rend un element facultatif sans multiplier les conditions a l appel.
 *   el('ram:ID', '123')
 *   el('ram:ID', { schemeID: '0002' }, '123')
 */
function el(nom, attributs, ...enfants) {
  if (attributs === null || attributs === undefined || typeof attributs !== 'object'
      || Array.isArray(attributs) || attributs.__el) {
    enfants.unshift(attributs);
    attributs = {};
  }
  const liste = enfants.flat(Infinity)
    .filter((e) => e !== null && e !== undefined && e !== false && e !== '');
  return { __el: true, nom, attributs, enfants: liste };
}

/**
 * Un element que le schema EXIGE meme vide (ApplicableHeaderTradeDelivery).
 * Tous les autres elements sans contenu sont omis a l ecriture : Mustang l a
 * montre le 2026-09-22, un <ram:ExemptionReason/> vide compte comme un motif
 * present, et rend invalide une ligne a TVA normale (BR-S-10).
 */
function obligatoire(nom, attributs, ...enfants) {
  const e = el(nom, attributs, ...enfants);
  e.garder = true;
  return e;
}

/** Comme el, mais rend null si l element n a aucun enfant : un agregat facultatif vide disparait. */
function opt(nom, attributs, ...enfants) {
  const e = el(nom, attributs, ...enfants);
  return e.enfants.length ? e : null;
}

const estVide = (n) => n.__el && !n.garder && !n.enfants.some((e) => !e.__el || !estVide(e));

function serialiser(n, niveau) {
  niveau = niveau || 0;
  n = Object.assign({}, n, { enfants: n.enfants.filter((e) => !e.__el || !estVide(e)) });
  const ind = '  '.repeat(niveau);
  const attrs = Object.entries(n.attributs)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => ' ' + k + '="' + echapper(v) + '"').join('');
  if (!n.enfants.length) return ind + '<' + n.nom + attrs + '/>';
  if (n.enfants.every((e) => !e.__el)) {
    return ind + '<' + n.nom + attrs + '>' + n.enfants.map(echapper).join('') + '</' + n.nom + '>';
  }
  return ind + '<' + n.nom + attrs + '>\n'
    + n.enfants.map((e) => (e.__el ? serialiser(e, niveau + 1) : ind + '  ' + echapper(e))).join('\n')
    + '\n' + ind + '</' + n.nom + '>';
}

const documentXml = (racine) => '<?xml version="1.0" encoding="UTF-8"?>\n' + serialiser(racine) + '\n';

module.exports = { echapper, el, opt, obligatoire, serialiser, documentXml };
