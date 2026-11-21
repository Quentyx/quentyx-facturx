// SPDX-License-Identifier: LGPL-3.0-only
// Copyright (C) 2026 Anthony Renard
'use strict';
/*
 * LECTURE XML, sans dependance. Le pendant de lib/xml.js : ici on LIT une
 * facture recue, donc un fichier ecrit par n importe qui.
 *
 * Ce que le lecteur refuse, exprès :
 *   - toute declaration DOCTYPE : pas d entite externe (XXE), pas de bombe
 *     d entites ; aucune facture CII ou UBL n en a besoin ;
 *   - un fichier de plus de LIMITE_OCTETS, une profondeur de plus de LIMITE_PROFONDEUR.
 *
 * Les ESPACES DE NOMS sont resolus : un element se reconnait a son URI et a son
 * nom local, jamais a son prefixe. Une facture recue peut ecrire `ram:` ou `a:`,
 * c est le meme element.
 *
 * Chaque noeud porte `lu` : les fonctions de lecture le marquent, ce qui permet
 * de dire a l appelant quels elements de la facture le moteur n a PAS lus.
 */

const LIMITE_OCTETS = 32 * 1024 * 1024;
const LIMITE_PROFONDEUR = 256;

const ENTITES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function erreur(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function decoderEntites(s, ou) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);?/g, (m, n) => {
    if (!m.endsWith(';')) throw erreur('LECTURE-XML', 'entite mal fermee ' + ou);
    if (n[0] === '#') {
      const c = n[1] === 'x' ? parseInt(n.slice(2), 16) : parseInt(n.slice(1), 10);
      if (!Number.isFinite(c) || c > 0x10FFFF) throw erreur('LECTURE-XML', 'reference de caractere invalide ' + ou);
      return String.fromCodePoint(c);
    }
    if (!(n in ENTITES)) throw erreur('LECTURE-XML', 'entite inconnue &' + n + '; ' + ou);
    return ENTITES[n];
  });
}

/**
 * Analyse un document XML. Rend la racine : { nom, prefixe, local, ns, attributs, enfants, texte, lu, parent }.
 * Leve une erreur de code LECTURE-XML si le document est mal forme.
 */
function analyserXml(source) {
  let s = Buffer.isBuffer(source) ? source : Buffer.from(String(source), 'utf8');
  if (s.length > LIMITE_OCTETS) throw erreur('LECTURE-TAILLE', 'XML de plus de ' + (LIMITE_OCTETS >> 20) + ' Mo');
  if (s[0] === 0xFE && s[1] === 0xFF) throw erreur('LECTURE-XML', 'XML en UTF-16 non pris en charge');
  if (s[0] === 0xFF && s[1] === 0xFE) {
    s = s.subarray(2).toString('utf16le');
  } else {
    s = s.toString('utf8');
  }
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);

  let i = 0;
  const n = s.length;
  const ligne = () => 'ligne ' + (s.slice(0, i).split('\n').length);
  let racine = null;
  const pile = [];

  const resoudre = (noeud) => {
    const decl = (p) => {
      for (let x = noeud; x; x = x.parent) {
        const cle = p ? 'xmlns:' + p : 'xmlns';
        if (cle in x.attributs) return x.attributs[cle];
      }
      return p === 'xml' ? 'http://www.w3.org/XML/1998/namespace' : (p ? null : '');
    };
    const k = noeud.nom.indexOf(':');
    noeud.prefixe = k < 0 ? '' : noeud.nom.slice(0, k);
    noeud.local = k < 0 ? noeud.nom : noeud.nom.slice(k + 1);
    const ns = decl(noeud.prefixe);
    if (ns === null) throw erreur('LECTURE-XML', 'prefixe non declare : ' + noeud.prefixe + ' (' + ligne() + ')');
    noeud.ns = ns;
    // Attributs : leur nom local, sans espace de noms par defaut.
    noeud.attrs = {};
    for (const [a, v] of Object.entries(noeud.attributs)) {
      if (a === 'xmlns' || a.startsWith('xmlns:')) continue;
      const j = a.indexOf(':');
      noeud.attrs[j < 0 ? a : a.slice(j + 1)] = v;
    }
  };

  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt < 0) {
      const reste = s.slice(i);
      if (pile.length) pile[pile.length - 1].morceaux.push(decoderEntites(reste, ligne()));
      else if (reste.trim()) throw erreur('LECTURE-XML', 'texte hors de la racine (' + ligne() + ')');
      break;
    }
    if (lt > i) {
      const t = s.slice(i, lt);
      if (pile.length) pile[pile.length - 1].morceaux.push(decoderEntites(t, ligne()));
      else if (t.trim()) throw erreur('LECTURE-XML', 'texte hors de la racine (' + ligne() + ')');
    }
    i = lt;
    if (s.startsWith('<!--', i)) {
      const f = s.indexOf('-->', i + 4);
      if (f < 0) throw erreur('LECTURE-XML', 'commentaire non ferme');
      i = f + 3; continue;
    }
    if (s.startsWith('<![CDATA[', i)) {
      const f = s.indexOf(']]>', i + 9);
      if (f < 0 || !pile.length) throw erreur('LECTURE-XML', 'CDATA mal place ou non ferme');
      pile[pile.length - 1].morceaux.push(s.slice(i + 9, f));
      i = f + 3; continue;
    }
    if (s.startsWith('<?', i)) {
      const f = s.indexOf('?>', i + 2);
      if (f < 0) throw erreur('LECTURE-XML', 'instruction non fermee');
      i = f + 2; continue;
    }
    if (s.startsWith('<!', i)) {
      throw erreur('LECTURE-XML-DOCTYPE', 'declaration DOCTYPE refusee : une facture n en a pas besoin, et elle ouvre la porte aux entites externes');
    }
    if (s[i + 1] === '/') {
      const f = s.indexOf('>', i);
      if (f < 0) throw erreur('LECTURE-XML', 'balise fermante non terminee');
      const nom = s.slice(i + 2, f).trim();
      const ouvert = pile.pop();
      if (!ouvert || ouvert.nom !== nom) throw erreur('LECTURE-XML', 'balise </' + nom + '> sans ouverture correspondante (' + ligne() + ')');
      ouvert.texte = ouvert.morceaux.join('');
      delete ouvert.morceaux;
      i = f + 1; continue;
    }
    // Balise ouvrante : nom, attributs entre guillemets, fin > ou />.
    const m = /^<([A-Za-z_][\w.\-]*(?::[A-Za-z_][\w.\-]*)?)/.exec(s.slice(i, i + 300));
    if (!m) throw erreur('LECTURE-XML', 'balise invalide (' + ligne() + ')');
    i += m[0].length;
    const attributs = {};
    for (;;) {
      while (i < n && /\s/.test(s[i])) i++;
      if (s[i] === '>' || (s[i] === '/' && s[i + 1] === '>')) break;
      const am = /^([A-Za-z_][\w.\-]*(?::[A-Za-z_][\w.\-]*)?)\s*=\s*(["'])/.exec(s.slice(i, i + 300));
      if (!am) throw erreur('LECTURE-XML', 'attribut invalide dans <' + m[1] + '> (' + ligne() + ')');
      i += am[0].length;
      const f = s.indexOf(am[2], i);
      if (f < 0) throw erreur('LECTURE-XML', 'valeur d attribut non fermee');
      const v = s.slice(i, f);
      if (v.indexOf('<') >= 0) throw erreur('LECTURE-XML', 'caractere < dans un attribut');
      if (am[1] in attributs) throw erreur('LECTURE-XML', 'attribut en double : ' + am[1]);
      attributs[am[1]] = decoderEntites(v, ligne());
      i = f + 1;
    }
    const parent = pile.length ? pile[pile.length - 1] : null;
    const noeud = { nom: m[1], attributs, enfants: [], morceaux: [], texte: '', lu: false, parent };
    resoudre(noeud);
    if (parent) parent.enfants.push(noeud);
    else if (racine) throw erreur('LECTURE-XML', 'deux elements racines');
    else racine = noeud;
    if (s[i] === '/') {
      noeud.texte = ''; delete noeud.morceaux;
      i += 2;
    } else {
      i += 1;
      pile.push(noeud);
      if (pile.length > LIMITE_PROFONDEUR) throw erreur('LECTURE-XML', 'profondeur de plus de ' + LIMITE_PROFONDEUR);
    }
  }
  if (pile.length) throw erreur('LECTURE-XML', 'element <' + pile[pile.length - 1].nom + '> non ferme');
  if (!racine) throw erreur('LECTURE-XML', 'aucun element racine');
  return racine;
}

