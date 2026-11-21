// SPDX-License-Identifier: LGPL-3.0-only
// Copyright (C) 2026 Anthony Renard
'use strict';
/*
 * LIRE UNE FACTURE RECUE : Factur-X (PDF), CII ou UBL (XML).
 *
 * Depuis le 1er septembre 2026, toute entreprise francaise doit pouvoir RECEVOIR
 * une facture electronique. Elle arrive dans l une des trois syntaxes du socle
 * de la reforme : Factur-X, CII, UBL. `lire` les ramene toutes a UN contrat, le
 * meme que celui d entree du moteur : une facture lue se valide, se recalcule
 * et se reproduit avec les memes fonctions qu une facture emise.
 *
 * Ce que la lecture rend, en plus de la facture :
 *   - les montants DECLARES par l emetteur, tels qu ecrits ;
 *   - les ECARTS entre ces montants et ceux que le moteur recalcule : une
 *     facture dont les totaux ne tombent pas juste se signale, elle ne se
 *     corrige jamais en silence ;
 *   - le CONTROLE : erreurs et avertissements des regles EN 16931 et
 *     francaises, comme pour une facture emise ;
 *   - les elements NON LUS : ce que le fichier contient et que le moteur ne
 *     sait pas encore porter (remises de document, par exemple). Rien n est
 *     perdu sans le dire.
 *
 * `lire` ne leve jamais : un fichier illisible rend { ok: false, code, erreur }.
 */

const X = require('./xml-lecture');
const { extraireFacture } = require('./pdf/lecture');
const facture = require('./facture');
const M = require('./montants');

const { tous, un, texte, attribut } = X;

const TYPE_PAR_CODE = { 380: 'facture', 381: 'avoir' };
const MOYEN_PAR_CODE = Object.fromEntries(Object.entries(facture.MOYENS).map(([k, v]) => [v, k]));
// Identifiants d entreprise (ISO 6523) : 0002 SIREN, 0009 SIRET.
const SCHEMA_SIREN = '0002', SCHEMA_SIRET = '0009';

const date102 = (s) => (/^\d{8}$/.test(s) ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : s);

/** Retire d un objet les valeurs vides, pour une facture lue qui ne dit que ce que le fichier dit. */
function nettoyer(o) {
  if (Array.isArray(o)) return o.map(nettoyer);
  if (!o || typeof o !== 'object') return o;
  const r = {};
  for (const [k, v] of Object.entries(o)) {
    const n = nettoyer(v);
    if (n === '' || n === null || n === undefined) continue;
    if (typeof n === 'object' && !Array.isArray(n) && !Object.keys(n).length) continue;
    r[k] = n;
  }
  return r;
}

/* ─── CII, et donc Factur-X ───────────────────────────────────────────────── */

function partieCii(p, notes) {
  if (!p) return {};
  const a = un(p, 'ram:PostalTradeAddress');
  const r = {
    nom: texte(p, 'ram:Name'),
    mention_legale: texte(p, 'ram:Description'),
    adresse: {
      ligne1: texte(a, 'ram:LineOne'), ligne2: texte(a, 'ram:LineTwo'), ligne3: texte(a, 'ram:LineThree'),
      code_postal: texte(a, 'ram:PostcodeCode'), ville: texte(a, 'ram:CityName'), pays: texte(a, 'ram:CountryID'),
    },
  };
  const legal = un(p, 'ram:SpecifiedLegalOrganization/ram:ID');
  if (legal) {
    const sch = attribut(legal, 'schemeID'), v = texte(legal);
    if (sch === SCHEMA_SIRET) r.siret = v;
    else if (sch === SCHEMA_SIREN || /^\d{9}$/.test(v)) r.siren = v;
    else notes.push('identifiant legal au schema ' + (sch || 'absent') + ' : ' + v);
  }
  texte(p, 'ram:SpecifiedLegalOrganization/ram:TradingBusinessName') && (r.nom_commercial = texte(p, 'ram:SpecifiedLegalOrganization/ram:TradingBusinessName'));
  const uri = un(p, 'ram:URIUniversalCommunication/ram:URIID');
  if (uri) r.adresse_electronique = { valeur: texte(uri), schema: attribut(uri, 'schemeID') };
  const courriel = texte(p, 'ram:DefinedTradeContact/ram:EmailURIUniversalCommunication/ram:URIID');
  if (courriel) r.courriel = courriel;
  for (const t of tous(p, 'ram:SpecifiedTaxRegistration/ram:ID')) {
    if (attribut(t, 'schemeID') === 'VA') r.tva = texte(t);
    else if (attribut(t, 'schemeID') === 'FC') r.id_fiscal = texte(t);
  }
  return r;
}

