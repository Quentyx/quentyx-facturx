'use strict';
/*
 * LECTURE D UN PDF RECU : retrouver le XML joint d une facture Factur-X
 * (ou ZUGFeRD), sans dependance.
 *
 * Un PDF ecrit par un autre logiciel ne ressemble pas au notre : objets
 * compresses dans des flux d objets (PDF 1.5), mises a jour incrementales,
 * longueurs indirectes. Le lecteur ne suit donc pas la table des references :
 * il releve TOUS les objets, ceux du fichier et ceux des flux d objets, la
 * derniere definition d un numero l emportant, comme dans une mise a jour.
 *
 * Il cherche ensuite les fiches de fichier joint (/Filespec) et leur flux
 * /EmbeddedFile. Il lit aussi, s il est la, le XMP : niveau PDF/A annonce et
 * profil Factur-X annonce. Ce sont des DECLARATIONS du fichier, pas une preuve :
 * seul un validateur PDF/A prouve la conformite.
 *
 * Refuse : un PDF chiffre, un flux qui se decompresse au-dela de LIMITE_FLUX.
 */

const zlib = require('zlib');

const LIMITE_PDF = 64 * 1024 * 1024;
const LIMITE_FLUX = 64 * 1024 * 1024;
const NOMS_FACTURE = ['factur-x.xml', 'zugferd-invoice.xml', 'xrechnung.xml', 'zugferd_invoice.xml', 'order-x.xml'];

function erreur(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** Une chaine PDF litterale ( ... ) ou hexadecimale < ... >, decodee, UTF-16BE si elle porte la marque. */
function chainePdf(brut) {
  let octets;
  if (brut[0] === '<') {
    const h = brut.slice(1, -1).replace(/\s+/g, '');
    octets = Buffer.from(h.length % 2 ? h + '0' : h, 'hex');
  } else {
    const s = brut.slice(1, -1);
    const sortie = [];
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c !== '\\') { sortie.push(s.charCodeAt(i) & 0xFF); continue; }
      const d = s[++i];
      const ech = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
      if (d in ech) sortie.push(ech[d]);
      else if (/[0-7]/.test(d)) {
        let o = d;
        while (o.length < 3 && /[0-7]/.test(s[i + 1])) o += s[++i];
        sortie.push(parseInt(o, 8) & 0xFF);
      } else if (d === '\r') { if (s[i + 1] === '\n') i++; }
      else if (d !== '\n') sortie.push(s.charCodeAt(i) & 0xFF);
    }
    octets = Buffer.from(sortie);
  }
  if (octets[0] === 0xFE && octets[1] === 0xFF) {
    const be = Buffer.from(octets.subarray(2, 2 + ((octets.length - 2) & ~1)));
    return be.swap16().toString('utf16le');
  }
  return octets.toString('latin1');
}

/** Le dictionnaire de tete d un objet : de << jusqu au >> qui l equilibre. */
function dictionnaire(s, debut) {
  const i = s.indexOf('<<', debut);
  if (i < 0) return null;
  let profondeur = 0;
  for (let j = i; j < s.length - 1; j++) {
    if (s[j] === '(') {                                   // une chaine peut contenir << ou >>
      let k = j + 1, niv = 1;
      while (k < s.length && niv) { if (s[k] === '\\') k++; else if (s[k] === '(') niv++; else if (s[k] === ')') niv--; k++; }
      j = k - 1; continue;
    }
    if (s[j] === '<' && s[j + 1] === '<') { profondeur++; j++; continue; }
    if (s[j] === '>' && s[j + 1] === '>') { profondeur--; j++; if (!profondeur) return { texte: s.slice(i, j + 1), fin: j + 1 }; }
  }
  return null;
}

const ref = (dict, cle) => {
  const m = new RegExp('/' + cle + '\\s+(\\d+)\\s+\\d+\\s+R').exec(dict);
  return m ? +m[1] : null;
};
const entier = (dict, cle) => {
  const m = new RegExp('/' + cle + '\\s+(\\d+)(?!\\s+\\d+\\s+R)').exec(dict);
  return m ? +m[1] : null;
};

