'use strict';
/*
 * XML CROSS INDUSTRY INVOICE, profil Factur-X EN 16931.
 *
 * L ORDRE DES ELEMENTS N EST PAS LIBRE. Le schema CII est une suite de
 * sequences : un element juste mais mal place rend tout le fichier invalide.
 * Chaque bloc ci-dessous suit l ordre du schema, ne pas le reorganiser pour
 * le rendre plus lisible.
 *
 * Profil vise : urn:cen.eu:en16931:2017. Le profil MINIMUM n est pas cite
 * parmi les profils utilisables pour la reforme francaise (fnfe-mpe.org,
 * releve le 2026-09-22).
 */

const { el, opt, obligatoire, documentXml } = require('./xml');
const M = require('./montants');

const PROFIL_EN16931 = 'urn:cen.eu:en16931:2017';
const d102 = (iso) => iso.replace(/-/g, '');
const dateUdt = (nom, iso) => (iso ? el(nom, el('udt:DateTimeString', { format: '102' }, d102(iso))) : null);

function adresse(a) {
  return el('ram:PostalTradeAddress',
    el('ram:PostcodeCode', a.code_postal),
    el('ram:LineOne', a.ligne1),
    el('ram:LineTwo', a.ligne2),
    el('ram:LineThree', a.ligne3),
    el('ram:CityName', a.ville),
    el('ram:CountryID', a.pays));
}

function partie(nom, p) {
  return el(nom,
    el('ram:Name', p.nom),
    el('ram:Description', p.mention_legale),                        // BT-33, informations juridiques
    p.siren ? el('ram:SpecifiedLegalOrganization',
      el('ram:ID', { schemeID: '0002' }, p.siren)) : null,          // 0002 = SIREN
    adresse(p.adresse),
    p.adresse_electronique.valeur ? el('ram:URIUniversalCommunication',
      el('ram:URIID', { schemeID: p.adresse_electronique.schema }, p.adresse_electronique.valeur)) : null,
    p.tva ? el('ram:SpecifiedTaxRegistration', el('ram:ID', { schemeID: 'VA' }, p.tva)) : null,
    p.id_fiscal ? el('ram:SpecifiedTaxRegistration', el('ram:ID', { schemeID: 'FC' }, p.id_fiscal)) : null);
}

function ligne(l, devise) {
  return el('ram:IncludedSupplyChainTradeLineItem',
    el('ram:AssociatedDocumentLineDocument', el('ram:LineID', l.id)),
    el('ram:SpecifiedTradeProduct',
      el('ram:SellerAssignedID', l.reference),
      el('ram:Name', l.libelle),
      el('ram:Description', l.description)),
    el('ram:SpecifiedLineTradeAgreement',
      el('ram:NetPriceProductTradePrice', el('ram:ChargeAmount', M.xmlDecimal(l.prix)))),
    el('ram:SpecifiedLineTradeDelivery',
      el('ram:BilledQuantity', { unitCode: l.unite }, M.xmlDecimal(l.quantite))),
    el('ram:SpecifiedLineTradeSettlement',
      el('ram:ApplicableTradeTax',
        el('ram:TypeCode', 'VAT'),
        el('ram:CategoryCode', l.categorie),
        l.taux === null ? null : el('ram:RateApplicablePercent', M.xmlDecimal(l.taux))),
      l.periode && (l.periode.debut || l.periode.fin) ? el('ram:BillingSpecifiedPeriod',
        dateUdt('ram:StartDateTime', l.periode.debut),
        dateUdt('ram:EndDateTime', l.periode.fin)) : null,
      el('ram:SpecifiedTradeSettlementLineMonetarySummation',
        el('ram:LineTotalAmount', M.xmlMontant(l.net)))));
}

