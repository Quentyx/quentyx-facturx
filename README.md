# quentyx-facturx

**English** · [Français](README.fr.md)

**French e-invoices in Node.js, with zero dependencies.** I wrote this engine to produce and read
Factur-X invoices that comply with the French e-invoicing reform: a PDF/A-3 that a person can read,
with the EN 16931 XML attached for machines.

- **Produce** an invoice or a credit note as Factur-X EN 16931, PDF/A-3B.
- **Read** an incoming invoice: Factur-X, CII or UBL 2.1.
- **Validate** an invoice against EN 16931 business rules and French legal requirements before you issue it.
- **Agents**: a built-in MCP server, so an AI assistant can invoice for you (see [MCP](#mcp-server-for-ai-agents)).
- **Zero dependencies**: the PDF, the fonts, the XML and the amounts are all written by the engine itself.
- **Proven** by the official Mustang and veraPDF validators (see [Proof](#proof)).

## Install

```bash
npm install quentyx-facturx
```

Requires Node.js 18 or later.

## Produce an invoice

The API speaks French, like the reform it implements: `produire` (produce), `valider` (validate),
`lire` (read).

```js
const fs = require('fs');
const fx = require('quentyx-facturx');

const { pdf, avertissements } = fx.produire({
  numero: 'F-2026-0001',
  date_emission: '2026-11-21',
  date_echeance: '2026-12-21',
  vendeur: {
    nom: 'Mon Entreprise', siren: '123456789', tva: 'FR12123456789',
    courriel: 'factures@mon-entreprise.fr',
    adresse: { ligne1: '1 rue de la Paix', code_postal: '44000', ville: 'Nantes', pays: 'FR' },
  },
  acheteur: {
    nom: 'Client SAS', siren: '987654321',
    adresse: { ligne1: '2 avenue du Client', code_postal: '75001', ville: 'Paris', pays: 'FR' },
  },
  lignes: [{ libelle: 'Consulting', quantite: 2, prix_unitaire_ht: '450.00', tva: { categorie: 'S', taux: 20 } }],
  paiement: { moyen: 'virement', iban: 'FR7630006000011234567890189' },
  notes: [
    { code: 'PMD', texte: 'Pénalités de retard : trois fois le taux d’intérêt légal.' },
    { code: 'PMT', texte: 'Indemnité forfaitaire de recouvrement : 40 €.' },
    { code: 'AAB', texte: 'Pas d’escompte pour paiement anticipé.' },
  ],
});

fs.writeFileSync('F-2026-0001.pdf', pdf);
```

Amounts are given as numbers or strings; inside, everything is counted in whole cents. An
imprecise float is rejected, never silently rounded.

`avertissements` (warnings) lists what the reform expects but does not block production, such as
the buyer's electronic address. An **error** blocks production, and each one carries the code of
the rule it enforces (`BR-…` for EN 16931, `FR-…` for a French legal requirement).

## Read an incoming invoice

Since 1 September 2026, every French business must be able to **receive** e-invoices. `lire`
brings the three formats of the reform back to the same contract as the input: an incoming invoice
can be validated, recomputed and reproduced with the same functions.

```js
const r = fx.lire(fs.readFileSync('incoming.pdf'));   // or a CII or UBL XML file
r.facture    // the invoice, in the same shape as produire() takes
r.declares   // the amounts exactly as the issuer wrote them
r.ecarts     // what does not add up when I recompute it: [{ champ, declare, calcule }]
r.controle   // EN 16931 and French errors and warnings
r.non_lus    // the elements of the file the engine does not carry yet
```

I wanted three guarantees:

- **Nothing is silently corrected.** A wrong total stays wrong in `declares`, and the gap shows in `ecarts`.
- **Nothing is silently dropped.** Every element left unread is named in `non_lus`, by its path.
- **`lire` never throws.** An unreadable file returns `{ ok: false, code, erreur }`.

An incoming file can come from anyone: `DOCTYPE` declarations (external entities) are refused,
encrypted PDFs are refused, sizes are capped. The PDF reader also understands compressed object
streams. I tested it on files written by other software (Mustang, PDFBox, pdf-lib), and every
invoice read back is rewritten identically, byte for byte.

## Your design, my compliance

The engine imposes no visual identity. Pass your own layout with `produire(facture, { gabarit })`,
or a **theme** (colours, TrueType fonts, PNG logo) for the neutral layout. The engine then adds
the XML, the PDF/A-3 metadata and the embedded fonts, whatever your design. Examples are in
[`exemples/sortie/`](exemples/sortie/).

## Command line

```bash
npx quentyx-facturx catalogue                  # the full contract, readable by an agent
npx quentyx-facturx valider  facture.json
npx quentyx-facturx produire facture.json --sortie folder/
npx quentyx-facturx lire     incoming.pdf
```

Every command answers in JSON. `catalogue` describes every operation and every field: it is the
page to give a language model that has to use the engine.

## MCP server for AI agents

The engine ships its own MCP server, so an assistant such as Claude, Cursor or any MCP client can
produce, check and read invoices for you, from a plain sentence.

```bash
npx -y quentyx-facturx mcp
```

With Claude Code:

```bash
claude mcp add facturx -- npx -y quentyx-facturx mcp
```

With Claude Desktop, Cursor or any client that reads an `mcpServers` file:

```json
{
  "mcpServers": {
    "facturx": {
      "command": "npx",
      "args": ["-y", "quentyx-facturx", "mcp"],
      "env": { "FACTURX_DOSSIER": "/path/to/my/invoices" }
    }
  }
}
```

| Tool | What it does |
|---|---|
| `facturx_catalogue` | The full contract: fields, codes, rules |
| `facturx_valider` | Checks an invoice and computes its totals, writes nothing |
| `facturx_produire` | Writes the Factur-X PDF and its XML into the working folder |
| `facturx_lire` | Reads an incoming invoice (Factur-X, CII, UBL) and recomputes its totals |
| `facturx_xml` | Returns the EN 16931 XML only |

The server only reads and writes inside its working folder (`FACTURX_DOSSIER`, otherwise the folder
it starts in), never overwrites a file unless asked to, and refuses an invalid invoice before
writing anything. With Pro installed, three more tools appear: `facturx_emettre` (numbered in the
register), `facturx_lister` and `facturx_relire`.

I tested it with a real model: from a single sentence (seller, client, three days at €400), it
validated, produced, then reread the PDF and found no gap between the written and the recomputed
totals.

## Free and Pro

| | Free (Libre) | Pro |
|---|---|---|
| Produce, validate, read (Factur-X, CII, UBL) | ✓ | ✓ |
| MCP server for AI agents | ✓ | ✓ |
| **Register**: continuous numbering with no gaps and no duplicates, even across processes | | ✓ |
| One invoice per payment (`reference_unique`) | | ✓ |
| Audit trail of every issued invoice | | ✓ |
| Coming: EXTENDED-CTC-FR profile, connectors to certified platforms, archiving | | ✓ |
| Licence | LGPL-3.0 | commercial |
| Price | free | **€15 per month or €150 per year**, unlimited invoices, one company |

Pro plugs into the free engine without changing a line of your code: without it, a Pro operation
answers with the code `PALIER_PRO`. Pro purchases open soon.

## Proof

| What is proven | By |
|---|---|
| PDF/A-3, EN 16931 and the French BR-FR rules, on a multi-rate invoice, a VAT-exempt small business, a credit note and a custom layout | **Mustang 2.26.0 and veraPDF**, zero errors |
| Reading: Mustang converts our invoices to UBL and assembles them into Factur-X with PDFBox; the engine reads them back identically | **Mustang 2.26.0** |
| 55 regular tests, 63 with the official validators | `npm test`, `FACTURX_ORACLE=1 npm test` |

## Current limits

- Document-level allowances and charges: not supported when producing, reported when reading.
- EXTENDED and EXTENDED-CTC-FR profiles: not produced yet.
- Transmission to a certified platform: outside the engine for now.

## Contributions

I do not accept contributions: no pull requests, patches, code, feature proposals or partnership
offers. Being the sole author is what lets me offer both licences. You can report a bug in the issues,
and I fix it myself (see [`CONTRIBUTING.md`](CONTRIBUTING.md)).

## Licence

The free engine is licensed under the **GNU LGPL-3.0** ([`COPYING.LESSER`](COPYING.LESSER), which
supplements [`COPYING`](COPYING)): you can use it in closed-source software; if you modify the
engine itself and distribute it, your changes stay free. Pro is under a commercial licence.

© 2026 Anthony Renard