function decompresser(dict, donnees) {
  const filtres = (/\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict) || [])[1] || '';
  const liste = filtres.match(/\/\w+/g) || [];
  let d = donnees;
  for (const f of liste) {
    if (f === '/FlateDecode' || f === '/Fl') {
      try { d = zlib.inflateSync(d, { maxOutputLength: LIMITE_FLUX }); }
      catch (e) {
        if (e.code === 'ERR_BUFFER_TOO_LARGE' || /larger than/i.test(e.message)) throw erreur('LECTURE-TAILLE', 'flux PDF trop grand une fois decompresse');
        d = zlib.inflateSync(d, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: LIMITE_FLUX });
      }
      if (/\/Predictor\s+(1[0-5]|2)\b/.test(dict)) return null;   // jamais pour un fichier joint ; on ne devine pas
    } else if (f === '/ASCIIHexDecode' || f === '/AHx') {
      d = Buffer.from(d.toString('latin1').replace(/[\s>].*$/s, '').replace(/\s+/g, ''), 'hex');
    } else {
      return null;                                                   // filtre inconnu : flux ignore, pas devine
    }
  }
  return d;
}

/** Releve tous les objets : { numero -> { dict, flux (Buffer brut ou null), texte } }. */
function releverObjets(pdf) {
  const s = pdf.toString('latin1');
  const objets = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  const enAttente = [];
  while ((m = re.exec(s))) {
    const numero = +m[1];
    const debut = m.index + m[0].length;
    const finObj = s.indexOf('endobj', debut);
    const corps = s.slice(debut, finObj < 0 ? s.length : finObj);
    const d = corps.trimStart().startsWith('<<') ? dictionnaire(s, debut) : null;
    const o = { numero, dict: d ? d.texte : corps.trim(), flux: null };
    if (d) {
      const apres = s.slice(d.fin, d.fin + 20);
      const sm = /^\s*stream(\r\n|\n|\r)/.exec(apres);
      if (sm) {
        const depart = d.fin + sm[0].length;
        enAttente.push({ o, depart });
        const fin = s.indexOf('endstream', depart);
        if (fin > 0) re.lastIndex = fin;
      }
    }
    objets.set(numero, o);
  }
  // Les longueurs indirectes se resolvent une fois tous les objets releves.
  for (const { o, depart } of enAttente) {
    let longueur = entier(o.dict, 'Length');
    const r = ref(o.dict, 'Length');
    if (longueur === null && r !== null && objets.has(r)) longueur = parseInt(objets.get(r).dict, 10);
    let fin;
    if (Number.isFinite(longueur) && /^\s*endstream/.test(s.slice(depart + longueur, depart + longueur + 20))) fin = depart + longueur;
    else {
      fin = s.indexOf('endstream', depart);
      if (fin < 0) continue;
      if (s[fin - 1] === '\n') fin--;
      if (s[fin - 1] === '\r') fin--;
    }
    o.flux = pdf.subarray(depart, fin);
  }
  // Les flux d objets : leurs objets s ajoutent, sauf si le fichier en redefinit un plus loin.
  for (const o of [...objets.values()]) {
    if (!o.flux || !/\/Type\s*\/ObjStm/.test(o.dict)) continue;
    const d = decompresser(o.dict, o.flux);
    if (!d) continue;
    const t = d.toString('latin1');
    const nb = entier(o.dict, 'N'), premier = entier(o.dict, 'First');
    if (nb === null || premier === null) continue;
    const entete = t.slice(0, premier).trim().split(/\s+/).map(Number);
    for (let k = 0; k < nb; k++) {
      const num = entete[2 * k], dep = premier + entete[2 * k + 1];
      const finO = k + 1 < nb ? premier + entete[2 * k + 3] : t.length;
      if (!objets.has(num) || objets.get(num).depuisFlux) {
        objets.set(num, { numero: num, dict: t.slice(dep, finO).trim(), flux: null, depuisFlux: true });
      }
    }
  }
  return { objets, texte: s };
}

const RACINE_FACTURE = /<(?:[\w.-]+:)?(CrossIndustryInvoice|Invoice|CreditNote)[\s>]/;

/**
 * Extrait d un PDF le XML de facture joint.
 * Rend { xml: Buffer, nom, relation, sous_type, pdfa, profil_xmp, pieces_jointes[] }.
 */
