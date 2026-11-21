'use strict';
/*
 * Le serveur MCP (lib/mcp.js), essaye comme un assistant s en sert : un processus `cli.js mcp`,
 * des lignes JSON-RPC sur stdin, des lignes JSON-RPC sur stdout, et RIEN d autre sur stdout.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RACINE = path.join(__dirname, '..');
const CREES = [];
test.after(() => { for (const d of CREES) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); CREES.push(d); return d; };

const FACTURE = {
  numero: 'F-2026-0042', date_emission: '2026-11-21', date_echeance: '2026-12-21',
  vendeur: { nom: 'Mon Entreprise', siren: '123456789', tva: 'FR12123456789', courriel: 'factures@mon-entreprise.fr',
    adresse: { ligne1: '1 rue de la Paix', code_postal: '44000', ville: 'Nantes', pays: 'FR' } },
  acheteur: { nom: 'Client SAS', siren: '987654321', courriel: 'compta@client.fr',
    adresse: { ligne1: '2 avenue du Client', code_postal: '75001', ville: 'Paris', pays: 'FR' } },
  lignes: [{ libelle: 'Conseil', quantite: 2, prix_unitaire_ht: '450.00', tva: { categorie: 'S', taux: 20 } }],
  paiement: { moyen: 'virement', iban: 'FR7630006000011234567890189' },
  notes: [{ code: 'PMD', texte: 'Pénalités : trois fois le taux légal.' }, { code: 'PMT', texte: 'Indemnité forfaitaire : 40 €.' }],
};

// Une session : on envoie des messages, on lit les reponses par id ; stdout doit rester du JSON pur.
function session(dossier, cwd) {
  const p = spawn(process.execPath, [path.join(cwd || RACINE, 'cli.js'), 'mcp'],
    { env: Object.assign({}, process.env, { FACTURX_DOSSIER: dossier }), stdio: ['pipe', 'pipe', 'pipe'] });
  let tampon = '', id = 0;
  const attente = new Map(), lignes = [];
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (c) => {
    tampon += c; let i;
    while ((i = tampon.indexOf('\n')) >= 0) {
      const l = tampon.slice(0, i); tampon = tampon.slice(i + 1); lignes.push(l);
      const j = JSON.parse(l);   // leve si stdout porte autre chose que du JSON
      const w = attente.get(j.id); if (w) { attente.delete(j.id); w(j); }
    }
  });
  const envoyer = (method, params) => new Promise((res) => { const n = ++id; attente.set(n, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const outil = async (name, args) => {
    const j = await envoyer('tools/call', { name, arguments: args });
    assert.ok(j.result, JSON.stringify(j));
    return { erreur: j.result.isError, v: JSON.parse(j.result.content[0].text), s: j.result.structuredContent };
  };
  const fermer = () => new Promise((res) => { p.on('exit', res); p.stdin.end(); });
  return { p, envoyer, outil, fermer, lignes, notifier: (method) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n') };
}

test('initialize : version negociee, instructions, et une notification ne recoit aucune reponse', async () => {
  const s = session(tmp('fx-mcp-'));
  const i = await s.envoyer('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'essai', version: '1' } });
  assert.equal(i.result.protocolVersion, '2025-03-26');
  assert.equal(i.result.serverInfo.name, 'quentyx-facturx');
  assert.match(i.result.instructions, /facturx_catalogue/);
  s.notifier('notifications/initialized');
  assert.deepEqual((await s.envoyer('ping')).result, {});
  const inconnue = await s.envoyer('initialize', { protocolVersion: '1999-01-01' });
  assert.equal(inconnue.result.protocolVersion, '2025-06-18', 'version inconnue : la plus recente');
  assert.equal((await s.envoyer('nimporte/quoi')).error.code, -32601);
  await s.fermer();
  assert.equal(s.lignes.length, 4, 'quatre requetes, quatre reponses, rien pour la notification');
});

test('tools/list : les outils du Libre, chacun avec son schema et ses annotations', async () => {
  const s = session(tmp('fx-mcp-'));
  await s.envoyer('initialize', { protocolVersion: '2025-06-18' });
  const t = (await s.envoyer('tools/list')).result.tools;
  const noms = t.map((x) => x.name);
  for (const n of ['facturx_catalogue', 'facturx_valider', 'facturx_produire', 'facturx_lire', 'facturx_xml']) assert.ok(noms.includes(n), n);
  for (const x of t) { assert.equal(x.inputSchema.type, 'object', x.name); assert.ok(x.description.length > 40, x.name); assert.ok(x.annotations, x.name); }
  assert.equal(t.find((x) => x.name === 'facturx_lire').annotations.readOnlyHint, true);
  await s.fermer();
});

test('valider puis produire, et la facture produite se relit sans ecart', async () => {
  const d = tmp('fx-mcp-');
  const s = session(d);
  await s.envoyer('initialize', { protocolVersion: '2025-06-18' });
  const v = await s.outil('facturx_valider', { facture: FACTURE });
  assert.equal(v.v.ok, true); assert.equal(v.v.totaux.total_ttc, '108000');
  assert.deepEqual(v.s, v.v, 'structuredContent en 2025-06-18');

  const p = await s.outil('facturx_produire', { facture: FACTURE, dossier: 'sorties' });
  assert.equal(p.erreur, false, JSON.stringify(p.v));
  assert.deepEqual(p.v.fichiers, { pdf: path.join('sorties', 'F-2026-0042.pdf'), xml: path.join('sorties', 'F-2026-0042.xml') });
  assert.equal(fs.readFileSync(path.join(d, 'sorties', 'F-2026-0042.pdf')).subarray(0, 5).toString(), '%PDF-');

  const l = await s.outil('facturx_lire', { chemin: 'sorties/F-2026-0042.pdf' });
  assert.equal(l.v.ok, true); assert.equal(l.v.format, 'facturx');
  assert.deepEqual(l.v.ecarts, []); assert.equal(l.v.facture.numero, 'F-2026-0042');
  assert.equal(l.v.xml, undefined, 'le XML seulement sur demande');

  const x = await s.outil('facturx_xml', { facture: FACTURE });
  const parXml = await s.outil('facturx_lire', { xml: x.v.xml, avec_xml: true });
  assert.equal(parXml.v.format, 'cii'); assert.equal(parXml.v.xml, x.v.xml);
  const parB64 = await s.outil('facturx_lire', { base64: Buffer.from(x.v.xml).toString('base64') });
  assert.equal(parB64.v.ok, true);
  await s.fermer();
});

test('refus clairs, et rien n est ecrit', async () => {
  const d = tmp('fx-mcp-');
  const dehors = tmp('fx-dehors-');
  fs.writeFileSync(path.join(dehors, 'secret.xml'), '<x/>');
  fs.symlinkSync(dehors, path.join(d, 'lien'));
  const s = session(d);
  await s.envoyer('initialize', { protocolVersion: '2025-06-18' });

  const invalide = await s.outil('facturx_produire', { facture: Object.assign({}, FACTURE, { lignes: [] }) });
  assert.equal(invalide.erreur, true); assert.equal(invalide.v.code, 'FACTURE-INVALIDE');
  assert.ok(invalide.v.erreurs.some((e) => e.regle === 'BR-16'));
  assert.deepEqual(fs.readdirSync(d), ['lien'], 'une facture invalide n ecrit rien');

  await s.outil('facturx_produire', { facture: FACTURE });
  const encore = await s.outil('facturx_produire', { facture: FACTURE });
  assert.equal(encore.v.code, 'MCP-FICHIER-EXISTE');
  assert.equal((await s.outil('facturx_produire', { facture: FACTURE, remplacer: true })).erreur, false);

  assert.equal((await s.outil('facturx_produire', { facture: FACTURE, dossier: '../ailleurs' })).v.code, 'MCP-HORS-DOSSIER');
  assert.equal((await s.outil('facturx_lire', { chemin: path.join(dehors, 'secret.xml') })).v.code, 'MCP-HORS-DOSSIER');
  assert.equal((await s.outil('facturx_lire', { chemin: 'lien/secret.xml' })).v.code, 'MCP-HORS-DOSSIER', 'un lien ne fait pas sortir');
  assert.equal((await s.outil('facturx_lire', { chemin: 'absent.pdf' })).v.code, 'MCP-FICHIER-ABSENT');
  assert.equal((await s.outil('facturx_lire', { xml: '<a/>', base64: 'eA==' })).v.code, 'MCP-SOURCE');
  assert.equal((await s.outil('facturx_lire', { xml: '<!DOCTYPE x><x/>' })).v.code, 'LECTURE-XML-DOCTYPE');
  assert.equal((await s.envoyer('tools/call', { name: 'facturx_rien', arguments: {} })).error.code, -32602);
  await s.fermer();
});

test('sans le Pro : cinq outils, pas un de plus', async () => {
  const copie = tmp('fx-libre-seul-');
  for (const f of ['cli.js', 'evoyx.js', 'package.json']) fs.copyFileSync(path.join(RACINE, f), path.join(copie, f));
  fs.cpSync(path.join(RACINE, 'lib'), path.join(copie, 'lib'), { recursive: true });
  fs.cpSync(path.join(RACINE, 'ressources'), path.join(copie, 'ressources'), { recursive: true });
  const s = session(tmp('fx-mcp-'), copie);
  await s.envoyer('initialize', { protocolVersion: '2025-06-18' });
  const noms = (await s.envoyer('tools/list')).result.tools.map((x) => x.name);
  assert.deepEqual(noms, ['facturx_catalogue', 'facturx_valider', 'facturx_produire', 'facturx_lire', 'facturx_xml']);
  assert.equal((await s.envoyer('tools/call', { name: 'facturx_emettre', arguments: {} })).error.code, -32602);
  await s.fermer();
});

test('avec le Pro : emettre numerote sans trou, lister et relire', { skip: !fs.existsSync(path.join(RACINE, 'pro')) && 'Pro absent' }, async () => {
  const d = tmp('fx-mcp-pro-');
  const s = session(d);
  await s.envoyer('initialize', { protocolVersion: '2025-06-18' });
  const sans = Object.assign({}, FACTURE); delete sans.numero;
  const a = await s.outil('facturx_emettre', { facture: Object.assign({ reference_unique: 'pay_1' }, sans), registre: 'registre', dossier: 'factures' });
  assert.equal(a.erreur, false, JSON.stringify(a.v));
  const b = await s.outil('facturx_emettre', { facture: Object.assign({ reference_unique: 'pay_2' }, sans), registre: 'registre', dossier: 'factures' });
  assert.notEqual(a.v.numero, b.v.numero);
  const deja = await s.outil('facturx_emettre', { facture: Object.assign({ reference_unique: 'pay_1' }, sans), registre: 'registre', dossier: 'factures', remplacer: true });
  assert.equal(deja.v.deja_emise, true); assert.equal(deja.v.numero, a.v.numero);
  const l = await s.outil('facturx_lister', { registre: 'registre' });
  assert.equal(l.v.length, 2);
  const r = await s.outil('facturx_relire', { registre: 'registre', numero: b.v.numero });
  assert.equal(r.erreur, false, JSON.stringify(r.v));
  await s.fermer();
});
