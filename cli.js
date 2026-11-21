#!/usr/bin/env node
'use strict';
/*
 * Ligne de commande de quentyx-facturx. Sortie JSON sur stdout, pour un humain
 * comme pour un agent. Les fichiers ne sont ecrits que la ou on le demande.
 *
 *   node cli.js catalogue
 *   node cli.js valider  facture.json
 *   node cli.js produire facture.json --sortie DOSSIER [--brouillon] [--theme theme.json]
 *   node cli.js emettre  facture.json --registre DOSSIER [--serie FAC] --sortie DOSSIER [--theme theme.json]
 *   node cli.js lister   --registre DOSSIER [--serie FAC]
 *   node cli.js lire     facture.pdf|facture.xml [--avec-xml]
 */
const fs = require('fs');
const path = require('path');
const fx = require('./evoyx');

function args(argv) {
  const r = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) r[k] = argv[++i]; else r[k] = true;
    } else r._.push(argv[i]);
  }
  return r;
}
const lireJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const sortir = (o, code) => { process.stdout.write(JSON.stringify(fx.versJson(o), null, 2) + '\n'); process.exit(code || 0); };

function ecrire(dossier, r) {
  fs.mkdirSync(dossier, { recursive: true });
  const pdf = path.join(dossier, r.nom_fichier + '.pdf');
  const xml = path.join(dossier, r.nom_fichier + '.xml');
  fs.writeFileSync(pdf, r.pdf);
  fs.writeFileSync(xml, r.xml);
  return { pdf, xml };
}

async function principal() {
  const a = args(process.argv.slice(2));
  const cmd = a._[0];
  const theme = a.theme ? lireJson(a.theme) : undefined;
  if (cmd === 'catalogue') return sortir(fx.CATALOGUE);
  if (cmd === 'valider') {
    const r = fx.valider(lireJson(a._[1]), { brouillon: !!a.brouillon });
    return sortir({ ok: r.ok, totaux: r.totaux, erreurs: r.erreurs, avertissements: r.avertissements }, r.ok ? 0 : 2);
  }
  if (cmd === 'produire') {
    if (!a.sortie) throw new Error('--sortie DOSSIER obligatoire');
    const r = fx.produire(lireJson(a._[1]), { brouillon: !!a.brouillon, theme });
    return sortir({ ok: true, fichiers: ecrire(a.sortie, r), pages: r.pages, totaux: r.totaux, avertissements: r.avertissements });
  }
  if (cmd === 'lire') {
    const r = fx.lire(fs.readFileSync(a._[1]));
    if (r.ok && !a['avec-xml']) delete r.xml;
    return sortir(r, r.ok ? 0 : 2);
  }
  if (cmd === 'emettre') {
    if (!a.registre || !a.sortie) throw new Error('--registre DOSSIER et --sortie DOSSIER obligatoires');
    const reg = await fx.ouvrirRegistre(a.registre, { serie: a.serie || 'FAC' });
    try {
      const e = await reg.emettre(lireJson(a._[1]));
      const r = fx.produire(e.facture, { theme });
      return sortir({ ok: true, numero: e.numero, deja_emise: e.deja, fichiers: ecrire(a.sortie, r), totaux: r.totaux, avertissements: r.avertissements });
    } finally { await reg.fermer(); }
  }
  if (cmd === 'lister') {
    if (!a.registre) throw new Error('--registre DOSSIER obligatoire');
    const reg = await fx.ouvrirRegistre(a.registre, { serie: a.serie || 'FAC' });
    try { return sortir(await reg.lister()); } finally { await reg.fermer(); }
  }
  process.stderr.write('commandes : catalogue, valider, produire, lire, emettre, lister (voir l en-tete de cli.js)\n');
  process.exit(1);
}

principal().catch((e) => sortir({ ok: false, code: e.code, erreur: e.message, erreurs: e.erreurs }, 2));