function lireCii(rac) {
  const notes = [];
  const ctx = un(rac, 'rsm:ExchangedDocumentContext');
  const doc = un(rac, 'rsm:ExchangedDocument');
  const tx = un(rac, 'rsm:SupplyChainTradeTransaction');
  const acc = un(tx, 'ram:ApplicableHeaderTradeAgreement');
  const liv = un(tx, 'ram:ApplicableHeaderTradeDelivery');
  const reg = un(tx, 'ram:ApplicableHeaderTradeSettlement');
  const somme = un(reg, 'ram:SpecifiedTradeSettlementHeaderMonetarySummation');

  const type_code = texte(doc, 'ram:TypeCode');
  const d = (n, c) => date102(texte(n, c + '/udt:DateTimeString'));

  const lignes = tous(tx, 'ram:IncludedSupplyChainTradeLineItem').map((l) => {
    const prix = un(l, 'ram:SpecifiedLineTradeAgreement/ram:NetPriceProductTradePrice');
    const qte = un(l, 'ram:SpecifiedLineTradeDelivery/ram:BilledQuantity');
    const tva = un(l, 'ram:SpecifiedLineTradeSettlement/ram:ApplicableTradeTax');
    const per = un(l, 'ram:SpecifiedLineTradeSettlement/ram:BillingSpecifiedPeriod');
    texte(tva, 'ram:TypeCode');
    return {
      ligne: {
        id: texte(l, 'ram:AssociatedDocumentLineDocument/ram:LineID'),
        reference: texte(l, 'ram:SpecifiedTradeProduct/ram:SellerAssignedID'),
        libelle: texte(l, 'ram:SpecifiedTradeProduct/ram:Name'),
        description: texte(l, 'ram:SpecifiedTradeProduct/ram:Description'),
        quantite: texte(qte), unite: attribut(qte, 'unitCode'),
        prix_unitaire_ht: prixUnitaire(texte(prix, 'ram:ChargeAmount'), texte(prix, 'ram:BasisQuantity'), notes),
        tva: { categorie: texte(tva, 'ram:CategoryCode'), taux: texte(tva, 'ram:RateApplicablePercent') },
        periode: per ? { debut: d(per, 'ram:StartDateTime'), fin: d(per, 'ram:EndDateTime') } : null,
      },
      net_declare: texte(l, 'ram:SpecifiedLineTradeSettlement/ram:SpecifiedTradeSettlementLineMonetarySummation/ram:LineTotalAmount'),
    };
  });

  const exonerations = {};
  const ventilation = tous(reg, 'ram:ApplicableTradeTax').map((t) => {
    texte(t, 'ram:TypeCode');
    const cat = texte(t, 'ram:CategoryCode');
    const motif = texte(t, 'ram:ExemptionReason'), code = texte(t, 'ram:ExemptionReasonCode');
    if (motif || code) exonerations[cat] = { motif, code };
    return { categorie: cat, taux: texte(t, 'ram:RateApplicablePercent'), base: texte(t, 'ram:BasisAmount'), tva: texte(t, 'ram:CalculatedAmount') };
  });

  const moyen = un(reg, 'ram:SpecifiedTradeSettlementPaymentMeans');
  const codeMoyen = texte(moyen, 'ram:TypeCode');
  if (codeMoyen && !MOYEN_PAR_CODE[codeMoyen]) notes.push('moyen de paiement au code ' + codeMoyen + ', lu comme « autre »');
  const prec = un(reg, 'ram:InvoiceReferencedDocument');
  const per = un(reg, 'ram:BillingSpecifiedPeriod');
  const totalTva = tous(somme, 'ram:TaxTotalAmount');
  const devise = texte(reg, 'ram:InvoiceCurrencyCode');

  const entree = {
    type: TYPE_PAR_CODE[type_code] || 'facture',
    numero: texte(doc, 'ram:ID'),
    date_emission: d(doc, 'ram:IssueDateTime'),
    date_echeance: d(reg, 'ram:SpecifiedTradePaymentTerms/ram:DueDateDateTime'),
    devise,
    periode: per ? { debut: d(per, 'ram:StartDateTime'), fin: d(per, 'ram:EndDateTime') } : null,
    cadre_facturation: texte(ctx, 'ram:BusinessProcessSpecifiedDocumentContextParameter/ram:ID'),
    date_livraison: d(liv, 'ram:ActualDeliverySupplyChainEvent/ram:OccurrenceDateTime'),
    vendeur: partieCii(un(acc, 'ram:SellerTradeParty'), notes),
    acheteur: Object.assign(partieCii(un(acc, 'ram:BuyerTradeParty'), notes), { reference: texte(acc, 'ram:BuyerReference') }),
    lignes: lignes.map((l) => l.ligne),
    exonerations,
    paiement: {
      moyen: codeMoyen ? (MOYEN_PAR_CODE[codeMoyen] || 'autre') : '',
      iban: texte(moyen, 'ram:PayeePartyCreditorFinancialAccount/ram:IBANID'),
      reference: texte(reg, 'ram:PaymentReference'),
      conditions: texte(reg, 'ram:SpecifiedTradePaymentTerms/ram:Description'),
      deja_paye: texte(somme, 'ram:TotalPrepaidAmount'),
    },
    notes: tous(doc, 'ram:IncludedNote').map((n) => ({ code: texte(n, 'ram:SubjectCode'), texte: texte(n, 'ram:Content') })),
    references: {
      commande: texte(acc, 'ram:BuyerOrderReferencedDocument/ram:IssuerAssignedID'),
      contrat: texte(acc, 'ram:ContractReferencedDocument/ram:IssuerAssignedID'),
      facture_precedente: prec ? {
        numero: texte(prec, 'ram:IssuerAssignedID'),
        date: date102(texte(prec, 'ram:FormattedIssueDateTime/qdt:DateTimeString')),
      } : null,
    },
  };
  const totalTvaDevise = totalTva.find((t) => !attribut(t, 'currencyID') || attribut(t, 'currencyID') === devise) || totalTva[0];
  const declares = {
    lignes_ht: texte(somme, 'ram:LineTotalAmount'),
    remises: texte(somme, 'ram:AllowanceTotalAmount'),
    frais: texte(somme, 'ram:ChargeTotalAmount'),
    base_ht: texte(somme, 'ram:TaxBasisTotalAmount'),
    total_tva: totalTvaDevise ? texte(totalTvaDevise) : '',
    total_ttc: texte(somme, 'ram:GrandTotalAmount'),
    deja_paye: texte(somme, 'ram:TotalPrepaidAmount'),
    arrondi: texte(somme, 'ram:RoundingAmount'),
    net_a_payer: texte(somme, 'ram:DuePayableAmount'),
    ventilation,
    lignes: lignes.map((l) => ({ id: l.ligne.id, net: l.net_declare })),
  };
  return {
    syntaxe: 'CII', type_code,
    profil: texte(ctx, 'ram:GuidelineSpecifiedDocumentContextParameter/ram:ID'),
    entree, declares, notes,
  };
}

