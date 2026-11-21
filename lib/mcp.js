// SPDX-License-Identifier: LGPL-3.0-only
// Copyright (C) 2026 Anthony Renard
'use strict';
/*
 * LE SERVEUR MCP DE QUENTYX-FACTURX. Zero dependance, transport stdio.
 *
 *   npx -y quentyx-facturx mcp
 *
 * Un assistant (Claude, ChatGPT, Cursor...) y trouve les fonctions du Libre : valider, produire,
 * lire une facture recue, rendre le XML. Si le Pro est installe, les outils du registre s y ajoutent.
 *
 * LE DOSSIER DE TRAVAIL. Le serveur ne lit et n ecrit que sous un seul dossier : FACTURX_DOSSIER,
 * ou a defaut le dossier ou il a ete lance. Un chemin qui en sort (`..`, chemin absolu ailleurs,
 * lien symbolique) est refuse. C est un garde-fou, pas une prison : FACTURX_DOSSIER=/ le leve.
 * Un fichier existant n est jamais ecrase sans `remplacer: true`.
 *
 * stdout ne porte QUE des messages JSON-RPC, un par ligne : tout le reste part sur stderr.
 */
const fs = require('fs');
const path = require('path');
const fx = require('../evoyx');

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LIMITE_LECTURE = 64 * 1024 * 1024;

class Refus extends Error {
  constructor(code, message, correction, erreurs) {
    super(message); this.code = code; this.correction = correction; this.erreurs = erreurs;
  }
}