/*
 * LECTURE PAR CHEMIN. Les prefixes ci-dessous sont les NOTRES, resolus en URI :
 * ils ne dependent pas de ceux du fichier lu.
 */
const NS = {
  rsm: 'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100',
  ram: 'urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100',
  udt: 'urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100',
  qdt: 'urn:un:unece:uncefact:data:standard:QualifiedDataType:100',
  inv: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  cn: 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2',
  cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
};

function correspond(noeud, etape) {
  const k = etape.indexOf(':');
  return noeud.local === etape.slice(k + 1) && noeud.ns === NS[etape.slice(0, k)];
}

/** Tous les noeuds au bout du chemin 'ram:A/ram:B', marques lus, eux et le chemin. */
function tous(noeud, chemin) {
  if (!noeud) return [];
  let courant = [noeud];
  for (const etape of chemin.split('/')) {
    const suivant = [];
    for (const c of courant) for (const e of c.enfants) if (correspond(e, etape)) suivant.push(e);
    courant = suivant;
  }
  for (const c of courant) for (let x = c; x && !x.lu; x = x.parent) x.lu = true;
  return courant;
}
const un = (noeud, chemin) => tous(noeud, chemin)[0] || null;
const texte = (noeud, chemin) => {
  const x = chemin ? un(noeud, chemin) : noeud;
  if (x) x.lu = true;
  return x ? x.texte.trim() : '';
};
const attribut = (noeud, nom) => (noeud && noeud.attrs[nom] !== undefined ? String(noeud.attrs[nom]).trim() : '');

/**
 * Les elements que la lecture n a pas touches : chacun est un noeud non lu dont
 * le parent, lui, a ete lu. On rend leurs chemins, sans doublon.
 */
function nonLus(racine) {
  const chemins = new Set();
  const nommer = (x) => {
    const p = [];
    for (let y = x; y; y = y.parent) p.unshift(y.local);
    return p.join('/');
  };
  const parcourir = (x) => {
    for (const e of x.enfants) {
      if (!e.lu) chemins.add(nommer(e));
      else parcourir(e);
    }
  };
  parcourir(racine);
  return [...chemins];
}

module.exports = { analyserXml, tous, un, texte, attribut, nonLus, correspond, NS, LIMITE_OCTETS };