/** Prix unitaire : le prix net, divise par sa quantite de base (BT-149) s il y en a une. */
function prixUnitaire(prix, base, notes) {
  if (!base || !prix) return prix;
  try {
    const p = M.dixMilliemes(prix, 'prix'), b = M.dixMilliemes(base, 'quantite de base');
    if (b === 10000n) return prix;
    const unitaire4 = (p * 10000n) / b;
    if ((p * 10000n) % b !== 0n) notes.push('prix ' + prix + ' pour ' + base + ' unites : prix unitaire arrondi a 4 decimales');
    return M.xmlDecimal(unitaire4);
  } catch (e) {
    notes.push('prix ou quantite de base illisible : ' + e.message);
    return prix;
  }
}

/* ─── UBL 2.1, facture et avoir ───────────────────────────────────────────── */

function partieUbl(party, notes) {
  if (!party) return {};
  const a = un(party, 'cac:PostalAddress');
  const lignes3 = tous(a, 'cac:AddressLine/cbc:Line').map((x) => texte(x));
  const r = {
    nom: texte(party, 'cac:PartyLegalEntity/cbc:RegistrationName') || texte(party, 'cac:PartyName/cbc:Name'),
    mention_legale: texte(party, 'cac:PartyLegalEntity/cbc:CompanyLegalForm'),
    adresse: {
      ligne1: texte(a, 'cbc:StreetName'), ligne2: texte(a, 'cbc:AdditionalStreetName'), ligne3: lignes3[0] || '',
      code_postal: texte(a, 'cbc:PostalZone'), ville: texte(a, 'cbc:CityName'),
      pays: texte(a, 'cac:Country/cbc:IdentificationCode'),
    },
  };
  const nomCommercial = texte(party, 'cac:PartyName/cbc:Name');
  if (nomCommercial && nomCommercial !== r.nom) r.nom_commercial = nomCommercial;
  const legal = un(party, 'cac:PartyLegalEntity/cbc:CompanyID');
  if (legal) {
    const sch = attribut(legal, 'schemeID'), v = texte(legal);
    if (sch === SCHEMA_SIRET) r.siret = v;
    else if (sch === SCHEMA_SIREN || /^\d{9}$/.test(v)) r.siren = v;
    else notes.push('identifiant legal au schema ' + (sch || 'absent') + ' : ' + v);
  }
  const ep = un(party, 'cbc:EndpointID');
  if (ep) r.adresse_electronique = { valeur: texte(ep), schema: attribut(ep, 'schemeID') };
  const courriel = texte(party, 'cac:Contact/cbc:ElectronicMail');
  if (courriel) r.courriel = courriel;
  for (const t of tous(party, 'cac:PartyTaxScheme')) {
    const v = texte(t, 'cbc:CompanyID');
    if (texte(t, 'cac:TaxScheme/cbc:ID').toUpperCase() === 'VAT') r.tva = v; else r.id_fiscal = v;
  }
  return r;
}