// ── Le dossier de travail ────────────────────────────────────────────────
function racine(env) {
  const r = path.resolve((env && env.FACTURX_DOSSIER) || process.cwd());
  try { return fs.realpathSync(r); } catch (_) { return r; }
}
function sousRacine(R, abs) {
  const rel = path.relative(R, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function chemin(R, p, quoi) {
  if (typeof p !== 'string' || !p.trim()) throw new Refus('MCP-CHEMIN', quoi + ' manquant', 'donner un chemin relatif au dossier de travail ' + R);
  const abs = path.resolve(R, p);
  if (!sousRacine(R, abs)) {
    throw new Refus('MCP-HORS-DOSSIER', quoi + ' hors du dossier de travail : ' + p,
      'rester sous ' + R + ' (reglable par la variable FACTURX_DOSSIER au lancement du serveur)');
  }
  return abs;
}
// Un lien symbolique ne fait pas sortir du dossier : on compare le chemin REEL.
function reel(R, abs, quoi) {
  let r;
  try { r = fs.realpathSync(abs); } catch (_) { return abs; }
  if (!sousRacine(R, r)) throw new Refus('MCP-HORS-DOSSIER', quoi + ' mene hors du dossier de travail par un lien', 'rester sous ' + R);
  return r;
}
function lireFichier(R, p, quoi) {
  const abs = reel(R, chemin(R, p, quoi), quoi);
  let st;
  try { st = fs.statSync(abs); } catch (_) { throw new Refus('MCP-FICHIER-ABSENT', quoi + ' introuvable : ' + p, 'verifier le chemin, relatif a ' + R); }
  if (!st.isFile()) throw new Refus('MCP-PAS-UN-FICHIER', quoi + ' n est pas un fichier : ' + p);
  if (st.size > LIMITE_LECTURE) throw new Refus('LECTURE-TAILLE', quoi + ' depasse 64 Mo');
  return fs.readFileSync(abs);
}
function dossierEcriture(R, p) {
  const abs = chemin(R, p === undefined ? '.' : p, 'dossier');
  fs.mkdirSync(abs, { recursive: true });
  return reel(R, abs, 'dossier');
}
function ecrireSansEcraser(fichiers, remplacer) {
  if (!remplacer) {
    const deja = fichiers.filter(([f]) => fs.existsSync(f));
    if (deja.length) throw new Refus('MCP-FICHIER-EXISTE', 'deja present : ' + deja.map(([f]) => path.basename(f)).join(', '),
      'passer remplacer: true pour ecraser, ou choisir un autre dossier');
  }
  for (const [f, octets] of fichiers) fs.writeFileSync(f, octets);
}

// ── Le contrat d une facture, en JSON Schema ─────────────────────────────
const montant = (description) => ({ type: ['number', 'string'], description });
const date = (description) => ({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: description + ' (YYYY-MM-DD)' });
const PARTIE = {
  type: 'object',
  properties: {
    nom: { type: 'string', description: 'Legal name.' },
    siren: { type: 'string', description: 'French SIREN, 9 digits (mandatory for a French seller).' },
    siret: { type: 'string', description: 'French SIRET, 14 digits.' },
    tva: { type: 'string', description: 'VAT number, e.g. FR12123456789.' },
    id_fiscal: { type: 'string', description: 'Tax registration identifier (BT-32, schemeID FC). A seller without a VAT number (French VAT franchise, category E) puts its SIREN here: the norm then accepts the invoice (BR-E-02).' },
    mention_legale: { type: 'string', description: 'Legal form mention, e.g. "EI" for a French sole trader.' },
    courriel: { type: 'string', description: 'E-mail, also used as electronic address by default.' },
    reference: { type: 'string', description: 'Buyer reference (BT-10), buyer only.' },
    adresse_electronique: { type: 'object', properties: { valeur: { type: 'string' }, schema: { type: 'string', description: 'EAS code, EM for e-mail, 0225 for the French directory.' } } },
    adresse: {
      type: 'object',
      properties: {
        ligne1: { type: 'string' }, ligne2: { type: 'string' }, ligne3: { type: 'string' },
        code_postal: { type: 'string' }, ville: { type: 'string' },
        pays: { type: 'string', description: 'ISO 3166-1 alpha-2, FR by default.' },
      },
      required: ['ligne1', 'code_postal', 'ville'],
    },
  },
  required: ['nom', 'adresse'],
};
const SCHEMA_FACTURE = {
  type: 'object',
  description: 'A French e-invoice, EN 16931. Field names are French, like the reform. Amounts are numbers or strings with ' +
    'at most 2 decimals (4 for a unit price, quantity or rate); an imprecise float is rejected, never rounded.',
  properties: {
    type: { type: 'string', enum: ['facture', 'avoir'], description: 'facture = invoice (default), avoir = credit note.' },
    numero: { type: 'string', description: 'Invoice number. Mandatory unless brouillon (draft).' },
    date_emission: date('Issue date'),
    date_echeance: date('Due date, mandatory when an amount is due without payment terms'),
    date_livraison: date('Delivery date'),
    devise: { type: 'string', description: 'ISO 4217, EUR by default.' },
    periode: { type: 'object', properties: { debut: date('Start'), fin: date('End') }, description: 'Billing period.' },
    cadre_facturation: { type: 'string', enum: ['B1', 'S1', 'M1', 'B2', 'S2', 'M2', 'S3', 'B4', 'S4', 'M4', 'S5', 'S6', 'B7', 'S7', 'B8', 'S8', 'M8', 'B9', 'S9', 'M9'],
      description: 'BT-23, French reform billing framework, required by certified platforms (BR-FR-08). Letter: B goods, S services, M mixed. Most common: S1, B1 or M1 (a plain invoice); 2 means already paid (S2 for a service paid by card).' },
    reference_unique: { type: 'string', description: 'External id (payment, order): one invoice per reference in a registry.' },
    vendeur: Object.assign({ description: 'Seller.' }, PARTIE),
    acheteur: Object.assign({ description: 'Buyer.' }, PARTIE),
    lignes: {
      type: 'array', minItems: 1, description: 'Invoice lines.',
      items: {
        type: 'object',
        properties: {
          libelle: { type: 'string', description: 'Item name.' },
          description: { type: 'string' },
          reference: { type: 'string' },
          quantite: montant('Quantity, 1 by default.'),
          unite: { type: 'string', description: 'UN/ECE Rec 20 unit code, C62 (unit) by default; HUR = hour, DAY = day.' },
          prix_unitaire_ht: montant('Unit price excluding VAT.'),
          tva: {
            type: 'object',
            properties: {
              categorie: { type: 'string', enum: ['S', 'Z', 'E', 'AE', 'K', 'G', 'O'], description: 'S standard, Z zero, E exempt, AE reverse charge, K intra-EU, G export, O out of scope.' },
              taux: montant('VAT rate in percent, e.g. 20.'),
            },
            required: ['categorie'],
          },
          periode: { type: 'object', properties: { debut: date('Start'), fin: date('End') } },
        },
        required: ['libelle', 'prix_unitaire_ht', 'tva'],
      },
    },
    exonerations: {
      type: 'object', description: 'Exemption reason per VAT category, mandatory for E, AE, K, G, O. French VAT franchise: ' +
        '{ "E": { "motif": "TVA non applicable, art. 293 B du CGI" } }, with the SIREN also set as vendeur.id_fiscal.',
      additionalProperties: { type: 'object', properties: { motif: { type: 'string' }, code: { type: 'string' } } },
    },
    paiement: {
      type: 'object',
      properties: {
        moyen: { type: 'string', enum: ['carte', 'virement', 'virement_sepa', 'prelevement', 'especes', 'cheque', 'autre'] },
        deja_paye: montant('Amount already paid.'),
        conditions: { type: 'string', description: 'Payment terms.' },
        iban: { type: 'string' },
        reference: { type: 'string' },
      },
    },
    notes: {
      type: 'array', description: 'Notes with UNTDID 4451 code. A French B2B invoice needs PMD (late payment penalties) and PMT (40 EUR recovery fee); AAB = early payment discount.',
      items: { type: 'object', properties: { code: { type: 'string' }, texte: { type: 'string' } }, required: ['texte'] },
    },
    references: {
      type: 'object',
      properties: {
        commande: { type: 'string', description: 'Purchase order.' },
        contrat: { type: 'string' },
        facture_precedente: { type: 'object', properties: { numero: { type: 'string' }, date: date('Date') }, description: 'Mandatory for a credit note.' },
      },
    },
  },
  required: ['date_emission', 'vendeur', 'acheteur', 'lignes'],
};
const THEME = {
  type: 'object', description: 'Optional look for the neutral template: hex colours, TrueType fonts and an 8-bit PNG logo (paths under the working folder).',
  properties: {
    accent: { type: 'string' }, texte: { type: 'string' }, doux: { type: 'string' }, filet: { type: 'string' }, fond: { type: 'string' },
    police: { type: 'string' }, policeGras: { type: 'string' }, logo: { type: 'string' },
  },
  additionalProperties: false,
};

// ── Les outils ───────────────────────────────────────────────────────────
const LECTURE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const ECRITURE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
// La plateforme agreee : le reseau, et des gestes qui ne se reprennent pas (une facture transmise est emise).
const RESEAU_LECTURE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const RESEAU_TRANSMISSION = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

const OUTILS_LIBRE = [
  {
    name: 'facturx_catalogue', title: 'What this engine does',
    description: 'Returns what quentyx-facturx can do: standard (Factur-X 1.0, EN 16931, PDF/A-3B), every operation, the invoice contract ' +
      'field by field, limits, whether the Pro tier is installed, and the working folder. Read it once before a first invoice.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: LECTURE,
  },
  {
    name: 'facturx_valider', title: 'Check an invoice',
    description: 'Checks an invoice against EN 16931 (BR-...) and French legal rules (FR-...) and computes its totals. Writes nothing. ' +
      'An error blocks production; a warning is for the user to decide. Each one carries the rule code.',
    inputSchema: { type: 'object', properties: { facture: SCHEMA_FACTURE, brouillon: { type: 'boolean', description: 'Draft: the number may be missing.' } }, required: ['facture'], additionalProperties: false },
    annotations: LECTURE,
  },
  {
    name: 'facturx_produire', title: 'Produce an invoice (PDF/A-3 + XML)',
    description: 'Produces a Factur-X invoice: a PDF/A-3 readable by a person with its EN 16931 XML attached, plus the XML alone. Writes ' +
      '<numero>.pdf and <numero>.xml into `dossier` (relative to the working folder), never overwriting an existing file unless ' +
      'remplacer is true. Refuses an invalid invoice with the list of errors.',
    inputSchema: {
      type: 'object',
      properties: {
        facture: SCHEMA_FACTURE,
        dossier: { type: 'string', description: 'Output folder, relative to the working folder. Default: the working folder itself.' },
        brouillon: { type: 'boolean', description: 'Draft: no number needed, marked "Document sans valeur de facture".' },
        theme: THEME,
        remplacer: { type: 'boolean', description: 'Overwrite existing files. Default false.' },
      },
      required: ['facture'], additionalProperties: false,
    },
    annotations: ECRITURE,
  },
  {
    name: 'facturx_lire', title: 'Read an incoming invoice',
    description: 'Reads a received invoice: Factur-X or ZUGFeRD PDF, CII XML or UBL 2.1 XML (invoice or credit note). Returns the invoice ' +
      'in the SAME shape facturx_produire takes, the amounts as declared by the issuer, `ecarts` (what does not add up when ' +
      'recomputed), the EN 16931 and French check, and `non_lus` (elements present but not read). Give exactly one of chemin ' +
      '(a file under the working folder), xml (the XML text) or base64 (the file content).',
    inputSchema: {
      type: 'object',
      properties: {
        chemin: { type: 'string', description: 'Path of a .pdf or .xml file, relative to the working folder.' },
        xml: { type: 'string', description: 'The XML text itself.' },
        base64: { type: 'string', description: 'The file content in base64.' },
        avec_xml: { type: 'boolean', description: 'Also return the embedded XML text. Default false.' },
      },
      additionalProperties: false,
    },
    annotations: LECTURE,
  },
  {
    name: 'facturx_xml', title: 'Invoice XML only',
    description: 'Returns the Factur-X CII XML (EN 16931) of an invoice as text, without producing a PDF or writing anything.',
    inputSchema: { type: 'object', properties: { facture: SCHEMA_FACTURE }, required: ['facture'], additionalProperties: false },
    annotations: LECTURE,
  },
];

const REGISTRE = { type: 'string', description: 'Registry folder, relative to the working folder. One registry per seller.' };
const SERIE = { type: 'string', description: 'Number series, FAC by default (e.g. AV for credit notes).' };
const OUTILS_PRO = [
  {
    name: 'facturx_emettre', title: 'Issue an invoice from the registry (Pro)',
    description: 'Pro tier. Gives the invoice the next number of its series, with no gap and no duplicate, records it in the registry ' +
      '(audit trail), then writes its PDF/A-3 and XML into `dossier`. Pass the invoice WITHOUT numero. With reference_unique, issuing ' +
      'twice the same reference returns the invoice already issued instead of a new number.',
    inputSchema: {
      type: 'object',
      properties: { facture: SCHEMA_FACTURE, registre: REGISTRE, serie: SERIE, dossier: { type: 'string', description: 'Output folder for the files.' }, theme: THEME, remplacer: { type: 'boolean' } },
      required: ['facture', 'registre'], additionalProperties: false,
    },
    annotations: ECRITURE,
  },
  {
    name: 'facturx_lister', title: 'List issued invoices (Pro)',
    description: 'Pro tier. Lists the invoices issued in a registry series: number, date, reference, total.',
    inputSchema: { type: 'object', properties: { registre: REGISTRE, serie: SERIE }, required: ['registre'], additionalProperties: false },
    annotations: LECTURE,
  },
  {
    name: 'facturx_relire', title: 'Read back an issued invoice (Pro)',
    description: 'Pro tier. Returns an issued invoice exactly as recorded in the registry.',
    inputSchema: { type: 'object', properties: { registre: REGISTRE, serie: SERIE, numero: { type: 'string' } }, required: ['registre', 'numero'], additionalProperties: false },
    annotations: LECTURE,
  },
];

const ID_PLATEFORME = { type: 'integer', description: 'Invoice id on the platform (from facturx_plateforme_factures or facturx_plateforme_envoyer).' };
const SOURCE_FACTURE = {
  facture: SCHEMA_FACTURE,
  chemin: { type: 'string', description: 'Or an existing Factur-X PDF / CII / UBL file, relative to the working folder.' },
};
const OUTILS_PLATEFORME = [
  {
    name: 'facturx_plateforme_compte', title: 'Certified platform account (Pro)',
    description: 'Pro tier. The account the configured credentials open on the certified platform (Super PDP): environment ' +
      '(bac_a_sable = sandbox, or production), company, KYB status, and its electronic addresses. Call it first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RESEAU_LECTURE,
  },
  {
    name: 'facturx_plateforme_annuaire', title: 'French e-invoicing directory (Pro)',
    description: 'Pro tier. Looks up a company in the national e-invoicing directory: with `siren`, whether it can receive ' +
      'e-invoices and its electronic address (put it in acheteur.adresse_electronique); with `nom` and/or `code_postal`, a search.',
    inputSchema: { type: 'object', properties: { siren: { type: 'string' }, nom: { type: 'string' }, code_postal: { type: 'string' }, limite: { type: 'integer' } }, additionalProperties: false },
    annotations: RESEAU_LECTURE,
  },
  {
    name: 'facturx_plateforme_controler', title: 'Check an invoice with the platform, without sending (Pro)',
    description: 'Pro tier. Runs the certified platform validator on an invoice (object or file) WITHOUT transmitting it, plus the ' +
      'local reading. Use it before facturx_plateforme_envoyer when unsure.',
    inputSchema: { type: 'object', properties: SOURCE_FACTURE, additionalProperties: false },
    annotations: RESEAU_LECTURE,
  },
  {
    name: 'facturx_plateforme_envoyer', title: 'Send an invoice through the certified platform (Pro)',
    description: 'Pro tier. TRANSMITS the invoice to the client through the certified platform: in production this is the legal ' +
      'issuance and cannot be undone. Before calling, show the user the number, the client, the total and the environment, and get ' +
      'an explicit yes. Give `facture` (produced, then sent; files also written to `dossier` if given) or `chemin`. Refused, with ' +
      'nothing sent, if the invoice is not compliant, if cadre_facturation (BT-23) is missing, or if the declared environment differs ' +
      'from the account. Then follow it with facturx_plateforme_suivi.',
    inputSchema: {
      type: 'object',
      properties: Object.assign({}, SOURCE_FACTURE, {
        reference: { type: 'string', description: 'Your own id for this invoice, 1 to 36 characters.' },
        regle: { type: 'string', enum: ['B2B', 'B2BInt', 'B2C'], description: 'Processing rule, computed by the platform if omitted.' },
        dossier: { type: 'string', description: 'Folder for the produced PDF and XML, when `facture` is given.' },
        remplacer: { type: 'boolean' },
      }),
      additionalProperties: false,
    },
    annotations: RESEAU_TRANSMISSION,
  },
  {
    name: 'facturx_plateforme_factures', title: 'List invoices on the platform (Pro)',
    description: 'Pro tier. Invoices sent (`emises`) or received (`recues`) on the certified platform, with number, parties, totals ' +
      'and current lifecycle state. Page with `apres` (the `dernier` id of the previous page).',
    inputSchema: { type: 'object', properties: {
      sens: { type: 'string', enum: ['emises', 'recues'] }, mois: { type: 'string', description: 'AAAA-MM' },
      apres: { type: 'integer' }, limite: { type: 'integer' }, ordre: { type: 'string', enum: ['asc', 'desc'] } }, additionalProperties: false },
    annotations: RESEAU_LECTURE,
  },
  {
    name: 'facturx_plateforme_lire', title: 'Read an invoice from the platform (Pro)',
    description: 'Pro tier. Downloads an invoice from the platform (Factur-X by default, converted by the platform if it arrived as ' +
      'XML) and reads it with the engine: same contract as facturx_lire, with `ecarts` and control. Report them to the user. With ' +
      '`dossier`, also writes the file there.',
    inputSchema: { type: 'object', properties: { id: ID_PLATEFORME, format: { type: 'string', enum: ['factur-x', 'cii', 'ubl', 'original'] },
      dossier: { type: 'string' }, remplacer: { type: 'boolean' } }, required: ['id'], additionalProperties: false },
    annotations: RESEAU_LECTURE,
  },
  {
    name: 'facturx_plateforme_suivi', title: 'Lifecycle of an invoice (Pro)',
    description: 'Pro tier. Every lifecycle event of an invoice on the platform (deposee, emise, recue, mise_a_disposition, ' +
      'approuvee, refusee, encaissee...) and the current state. A rejection carries its reasons in `details`.',
    inputSchema: { type: 'object', properties: { id: ID_PLATEFORME }, required: ['id'], additionalProperties: false },
    annotations: RESEAU_LECTURE,
  },
  {
    name: 'facturx_plateforme_statuer', title: 'Set the status of a received invoice (Pro)',
    description: 'Pro tier. TRANSMITS a lifecycle status on an invoice: as recipient prise_en_charge, approuvee, ' +
      'approuvee_partiellement, en_litige, suspendue, refusee, paiement_transmis; as issuer encaissee (payment received). ' +
      'It reaches the other party and, for some statuses, the tax administration: get the user\'s explicit yes first. ' +
      '`motif` is the reason code of AFNOR XP Z12-012, `note` free text, `montant` for a partial amount.',
    inputSchema: { type: 'object', properties: { id: ID_PLATEFORME,
      statut: { type: 'string', enum: ['prise_en_charge', 'approuvee', 'approuvee_partiellement', 'en_litige', 'suspendue', 'completee', 'refusee', 'paiement_transmis', 'encaissee', 'annulee'] },
      motif: { type: 'string' }, note: { type: 'string' }, montant: { type: ['number', 'string'] } }, required: ['id', 'statut'], additionalProperties: false },
    annotations: RESEAU_TRANSMISSION,
  },
  {
    name: 'facturx_plateforme_ereporting', title: 'E-reporting (Pro)',
    description: 'Pro tier. E-reporting to the tax administration through the platform. `apercu` previews a period (date, type ' +
      'transaction or paiement, role vendeur or acheteur); `lister` and `lire` show what was sent; `declarer` TRANSMITS data ' +
      '(type b2c_transactions, b2c_paiements, b2bint_factures, b2bint_paiements; `donnees` in the platform\'s own fields): get ' +
      'the user\'s explicit yes first.',
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['apercu', 'lister', 'lire', 'declarer'] }, date: { type: 'string' },
      type: { type: 'string', enum: ['transaction', 'paiement', 'b2c_transactions', 'b2c_paiements', 'b2bint_factures', 'b2bint_paiements'] },
      role: { type: 'string', enum: ['vendeur', 'acheteur'] }, id: { type: 'integer' }, donnees: { type: 'array', items: { type: 'object' } } },
      required: ['action'], additionalProperties: false },
    annotations: RESEAU_TRANSMISSION,
  },
];

