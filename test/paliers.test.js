'use strict';
// LA COUTURE LIBRE / PRO, prouvee : le Libre tient seul, le Pro se branche, le paquet publie
// n emporte jamais le Pro. Voir lib/paliers.js.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const racine = path.join(__dirname, '..');

function enfant(code, env) {
  const out = execFileSync(process.execPath, ['-e', code], { cwd: racine, env: Object.assign({}, process.env, env || {}), encoding: 'utf8' });
  return JSON.parse(out);
}

const SONDE = `
  const fx = require('./evoyx');
  const { base } = require('./test/_facture');
  const p = fx.produire(base());
  const fin = (code, plateforme) => {
    const charges = Object.keys(require.cache);
    console.log(JSON.stringify({
      pdf: p.pdf.length > 1000, xml: p.xml.includes(fx.CATALOGUE.norme.profil), lu: fx.lire(p.pdf).ok,
      pro: fx.CATALOGUE.paliers.pro.present, disponible: fx.CATALOGUE.operations['registre.emettre'].disponible,
      code, plateforme, journal: charges.some((f) => f.includes('quentyx-journal')),
      dossierPro: charges.some((f) => f.includes('/pro/')),
    }));
  };
  const d = require('os').tmpdir() + '/fx-sonde-' + process.pid;
  const nettoyer = () => require('fs').rmSync(d, { recursive: true, force: true });
  const pf = (code) => fx.ouvrirPlateforme({ environnement: 'bac_a_sable', client_id: 'a', client_secret: 'b' })
    .then((x) => fin(code, typeof x.envoyer === 'function' ? 'ouvert' : 'incomplet'), (e) => fin(code, e.code));
  fx.ouvrirRegistre(d).then((r) => r.fermer().then(() => { nettoyer(); pf('ouvert'); }), (e) => { nettoyer(); pf(e.code); });
`;

test('le Libre tient seul : il produit une facture sans le Pro ni quentyx-journal', () => {
  const r = enfant(SONDE, { QUENTYX_FACTURX_LIBRE: '1' });
  assert.deepStrictEqual(r, { pdf: true, xml: true, lu: true, pro: false, disponible: false, code: 'PALIER_PRO', plateforme: 'PALIER_PRO', journal: false, dossierPro: false });
});

test('le Pro se branche par la couture, sans changer le contrat', () => {
  const r = enfant(SONDE);
  assert.deepStrictEqual(r, { pdf: true, xml: true, lu: true, pro: true, disponible: true, code: 'ouvert', plateforme: 'ouvert', journal: true, dossierPro: true });
});

test('le paquet publie n emporte jamais le Pro', () => {
  const sortie = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: racine, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const fichiers = JSON.parse(sortie)[0].files.map((f) => f.path);
  assert.ok(fichiers.includes('evoyx.js') && fichiers.includes('lib/paliers.js') && fichiers.includes('lib/pdf/document.js'), fichiers.join(' '));
  assert.deepStrictEqual(fichiers.filter((f) => f.startsWith('pro/') || f.includes('registre')), []);
});

test('le Libre ne reference aucun fichier du Pro, hors de la couture', () => {
  const fautifs = [];
  const parcourir = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((x) => {
    const f = path.join(d, x.name);
    if (x.isDirectory()) return parcourir(f);
    if (f.endsWith('.js') && f !== path.join(racine, 'lib', 'paliers.js') && /require\([^)]*pro/.test(fs.readFileSync(f, 'utf8'))) fautifs.push(f);
  });
  ['lib'].forEach((d) => parcourir(path.join(racine, d)));
  ['evoyx.js', 'cli.js'].forEach((f) => { if (/require\([^)]*pro/.test(fs.readFileSync(path.join(racine, f), 'utf8'))) fautifs.push(f); });
  assert.deepStrictEqual(fautifs, []);
});