/** Une note UBL porte son code entre dieses, par convention EN 16931 : « #PMD#texte ». */
function noteUbl(s) {
  const m = /^#([A-Z]{3})#([\s\S]*)$/.exec(s);
  return m ? { code: m[1], texte: m[2].trim() } : { code: '', texte: s };
}

function lireUbl(rac, avoir) {
  const notes = [];
  const L = avoir ? 'cac:CreditNoteLine' : 'cac:InvoiceLine';
  const Q = avoir ? 'cbc:CreditedQuantity' : 'cbc:InvoicedQuantity';
  const type_code = texte(rac, avoir ? 'cbc:CreditNoteTypeCode' : 'cbc:InvoiceTypeCode');
  const devise = texte(rac, 'cbc:DocumentCurrencyCode');
  const somme = un(rac, 'cac:LegalMonetaryTotal');

  const lignes = tous(rac, L).map((l) => {
    const q = un(l, Q);
    const cat = un(l, 'cac:Item/cac:ClassifiedTaxCategory');
    texte(cat, 'cac:TaxScheme/cbc:ID');
    const per = un(l, 'cac:InvoicePeriod');
    return {
      ligne: {
        id: texte(l, 'cbc:ID'),
        reference: texte(l, 'cac:Item/cac:SellersItemIdentification/cbc:ID'),
        libelle: texte(l, 'cac:Item/cbc:Name'),
        description: texte(l, 'cac:Item/cbc:Description'),
        quantite: texte(q), unite: attribut(q, 'unitCode'),
        prix_unitaire_ht: prixUnitaire(texte(l, 'cac:Price/cbc:PriceAmount'), texte(l, 'cac:Price/cbc:BaseQuantity'), notes),
        tva: { categorie: texte(cat, 'cbc:ID'), taux: texte(cat, 'cbc:Percent') },
        periode: per ? { debut: texte(per, 'cbc:StartDate'), fin: texte(per, 'cbc:EndDate') } : null,
      },
      net_declare: texte(l, 'cbc:LineExtensionAmount'),
    };
  });

  const exonerations = {};
  const totauxTva = tous(rac, 'cac:TaxTotal');
  const totalTva = totauxTva.map((t) => un(t, 'cbc:TaxAmount')).find((t) => t && (!attribut(t, 'currencyID') || attribut(t, 'currencyID') === devise));
  const ventilation = [];
  for (const t of totauxTva) {
    for (const st of tous(t, 'cac:TaxSubtotal')) {
      const cat = un(st, 'cac:TaxCategory');
      texte(cat, 'cac:TaxScheme/cbc:ID');
      const c = texte(cat, 'cbc:ID');
      const motif = texte(cat, 'cbc:TaxExemptionReason'), code = texte(cat, 'cbc:TaxExemptionReasonCode');
      if (motif || code) exonerations[c] = { motif, code };
      ventilation.push({ categorie: c, taux: texte(cat, 'cbc:Percent'), base: texte(st, 'cbc:TaxableAmount'), tva: texte(st, 'cbc:TaxAmount') });
    }
  }
  const moyen = un(rac, 'cac:PaymentMeans');
  const codeMoyen = texte(moyen, 'cbc:PaymentMeansCode');
  if (codeMoyen && !MOYEN_PAR_CODE[codeMoyen]) notes.push('moyen de paiement au code ' + codeMoyen + ', lu comme « autre »');
  const per = un(rac, 'cac:InvoicePeriod');
  // BT-25 : InvoiceDocumentReference selon l EN 16931 ; certains outils ecrivent CreditNoteDocumentReference.
  const prec = un(rac, 'cac:BillingReference/cac:InvoiceDocumentReference') || un(rac, 'cac:BillingReference/cac:CreditNoteDocumentReference');

  const entree = {
    type: TYPE_PAR_CODE[type_code] || (avoir ? 'avoir' : 'facture'),
    numero: texte(rac, 'cbc:ID'),
    date_emission: texte(rac, 'cbc:IssueDate'),
    date_echeance: texte(rac, 'cbc:DueDate') || texte(rac, 'cac:PaymentMeans/cbc:PaymentDueDate'),
    devise,
    periode: per ? { debut: texte(per, 'cbc:StartDate'), fin: texte(per, 'cbc:EndDate') } : null,
    cadre_facturation: texte(rac, 'cbc:ProfileID'),
    date_livraison: texte(rac, 'cac:Delivery/cbc:ActualDeliveryDate'),
    vendeur: partieUbl(un(rac, 'cac:AccountingSupplierParty/cac:Party'), notes),
    acheteur: Object.assign(partieUbl(un(rac, 'cac:AccountingCustomerParty/cac:Party'), notes), { reference: texte(rac, 'cbc:BuyerReference') }),
    lignes: lignes.map((l) => l.ligne),
    exonerations,
    paiement: {
      moyen: codeMoyen ? (MOYEN_PAR_CODE[codeMoyen] || 'autre') : '',
      iban: texte(moyen, 'cac:PayeeFinancialAccount/cbc:ID'),
      reference: texte(moyen, 'cbc:PaymentID'),
      conditions: texte(rac, 'cac:PaymentTerms/cbc:Note'),
      deja_paye: texte(somme, 'cbc:PrepaidAmount'),
    },
    notes: tous(rac, 'cbc:Note').map((n) => noteUbl(texte(n))),
    references: {
      commande: texte(rac, 'cac:OrderReference/cbc:ID'),
      contrat: texte(rac, 'cac:ContractDocumentReference/cbc:ID'),
      facture_precedente: prec ? { numero: texte(prec, 'cbc:ID'), date: texte(prec, 'cbc:IssueDate') } : null,
    },
  };
  const declares = {
    lignes_ht: texte(somme, 'cbc:LineExtensionAmount'),
    remises: texte(somme, 'cbc:AllowanceTotalAmount'),
    frais: texte(somme, 'cbc:ChargeTotalAmount'),
    base_ht: texte(somme, 'cbc:TaxExclusiveAmount'),
    total_tva: totalTva ? texte(totalTva) : '',
    total_ttc: texte(somme, 'cbc:TaxInclusiveAmount'),
    deja_paye: texte(somme, 'cbc:PrepaidAmount'),
    arrondi: texte(somme, 'cbc:PayableRoundingAmount'),
    net_a_payer: texte(somme, 'cbc:PayableAmount'),
    ventilation,
    lignes: lignes.map((l) => ({ id: l.ligne.id, net: l.net_declare })),
  };
  return { syntaxe: 'UBL', type_code, profil: texte(rac, 'cbc:CustomizationID'), entree, declares, notes };
}