const proPresent = () => !!(fx.CATALOGUE.paliers && fx.CATALOGUE.paliers.pro && fx.CATALOGUE.paliers.pro.present);
function outils() { return proPresent() ? OUTILS_LIBRE.concat(OUTILS_PRO, OUTILS_PLATEFORME) : OUTILS_LIBRE.slice(); }

// Une seule connexion a la plateforme par serveur, ouverte au premier usage (identifiants : FACTURX_SUPERPDP_*).
let plateformeOuverte = null;
function plateforme() {
  if (!plateformeOuverte) plateformeOuverte = fx.ouvrirPlateforme().catch((e) => { plateformeOuverte = null; throw e; });
  return plateformeOuverte;
}
function sourceFacture(R, a) {
  const n = ['facture', 'chemin'].filter((k) => a[k] !== undefined && a[k] !== null && a[k] !== '');
  if (n.length !== 1) throw new Refus('MCP-SOURCE', 'donner exactement une source : facture ou chemin');
  if (a.facture !== undefined) { verifierFacture(a.facture); return a.facture; }
  return lireFichier(R, a.chemin, 'chemin');
}

function themeDe(R, t) {
  if (!t) return undefined;
  const r = {};
  for (const k of ['accent', 'texte', 'doux', 'filet', 'fond']) if (t[k] !== undefined) r[k] = String(t[k]);
  for (const k of ['police', 'policeGras', 'logo']) if (t[k] !== undefined) r[k] = reel(R, chemin(R, t[k], 'theme.' + k), 'theme.' + k);
  return r;
}
function verifierFacture(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) throw new Refus('MCP-FACTURE', 'facture manquante ou mal formee', 'passer un objet facture, voir facturx_catalogue');
}
function produireEtEcrire(R, a, facture) {
  let r;
  try { r = fx.produire(facture, { brouillon: !!a.brouillon, theme: themeDe(R, a.theme) }); }
  catch (e) {
    if (e.erreurs) throw new Refus('FACTURE-INVALIDE', 'facture invalide, rien n a ete ecrit', 'corriger les erreurs, chacune porte le code de sa regle', e.erreurs);
    throw e;
  }
  const d = dossierEcriture(R, a.dossier);
  const pdf = path.join(d, r.nom_fichier + '.pdf'), xml = path.join(d, r.nom_fichier + '.xml');
  ecrireSansEcraser([[pdf, r.pdf], [xml, r.xml]], !!a.remplacer);
  return { r, fichiers: { pdf: path.relative(R, pdf), xml: path.relative(R, xml) } };
}
async function avecRegistre(R, a, f) {
  const reg = await fx.ouvrirRegistre(chemin(R, a.registre, 'registre'), { serie: a.serie || 'FAC' });
  try { return await f(reg); } finally { await reg.fermer(); }
}

