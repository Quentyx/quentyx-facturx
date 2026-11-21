// SPDX-License-Identifier: LGPL-3.0-only
// Copyright (C) 2026 Anthony Renard
'use strict';
/*
 * LA COUTURE ENTRE LE LIBRE ET LE PRO (2026-11-21, _suite/modele-open-core.md).
 *
 * Le Libre, c est ce moteur SANS le dossier pro/ : il valide, produit et rend une facture
 * EN 16931 en PDF/A-3, seul, sans quentyx-journal ni rien d autre. Le Pro s ajoute sans
 * toucher au Libre, par ce seul fichier, le seul a savoir que le Pro existe :
 *   1. le dossier pro/ a cote du moteur (le developpement, sur le VPS) ;
 *   2. sinon le paquet quentyx-facturx-pro, installe depuis le registre prive.
 * QUENTYX_FACTURX_LIBRE=1 force le Libre seul : c est ainsi que les essais prouvent qu il tient.
 *
 * Une extension exporte { nom, version, installer(api) } ; installer recoit l API du Libre et
 * rend les operations qu elle ajoute. LE CONTRAT RESTE IDENTIQUE : une operation Pro absente
 * existe toujours, et refuse avec le code PALIER_PRO au lieu de disparaitre.
 *
 * Remplacer le mode de livraison du Pro ne change que ce fichier : c est la couture.
 */
const path = require('path');

const SOURCES = [path.join(__dirname, '..', 'pro'), 'quentyx-facturx-pro'];

// Seule l absence de l extension elle-meme est silencieuse. Un module manquant A L INTERIEUR
// du Pro (quentyx-journal introuvable, par exemple) remonte : c est une panne, pas un Libre.
function introuvable(e, source) {
  return !!e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes("'" + source + "'");
}

function charger(api) {
  if (process.env.QUENTYX_FACTURX_LIBRE === '1') return { present: false, operations: {} };
  for (const source of SOURCES) {
    let ext;
    try { ext = require(source); } catch (e) { if (introuvable(e, source)) continue; throw e; }
    if (!ext || typeof ext.installer !== 'function') throw new Error('extension Pro invalide (' + source + ') : installer(api) manquant');
    return { present: true, nom: ext.nom, version: ext.version, operations: ext.installer(api) || {} };
  }
  return { present: false, operations: {} };
}

function absente(nom) {
  return function operationPro() {
    const e = new Error(nom + ' est une fonction du palier Pro (quentyx-facturx-pro), absent de cette installation.');
    e.code = 'PALIER_PRO';
    return Promise.reject(e);
  };
}

module.exports = { charger, absente, SOURCES };