/* ─── Comparaison des montants declares et recalcules ─────────────────────── */

function ecarts(declares, analyse) {
  const r = [];
  // Une regle francaise qui echoue (vendeur etranger sans SIREN) n empeche pas de recompter.
  const calculable = analyse.facture.lignes.length && analyse.facture.lignes.every((l) => l.net !== null
    && facture.CATEGORIES[l.categorie] && (l.taux !== null || l.categorie === 'O'));
  const t = analyse.totaux || (calculable ? facture.calculer(analyse.facture) : null);
  if (!t) return r;
  const comparer = (champ, declare, calcule) => {
    if (declare === '' || declare === undefined) return;
    let c;
    try { c = M.centimes(declare, champ); }
    catch (e) { r.push({ champ, declare, calcule: M.xmlMontant(calcule), message: e.message }); return; }
    if (c !== calcule) r.push({ champ, declare, calcule: M.xmlMontant(calcule) });
  };
  comparer('lignes_ht', declares.lignes_ht, t.lignes_ht);
  comparer('base_ht', declares.base_ht, t.base_ht);
  comparer('total_tva', declares.total_tva, t.total_tva);
  comparer('total_ttc', declares.total_ttc, t.total_ttc);
  comparer('net_a_payer', declares.net_a_payer, t.net_a_payer);
  analyse.facture.lignes.forEach((l, i) => {
    const d = declares.lignes[i];
    if (d && l.net !== null) comparer('ligne ' + l.id, d.net, l.net);
  });
  for (const g of declares.ventilation) {
    const calc = t.ventilation.find((v) => v.categorie === g.categorie
      && (v.taux === null ? !g.taux : g.taux !== '' && M.dixMilliemes(g.taux) === v.taux));
    if (!calc) { r.push({ champ: 'tva ' + g.categorie + ' ' + g.taux, declare: g.tva, calcule: null, message: 'groupe de TVA declare sans ligne correspondante' }); continue; }
    comparer('base ' + g.categorie + ' ' + g.taux, g.base, calc.base);
    comparer('tva ' + g.categorie + ' ' + g.taux, g.tva, calc.tva);
  }
  return r;
}