async function appeler(R, nom, a) {
  a = a || {};
  switch (nom) {
    case 'facturx_catalogue':
      return Object.assign({}, fx.CATALOGUE, { dossier_de_travail: R });
    case 'facturx_valider': {
      verifierFacture(a.facture);
      const r = fx.valider(a.facture, { brouillon: !!a.brouillon });
      return { ok: r.ok, totaux: r.totaux, erreurs: r.erreurs, avertissements: r.avertissements };
    }
    case 'facturx_produire': {
      verifierFacture(a.facture);
      const { r, fichiers } = produireEtEcrire(R, a, a.facture);
      return { ok: true, fichiers, pages: r.pages, totaux: r.totaux, avertissements: r.avertissements };
    }
    case 'facturx_xml': {
      verifierFacture(a.facture);
      const v = fx.valider(a.facture);
      if (!v.ok) throw new Refus('FACTURE-INVALIDE', 'facture invalide', 'corriger les erreurs', v.erreurs);
      return { ok: true, xml: fx.versXml(a.facture), avertissements: v.avertissements };
    }
    case 'facturx_lire': {
      const sources = ['chemin', 'xml', 'base64'].filter((k) => a[k] !== undefined && a[k] !== null && a[k] !== '');
      if (sources.length !== 1) throw new Refus('MCP-SOURCE', 'donner exactement une source parmi chemin, xml, base64 (recu : ' + (sources.join(', ') || 'aucune') + ')');
      let octets;
      if (a.chemin !== undefined && a.chemin !== '') octets = lireFichier(R, a.chemin, 'chemin');
      else if (a.xml) octets = Buffer.from(String(a.xml), 'utf8');
      else octets = Buffer.from(String(a.base64), 'base64');
      const r = fx.lire(octets);
      if (!r.ok) throw new Refus(r.code, r.erreur);
      if (!a.avec_xml) delete r.xml;
      return r;
    }
    case 'facturx_emettre': {
      verifierFacture(a.facture);
      return avecRegistre(R, a, async (reg) => {
        const e = await reg.emettre(a.facture);
        const { r, fichiers } = produireEtEcrire(R, a, e.facture);
        return { ok: true, numero: e.numero, deja_emise: !!e.deja, fichiers, totaux: r.totaux, avertissements: r.avertissements };
      });
    }
    case 'facturx_lister':
      return avecRegistre(R, a, (reg) => reg.lister());
    case 'facturx_relire':
      return avecRegistre(R, a, (reg) => reg.relire(String(a.numero || '')));
    case 'facturx_plateforme_compte': {
      const p = await plateforme();
      return Object.assign({}, await p.compte({ relire: true }), { adresses: await p.adresses() });
    }
    case 'facturx_plateforme_annuaire': {
      const p = await plateforme();
      if (a.siren) return p.annuaire(a.siren);
      if (!a.nom && !a.code_postal) throw new Refus('MCP-ANNUAIRE', 'donner siren, ou nom et/ou code_postal');
      return { entreprises: await p.entreprises({ nom: a.nom, code_postal: a.code_postal, limite: a.limite }) };
    }
    case 'facturx_plateforme_controler': {
      const p = await plateforme();
      return p.controler(sourceFacture(R, a));
    }
    case 'facturx_plateforme_envoyer': {
      const src = sourceFacture(R, a);
      // Les fichiers locaux sont verifies AVANT l envoi : une fois transmise, la facture est emise.
      let cibles = null;
      if (a.dossier !== undefined && !Buffer.isBuffer(src)) {
        const d = dossierEcriture(R, a.dossier);
        const base = String(src.numero || 'brouillon').replace(/[^A-Za-z0-9._-]/g, '_');
        cibles = [path.join(d, base + '.pdf'), path.join(d, base + '.xml')];
        if (!a.remplacer) for (const c of cibles) if (fs.existsSync(c)) throw new Refus('MCP-FICHIER-EXISTE', 'fichier deja present : ' + path.relative(R, c) + ', rien n est envoye', 'passer remplacer: true ou un autre dossier');
      }
      const p = await plateforme();
      const r = await p.envoyer(src, { reference: a.reference, regle: a.regle });
      let fichiers = null;
      if (cibles && r.fichier) {
        ecrireSansEcraser([[cibles[0], r.fichier.pdf], [cibles[1], r.fichier.xml]], true);
        fichiers = { pdf: path.relative(R, cibles[0]), xml: path.relative(R, cibles[1]) };
      }
      return { ok: true, environnement: p.environnement, facture: r.facture, avertissements: r.avertissements, fichiers };
    }
    case 'facturx_plateforme_factures': {
      const p = await plateforme();
      return p.factures({ sens: a.sens, mois: a.mois, apres: a.apres, limite: a.limite, ordre: a.ordre });
    }
    case 'facturx_plateforme_lire': {
      const p = await plateforme();
      const r = await p.lire(a.id, { format: a.format });
      let fichier = null;
      if (a.dossier !== undefined) {
        const d = dossierEcriture(R, a.dossier);
        const ext = /pdf/.test(r.type) ? '.pdf' : /xml/.test(r.type) ? '.xml' : '.bin';
        const nom = path.join(d, String(r.facture.numero || ('plateforme-' + a.id)).replace(/[^A-Za-z0-9._-]/g, '_') + ext);
        ecrireSansEcraser([[nom, r.fichier]], !!a.remplacer);
        fichier = path.relative(R, nom);
      }
      const lecture = r.lecture || {};
      delete lecture.xml;
      return { facture: r.facture, fichier, lecture };
    }
    case 'facturx_plateforme_suivi': {
      const p = await plateforme();
      return p.evenements(a.id);
    }
    case 'facturx_plateforme_statuer': {
      const p = await plateforme();
      return { ok: true, environnement: p.environnement, evenement: await p.statuer(a.id, a.statut, { motif: a.motif, note: a.note, montant: a.montant }) };
    }
    case 'facturx_plateforme_ereporting': {
      const p = await plateforme();
      if (a.action === 'apercu') return p.ereporting.apercu({ date: a.date, type: a.type === 'paiement' ? 'paiement' : 'transaction', role: a.role });
      if (a.action === 'lister') return p.ereporting.lister({ role: a.role });
      if (a.action === 'lire') return p.ereporting.lire(a.id);
      if (a.action === 'declarer') return p.ereporting.declarer(a.type, a.donnees);
      throw new Refus('MCP-ACTION', 'action : apercu, lister, lire ou declarer');
    }
    default:
      return undefined;
  }
}