/** Rend le XML Factur-X d une facture deja analysee (lib/facture.js). */
function versCII(f, t) {
  const p = f.paiement;
  const racine = el('rsm:CrossIndustryInvoice', {
    'xmlns:rsm': 'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100',
    'xmlns:qdt': 'urn:un:unece:uncefact:data:standard:QualifiedDataType:100',
    'xmlns:ram': 'urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100',
    'xmlns:udt': 'urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100',
  },
  el('rsm:ExchangedDocumentContext',
    f.cadre_facturation ? el('ram:BusinessProcessSpecifiedDocumentContextParameter',
      el('ram:ID', f.cadre_facturation)) : null,
    el('ram:GuidelineSpecifiedDocumentContextParameter', el('ram:ID', PROFIL_EN16931))),

  el('rsm:ExchangedDocument',
    el('ram:ID', f.numero || 'BROUILLON'),
    el('ram:TypeCode', f.typeCode),
    dateUdt('ram:IssueDateTime', f.date_emission),
    f.notes.map((n) => el('ram:IncludedNote',
      el('ram:Content', n.texte),
      n.code ? el('ram:SubjectCode', n.code) : null))),

  el('rsm:SupplyChainTradeTransaction',
    f.lignes.map((l) => ligne(l, f.devise)),

    el('ram:ApplicableHeaderTradeAgreement',
      el('ram:BuyerReference', f.acheteur.reference),
      partie('ram:SellerTradeParty', f.vendeur),
      partie('ram:BuyerTradeParty', f.acheteur),
      f.references.commande ? el('ram:BuyerOrderReferencedDocument',
        el('ram:IssuerAssignedID', f.references.commande)) : null,
      f.references.contrat ? el('ram:ContractReferencedDocument',
        el('ram:IssuerAssignedID', f.references.contrat)) : null),

    obligatoire('ram:ApplicableHeaderTradeDelivery',
      f.date_livraison ? el('ram:ActualDeliverySupplyChainEvent',
        dateUdt('ram:OccurrenceDateTime', f.date_livraison)) : null),

    el('ram:ApplicableHeaderTradeSettlement',
      el('ram:PaymentReference', p.reference),
      el('ram:InvoiceCurrencyCode', f.devise),
      p.code ? el('ram:SpecifiedTradeSettlementPaymentMeans',
        el('ram:TypeCode', p.code),
        p.iban ? el('ram:PayeePartyCreditorFinancialAccount', el('ram:IBANID', p.iban)) : null) : null,
      t.ventilation.map((g) => el('ram:ApplicableTradeTax',
        el('ram:CalculatedAmount', M.xmlMontant(g.tva)),
        el('ram:TypeCode', 'VAT'),
        el('ram:ExemptionReason', g.motif),
        el('ram:BasisAmount', M.xmlMontant(g.base)),
        el('ram:CategoryCode', g.categorie),
        el('ram:ExemptionReasonCode', g.code),
        g.taux === null ? null : el('ram:RateApplicablePercent', M.xmlDecimal(g.taux)))),
      f.periode ? el('ram:BillingSpecifiedPeriod',
        dateUdt('ram:StartDateTime', f.periode.debut),
        dateUdt('ram:EndDateTime', f.periode.fin)) : null,
      opt('ram:SpecifiedTradePaymentTerms',
        el('ram:Description', p.conditions),
        dateUdt('ram:DueDateDateTime', f.date_echeance)),
      el('ram:SpecifiedTradeSettlementHeaderMonetarySummation',
        el('ram:LineTotalAmount', M.xmlMontant(t.lignes_ht)),
        el('ram:TaxBasisTotalAmount', M.xmlMontant(t.base_ht)),
        el('ram:TaxTotalAmount', { currencyID: f.devise }, M.xmlMontant(t.total_tva)),
        el('ram:GrandTotalAmount', M.xmlMontant(t.total_ttc)),
        t.deja_paye ? el('ram:TotalPrepaidAmount', M.xmlMontant(t.deja_paye)) : null,
        el('ram:DuePayableAmount', M.xmlMontant(t.net_a_payer))),
      f.references.facture_precedente && f.references.facture_precedente.numero
        ? el('ram:InvoiceReferencedDocument',
          el('ram:IssuerAssignedID', f.references.facture_precedente.numero),
          f.references.facture_precedente.date ? el('ram:FormattedIssueDateTime',
            el('qdt:DateTimeString', { format: '102' }, d102(f.references.facture_precedente.date))) : null)
        : null)));

  return documentXml(racine);
}

module.exports = { versCII, PROFIL_EN16931 };