/* ─── Point d entree ──────────────────────────────────────────────────────── */

function echec(code, message) {
  return { ok: false, code, erreur: message };
}

/**
 * source : Buffer d un PDF ou d un XML, ou chaine XML.
 * Rend { ok, format, syntaxe, profil, type_code, facture, declares, ecarts, controle, non_lus, notes, pdf, xml }.
 */
function lire(source) {
  let format, pdf = null, xml;
  try {
    const octets = Buffer.isBuffer(source) ? source : (typeof source === 'string' ? Buffer.from(source, 'utf8') : null);
    if (!octets || !octets.length) return echec('LECTURE-FORMAT', 'rien a lire : attendu un Buffer ou une chaine');
    const tete = octets.subarray(0, 1024).toString('latin1');
    if (tete.indexOf('%PDF-') >= 0) {
      const x = extraireFacture(octets);
      format = 'facturx';
      pdf = { piece_jointe: x.nom, relation: x.relation, sous_type: x.sous_type, pdfa_declare: x.pdfa, profil_declare: x.profil_xmp, pieces_jointes: x.pieces_jointes };
      xml = x.xml;
    } else if (/^\s*(﻿)?\s*</.test(octets.subarray(0, 64).toString('utf8')) || (octets[0] === 0xFF && octets[1] === 0xFE)) {
      xml = octets;
    } else {
      return echec('LECTURE-FORMAT', 'ni PDF ni XML');
    }
    const rac = X.analyserXml(xml);
    let lu;
    if (rac.local === 'CrossIndustryInvoice' && rac.ns === X.NS.rsm) { lu = lireCii(rac); format = format || 'cii'; }
    else if (rac.local === 'Invoice' && rac.ns === X.NS.inv) { lu = lireUbl(rac, false); format = format || 'ubl'; }
    else if (rac.local === 'CreditNote' && rac.ns === X.NS.cn) { lu = lireUbl(rac, true); format = format || 'ubl'; }
    else return echec('LECTURE-RACINE', 'racine XML inconnue : ' + rac.local + ' (' + (rac.ns || 'sans espace de noms') + ') ; attendu CrossIndustryInvoice (CII) ou Invoice / CreditNote (UBL 2.1)');

    if (lu.type_code && !TYPE_PAR_CODE[lu.type_code]) {
      lu.notes.push('type de document ' + lu.type_code + ' lu comme « ' + lu.entree.type + ' » : le moteur ne produit que 380 et 381');
    }
    if (!lu.entree.lignes.length) lu.notes.push('aucune ligne : profil sans detail (MINIMUM ou BASIC WL), seuls les totaux declares font foi');
    if (lu.declares.remises || lu.declares.frais) lu.notes.push('remises ou frais au niveau du document : non recalcules par le moteur, les totaux peuvent s ecarter');

    const entree = nettoyer(lu.entree);
    const analyse = facture.analyser(entree);
    return {
      ok: true,
      format, syntaxe: lu.syntaxe, profil: lu.profil, type_code: lu.type_code,
      facture: entree,
      declares: nettoyer(lu.declares),
      ecarts: ecarts(lu.declares, analyse),
      controle: { ok: analyse.ok, erreurs: analyse.erreurs, avertissements: analyse.avertissements, totaux: analyse.totaux },
      non_lus: X.nonLus(rac),
      notes: lu.notes,
      pdf,
      xml: xml.toString('utf8'),
    };
  } catch (e) {
    return echec(e.code || 'LECTURE', e.message);
  }
}

module.exports = { lire };