// ── Le protocole ─────────────────────────────────────────────────────────
const INSTRUCTIONS =
  'quentyx-facturx produces, checks and reads French e-invoices (Factur-X 1.0, EN 16931, PDF/A-3B), locally, with no network. ' +
  'Field names are French. Call facturx_catalogue first for the invoice contract. Check with facturx_valider, then produce with ' +
  'facturx_produire. Read a received invoice with facturx_lire: report its `ecarts` and errors to the user, never correct them silently. ' +
  'Files are read and written only under the working folder given by facturx_catalogue. ' +
  'With Pro, facturx_plateforme_* talk to the certified platform: facturx_plateforme_envoyer, facturx_plateforme_statuer and ' +
  'e-reporting declarations TRANSMIT and cannot be undone; never call them without the user\'s explicit yes.';

function creerServeur(options) {
  const o = options || {};
  const R = racine(o.env || process.env);
  let version = VERSIONS[0];
  const reponse = (id, result) => ({ jsonrpc: '2.0', id, result });
  const erreur = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  async function un(m) {
    if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
      return m && m.id !== undefined ? erreur(m.id, -32600, 'requete invalide') : null;
    }
    const notif = m.id === undefined || m.id === null;
    if (notif) return null;
    const p = m.params || {};
    switch (m.method) {
      case 'initialize':
        version = VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : VERSIONS[0];
        return reponse(m.id, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'quentyx-facturx', title: 'Quentyx Factur-X', version: fx.VERSION },
          instructions: INSTRUCTIONS,
        });
      case 'ping': return reponse(m.id, {});
      case 'tools/list': return reponse(m.id, { tools: outils() });
      case 'tools/call': {
        const nom = p.name;
        if (!outils().some((t) => t.name === nom)) return erreur(m.id, -32602, 'outil inconnu : ' + nom);
        try {
          const v = fx.versJson(await appeler(R, nom, p.arguments));
          const r = { content: [{ type: 'text', text: JSON.stringify(v, null, 2) }], isError: false };
          if (version >= '2025-06-18' && v && typeof v === 'object' && !Array.isArray(v)) r.structuredContent = v;
          return reponse(m.id, r);
        } catch (e) {
          const corps = { ok: false, code: e.code || 'ERREUR', erreur: e.message };
          if (e.correction) corps.correction = e.correction;
          if (e.erreurs) corps.erreurs = fx.versJson(e.erreurs);
          if (e.ecarts) corps.ecarts = fx.versJson(e.ecarts);
          if (e.http) corps.http = e.http;
          return reponse(m.id, { content: [{ type: 'text', text: JSON.stringify(corps, null, 2) }], isError: true });
        }
      }
      default: return erreur(m.id, -32601, 'methode inconnue : ' + m.method);
    }
  }

  async function traiter(ligne) {
    let m;
    try { m = JSON.parse(ligne); } catch (_) { return erreur(null, -32700, 'JSON invalide'); }
    if (Array.isArray(m)) {
      const r = (await Promise.all(m.map(un))).filter(Boolean);
      return r.length ? r : null;
    }
    return un(m);
  }
  return { traiter, racine: R };
}

function demarrer(options) {
  const o = options || {};
  const entree = o.entree || process.stdin, sortie = o.sortie || process.stdout;
  const s = creerServeur(o);
  let tampon = '', file = Promise.resolve();
  entree.setEncoding('utf8');
  entree.on('data', (morceau) => {
    tampon += morceau;
    let i;
    while ((i = tampon.indexOf('\n')) >= 0) {
      const ligne = tampon.slice(0, i).trim();
      tampon = tampon.slice(i + 1);
      if (!ligne) continue;
      // Les reponses partent dans l ordre des requetes.
      file = file.then(() => s.traiter(ligne)).then((r) => { if (r) sortie.write(JSON.stringify(r) + '\n'); })
        .catch((e) => process.stderr.write('quentyx-facturx mcp : ' + (e && e.stack || e) + '\n'));
    }
  });
  return new Promise((res) => entree.on('end', () => file.then(res)));
}

module.exports = { creerServeur, demarrer, OUTILS_LIBRE, OUTILS_PRO, OUTILS_PLATEFORME, SCHEMA_FACTURE, VERSIONS };