function extraireFacture(pdf) {
  if (!Buffer.isBuffer(pdf)) throw erreur('LECTURE-FORMAT', 'un PDF se lit depuis un Buffer');
  if (pdf.length > LIMITE_PDF) throw erreur('LECTURE-TAILLE', 'PDF de plus de ' + (LIMITE_PDF >> 20) + ' Mo');
  if (pdf.indexOf('%PDF-') !== 0 && pdf.indexOf('%PDF-') > 1024) throw erreur('LECTURE-FORMAT', 'ce fichier n est pas un PDF');
  const { objets, texte } = releverObjets(pdf);
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(texte) || /\/Encrypt\s*<</.test(texte)) {
    throw erreur('LECTURE-PDF-CHIFFRE', 'PDF chiffre : une facture Factur-X ne doit pas l etre (PDF/A l interdit)');
  }
  const flux = (numero) => {
    const o = objets.get(numero);
    return o && o.flux ? decompresser(o.dict, o.flux) : null;
  };

  // Les fiches de fichier joint, ou qu elles soient.
  const pieces = [];
  for (const o of objets.values()) {
    if (!/\/Type\s*\/Filespec/.test(o.dict) && !/\/EF\s*(<<|\d+\s+\d+\s+R)/.test(o.dict)) continue;
    // /EF est un dictionnaire en ligne, ou une reference vers lui (PDFBox, par exemple).
    let ef = (/\/EF\s*<<([^>]*)>>/.exec(o.dict) || [])[1];
    const efRef = ref(o.dict, 'EF');
    if (ef === undefined && efRef !== null && objets.has(efRef)) ef = objets.get(efRef).dict;
    if (ef === undefined) continue;
    const cible = ref(ef, 'UF') || ref(ef, 'F');
    const nomBrut = /\/UF\s*(\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>)/.exec(o.dict) || /\/F\s*(\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>)/.exec(o.dict);
    const fichier = objets.get(cible);
    pieces.push({
      nom: nomBrut ? chainePdf(nomBrut[1]) : '',
      relation: ((/\/AFRelationship\s*\/(\w+)/.exec(o.dict) || [])[1]) || '',
      sous_type: fichier ? (((/\/Subtype\s*\/([^\s/<>\[\]]+)/.exec(fichier.dict) || [])[1]) || '').replace(/#2F/gi, '/') : '',
      cible,
    });
  }

  // La piece de facture : par son nom d abord, sinon le premier XML joint dont la racine est une facture.
  let choisie = null, xml = null;
  const essayer = (p) => {
    const d = p.cible !== null ? flux(p.cible) : null;
    if (d && RACINE_FACTURE.test(d.subarray(0, 4096).toString('utf8'))) { choisie = p; xml = d; return true; }
    return false;
  };
  for (const nom of NOMS_FACTURE) {
    const p = pieces.find((x) => x.nom.toLowerCase() === nom);
    if (p && essayer(p)) break;
  }
  if (!choisie) for (const p of pieces) if (essayer(p)) break;
  if (!choisie) {
    throw erreur('LECTURE-PDF-SANS-XML', pieces.length
      ? 'PDF sans XML de facture joint (pieces jointes : ' + pieces.map((p) => p.nom || '?').join(', ') + ')'
      : 'PDF sans piece jointe : ce n est pas une facture Factur-X, seulement une image de facture');
  }

  // Le XMP : ce que le fichier DECLARE de lui-meme.
  let pdfa = null, profil_xmp = null;
  for (const o of objets.values()) {
    if (!o.flux || !/\/Type\s*\/Metadata/.test(o.dict)) continue;
    const d = decompresser(o.dict, o.flux);
    if (!d) continue;
    const x = d.toString('utf8');
    const part = /pdfaid:part(?:="|>)\s*(\d)/.exec(x);
    const conf = /pdfaid:conformance(?:="|>)\s*([ABU])/i.exec(x);
    if (part) pdfa = part[1] + (conf ? conf[1].toUpperCase() : '');
    const niveau = /(?:fx|zf|\w+):ConformanceLevel(?:="|>)\s*([^"<]+)/.exec(x);
    if (niveau) profil_xmp = niveau[1].trim();
    if (pdfa) break;
  }

  return {
    xml, nom: choisie.nom, relation: choisie.relation, sous_type: choisie.sous_type, pdfa, profil_xmp,
    pieces_jointes: pieces.map((p) => ({ nom: p.nom, relation: p.relation, sous_type: p.sous_type })),
  };
}

module.exports = { extraireFacture, chainePdf, LIMITE_PDF };
