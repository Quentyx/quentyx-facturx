'use strict';
/*
 * ECRIVAIN PDF/A-3, sans dependance.
 *
 * Ce que PDF/A-3 exige, et que bien des generateurs oublient :
 *   - toutes les polices embarquees (ici en sous-ensemble, voir ttf.js) ;
 *   - un profil de couleur de sortie (OutputIntent sRGB) ;
 *   - des metadonnees XMP qui declarent la norme, et les memes valeurs que
 *     le dictionnaire Info s il existe ;
 *   - chaque piece jointe decrite : type MIME, date, et sa RELATION au
 *     document (AFRelationship), referencee depuis le catalogue (/AF) ;
 *   - un identifiant de fichier dans la remorque, des flux de longueur exacte.
 *
 * Pour Factur-X, la piece jointe s appelle factur-x.xml et le XMP porte en plus
 * le schema d extension fx (type, nom du fichier, version, niveau de conformite).
 */

const zlib = require('zlib');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Police } = require('./ttf');
const { decoderPng } = require('./png');

const RESSOURCES = path.join(__dirname, '..', '..', 'ressources');
const f2 = (n) => (Math.round(n * 100) / 100).toString();

/** Chaine PDF : litterale si ASCII imprimable, sinon UTF-16BE avec BOM en hexadecimal. */
function chainePdf(s) {
  s = String(s);
  if (/^[\x20-\x7E]*$/.test(s)) return '(' + s.replace(/([\\()])/g, '\\$1') + ')';
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0');
  return '<' + hex.toUpperCase() + '>';
}

function nomPdf(s) {
  return '/' + String(s).replace(/[^A-Za-z0-9._-]/g, (c) => '#' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

const echapperXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function dates(d) {
  const iso = d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const pdf = 'D:' + iso.replace(/[-:T]/g, '').replace('Z', 'Z');
  return { iso, pdf };
}

function couleur(c) {
  const h = String(c || '#000000').replace('#', '');
  const v = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return v.map((x) => f2(x)).join(' ');
}

class Page {
  constructor(doc, largeur, hauteur) {
    this.doc = doc; this.largeur = largeur; this.hauteur = hauteur;
    this.ops = []; this.polices = new Set(); this.images = new Set();
  }
  texte(x, y, s, police, taille, c) {
    if (s === null || s === undefined || s === '') return;
    this.polices.add(police);
    this.ops.push('BT ' + nomPdf(police.ressource) + ' ' + f2(taille) + ' Tf ' + couleur(c) + ' rg 1 0 0 1 '
      + f2(x) + ' ' + f2(y) + ' Tm <' + police.police.encoder(s) + '> Tj ET');
  }
  rectangle(x, y, l, h, o) {
    o = o || {};
    const ops = ['q'];
    if (o.remplir) ops.push(couleur(o.remplir) + ' rg');
    if (o.trait) ops.push(couleur(o.trait) + ' RG ' + f2(o.epaisseur || 0.5) + ' w');
    ops.push(f2(x) + ' ' + f2(y) + ' ' + f2(l) + ' ' + f2(h) + ' re ' + (o.remplir && o.trait ? 'B' : o.remplir ? 'f' : 'S'), 'Q');
    this.ops.push(ops.join(' '));
  }
  ligne(x1, y1, x2, y2, c, epaisseur) {
    this.ops.push('q ' + couleur(c) + ' RG ' + f2(epaisseur || 0.5) + ' w ' + f2(x1) + ' ' + f2(y1) + ' m ' + f2(x2) + ' ' + f2(y2) + ' l S Q');
  }
  image(img, x, y, l, h) {
    this.images.add(img);
    this.ops.push('q ' + f2(l) + ' 0 0 ' + f2(h) + ' ' + f2(x) + ' ' + f2(y) + ' cm ' + nomPdf(img.ressource) + ' Do Q');
  }
}

class DocumentPdf {
  /**
   * infos : { titre, auteur, sujet, createur, date, langue }
   */
  constructor(infos) {
    this.infos = Object.assign({ createur: 'Quentyx Factur-X', langue: 'fr-FR', date: new Date() }, infos || {});
    this.pages = []; this.polices = []; this.images = []; this.pieces = [];
    this.facturx = null;
  }

  police(chemin) {
    const cle = path.resolve(chemin);
    let p = this.polices.find((x) => x.chemin === cle);
    if (!p) {
      p = { chemin: cle, police: new Police(fs.readFileSync(cle), path.basename(cle)), ressource: 'F' + (this.polices.length + 1) };
      this.polices.push(p);
    }
    return p;
  }

  image(png) {
    const img = Object.assign(decoderPng(Buffer.isBuffer(png) ? png : fs.readFileSync(png)), { ressource: 'Im' + (this.images.length + 1) });
    this.images.push(img);
    return img;
  }

  nouvellePage(largeur, hauteur) {
    const p = new Page(this, largeur || 595.28, hauteur || 841.89);
    this.pages.push(p);
    return p;
  }

  /** relation : Data, Source, Alternative, Supplement ou Unspecified (PDF/A-3, 6.8). */
  joindre(nom, contenu, o) {
    o = o || {};
    this.pieces.push({ nom, contenu: Buffer.from(contenu), mime: o.mime || 'application/octet-stream',
      description: o.description || nom, relation: o.relation || 'Data' });
  }

  /** Declare le document comme Factur-X : le XMP portera le schema d extension fx. */
  declarerFacturx(niveau, nomFichier) {
    this.facturx = { niveau, nomFichier: nomFichier || 'factur-x.xml' };
  }

  xmp(d) {
    const i = this.infos;
    const desc = (ns, corps) => '  <rdf:Description rdf:about="" ' + ns + '>\n' + corps + '\n  </rdf:Description>';
    const blocs = [
      desc('xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"',
        '   <pdfaid:part>3</pdfaid:part>\n   <pdfaid:conformance>B</pdfaid:conformance>'),
      desc('xmlns:dc="http://purl.org/dc/elements/1.1/"',
        '   <dc:format>application/pdf</dc:format>\n'
        + (i.titre ? '   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">' + echapperXml(i.titre) + '</rdf:li></rdf:Alt></dc:title>\n' : '')
        + (i.auteur ? '   <dc:creator><rdf:Seq><rdf:li>' + echapperXml(i.auteur) + '</rdf:li></rdf:Seq></dc:creator>\n' : '')
        + (i.sujet ? '   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">' + echapperXml(i.sujet) + '</rdf:li></rdf:Alt></dc:description>' : '')),
      desc('xmlns:xmp="http://ns.adobe.com/xap/1.0/"',
        '   <xmp:CreatorTool>' + echapperXml(i.createur) + '</xmp:CreatorTool>\n'
        + '   <xmp:CreateDate>' + d.iso + '</xmp:CreateDate>\n   <xmp:ModifyDate>' + d.iso + '</xmp:ModifyDate>'),
      desc('xmlns:pdf="http://ns.adobe.com/pdf/1.3/"',
        '   <pdf:Producer>' + echapperXml(i.createur) + '</pdf:Producer>'),
    ];
    if (this.facturx) {
      const fx = 'urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#';
      const prop = (nom, description) => '         <rdf:li rdf:parseType="Resource">\n'
        + '          <pdfaProperty:name>' + nom + '</pdfaProperty:name>\n'
        + '          <pdfaProperty:valueType>Text</pdfaProperty:valueType>\n'
        + '          <pdfaProperty:category>external</pdfaProperty:category>\n'
        + '          <pdfaProperty:description>' + description + '</pdfaProperty:description>\n'
        + '         </rdf:li>';
      blocs.push(desc('xmlns:fx="' + fx + '"',
        '   <fx:DocumentType>INVOICE</fx:DocumentType>\n'
        + '   <fx:DocumentFileName>' + this.facturx.nomFichier + '</fx:DocumentFileName>\n'
        + '   <fx:Version>1.0</fx:Version>\n'
        + '   <fx:ConformanceLevel>' + this.facturx.niveau + '</fx:ConformanceLevel>'));
      blocs.push(desc('xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#"',
        '   <pdfaExtension:schemas>\n    <rdf:Bag>\n     <rdf:li rdf:parseType="Resource">\n'
        + '      <pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>\n'
        + '      <pdfaSchema:namespaceURI>' + fx + '</pdfaSchema:namespaceURI>\n'
        + '      <pdfaSchema:prefix>fx</pdfaSchema:prefix>\n'
        + '      <pdfaSchema:property>\n       <rdf:Seq>\n'
        + [prop('DocumentFileName', 'The name of the embedded XML document'),
          prop('DocumentType', 'The type of the hybrid document in capital letters, e.g. INVOICE or ORDER'),
          prop('Version', 'The actual version of the standard applying to the embedded XML document'),
          prop('ConformanceLevel', 'The conformance level of the embedded XML document')].join('\n')
        + '\n       </rdf:Seq>\n      </pdfaSchema:property>\n     </rdf:li>\n    </rdf:Bag>\n   </pdfaExtension:schemas>'));
    }
    const bom = String.fromCharCode(0xFEFF);
    return '<?xpacket begin="' + bom + '" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
      + '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
      + blocs.join('\n') + '\n </rdf:RDF>\n</x:xmpmeta>\n' + ' '.repeat(2000) + '\n<?xpacket end="w"?>';
  }

  enOctets() {
    if (!this.pages.length) throw new Error('document sans page');
    const d = dates(this.infos.date);
    const objets = [];
    const reserver = () => { objets.push(null); return objets.length; };
    const definir = (n, contenu) => { objets[n - 1] = Buffer.isBuffer(contenu) ? contenu : Buffer.from(contenu, 'latin1'); };
    const ajouter = (contenu) => { const n = reserver(); definir(n, contenu); return n; };
    const flux = (dict, donnees, compresser) => {
      const brut = Buffer.isBuffer(donnees) ? donnees : Buffer.from(donnees, 'latin1');
      const corps = compresser === false ? brut : zlib.deflateSync(brut, { level: 9 });
      return Buffer.concat([Buffer.from('<< ' + dict + (compresser === false ? '' : ' /Filter /FlateDecode') + ' /Length ' + corps.length + ' >>\nstream\n', 'latin1'),
        corps, Buffer.from('\nendstream', 'latin1')]);
    };

    const nCatalogue = reserver();
    const nPages = reserver();

    // Polices : sous-ensemble, descripteur, police CID, table ToUnicode, police Type0.
    for (const p of this.polices) {
      const pol = p.police;
      const garder = [...pol.glyphesGardes()].sort((a, b) => a - b);
      const etiquette = crypto.createHash('md5').update(garder.join(',') + pol.nomPostScript).digest()
        .subarray(0, 6).reduce((s, o) => s + String.fromCharCode(65 + (o % 26)), '');
      const nomBase = etiquette + '+' + pol.nomPostScript;
      const echelle = (v) => Math.round(v * 1000 / pol.unitsPerEm);
      const programme = pol.sousEnsemble();
      const nFichier = ajouter(flux('/Length1 ' + programme.length, programme));
      const drapeaux = 32 + (pol.italique ? 64 : 0) + (pol.chasseFixe ? 1 : 0);
      const nDescripteur = ajouter('<< /Type /FontDescriptor /FontName ' + nomPdf(nomBase) + ' /Flags ' + drapeaux
        + ' /FontBBox [' + pol.bbox.map(echelle).join(' ') + '] /ItalicAngle ' + f2(pol.italique)
        + ' /Ascent ' + echelle(pol.ascender) + ' /Descent ' + echelle(pol.descender)
        + ' /CapHeight ' + echelle(pol.capHeight) + ' /StemV ' + (pol.poids >= 600 ? 140 : 80)
        + ' /FontFile2 ' + nFichier + ' 0 R >>');
      const largeurs = garder.map((g) => g + ' [' + echelle(pol.avance(g)) + ']').join(' ');
      const nCid = ajouter('<< /Type /Font /Subtype /CIDFontType2 /BaseFont ' + nomPdf(nomBase)
        + ' /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>'
        + ' /FontDescriptor ' + nDescripteur + ' 0 R /DW ' + echelle(pol.avance(0)) + ' /W [' + largeurs + '] /CIDToGIDMap /Identity >>');
      const utf16 = (s) => { let h = ''; for (let i = 0; i < s.length; i++) h += s.charCodeAt(i).toString(16).padStart(4, '0'); return h.toUpperCase(); };
      const paires = [...pol.utilises.entries()].sort((a, b) => a[0] - b[0]);
      let cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n'
        + '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n'
        + '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
      for (let i = 0; i < paires.length; i += 100) {
        const lot = paires.slice(i, i + 100);
        cmap += lot.length + ' beginbfchar\n' + lot.map(([g, s]) => '<' + g.toString(16).padStart(4, '0').toUpperCase() + '> <' + utf16(s) + '>').join('\n') + '\nendbfchar\n';
      }
      cmap += 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend';
      const nToUnicode = ajouter(flux('', cmap));
      p.numero = ajouter('<< /Type /Font /Subtype /Type0 /BaseFont ' + nomPdf(nomBase) + ' /Encoding /Identity-H'
        + ' /DescendantFonts [' + nCid + ' 0 R] /ToUnicode ' + nToUnicode + ' 0 R >>');
    }

    // Images : couleur, et masque d alpha a part.
    for (const img of this.images) {
      const espace = img.canaux === 1 ? '/DeviceGray' : '/DeviceRGB';
      let masque = '';
      if (img.alpha) {
        const nMasque = ajouter(flux('/Type /XObject /Subtype /Image /Width ' + img.largeur + ' /Height ' + img.hauteur
          + ' /ColorSpace /DeviceGray /BitsPerComponent 8', img.alpha));
        masque = ' /SMask ' + nMasque + ' 0 R';
      }
      img.numero = ajouter(flux('/Type /XObject /Subtype /Image /Width ' + img.largeur + ' /Height ' + img.hauteur
        + ' /ColorSpace ' + espace + ' /BitsPerComponent 8' + masque, img.couleurs));
    }

    // Pages.
    const nPagesListe = [];
    const transparence = this.images.some((i) => i.alpha);
    for (const page of this.pages) {
      const nContenu = ajouter(flux('', page.ops.join('\n')));
      const polices = [...page.polices].map((p) => nomPdf(p.ressource) + ' ' + p.numero + ' 0 R').join(' ');
      const images = [...page.images].map((i) => nomPdf(i.ressource) + ' ' + i.numero + ' 0 R').join(' ');
      nPagesListe.push(ajouter('<< /Type /Page /Parent ' + nPages + ' 0 R /MediaBox [0 0 ' + f2(page.largeur) + ' ' + f2(page.hauteur) + ']'
        + ' /Resources << ' + (polices ? '/Font << ' + polices + ' >> ' : '') + (images ? '/XObject << ' + images + ' >> ' : '') + '>>'
        + (transparence ? ' /Group << /S /Transparency /CS /DeviceRGB >>' : '')
        + ' /Contents ' + nContenu + ' 0 R >>'));
    }
    definir(nPages, '<< /Type /Pages /Kids [' + nPagesListe.map((n) => n + ' 0 R').join(' ') + '] /Count ' + nPagesListe.length + ' >>');

    // Pieces jointes (PDF/A-3, 6.8).
    const specs = [];
    for (const pj of this.pieces) {
      const sousType = nomPdf(pj.mime);
      const nFichier = ajouter(flux('/Type /EmbeddedFile /Subtype ' + sousType
        + ' /Params << /ModDate (' + d.pdf + ') /Size ' + pj.contenu.length
        + ' /CheckSum <' + crypto.createHash('md5').update(pj.contenu).digest('hex').toUpperCase() + '> >>', pj.contenu));
      specs.push({ nom: pj.nom, numero: ajouter('<< /Type /Filespec /F ' + chainePdf(pj.nom) + ' /UF ' + chainePdf(pj.nom)
        + ' /Desc ' + chainePdf(pj.description) + ' /AFRelationship /' + pj.relation
        + ' /EF << /F ' + nFichier + ' 0 R /UF ' + nFichier + ' 0 R >> >>') });
    }

    const icc = fs.readFileSync(path.join(RESSOURCES, 'sRGB.icc'));
    const nIcc = ajouter(flux('/N 3', icc));
    const xmp = Buffer.from(this.xmp(d), 'utf8');
    const nXmp = ajouter(Buffer.concat([Buffer.from('<< /Type /Metadata /Subtype /XML /Length ' + xmp.length + ' >>\nstream\n', 'latin1'),
      xmp, Buffer.from('\nendstream', 'latin1')]));

    specs.sort((a, b) => (a.nom < b.nom ? -1 : 1));
    definir(nCatalogue, '<< /Type /Catalog /Pages ' + nPages + ' 0 R /Metadata ' + nXmp + ' 0 R'
      + ' /Lang ' + chainePdf(this.infos.langue)
      + ' /OutputIntents [<< /Type /OutputIntent /S /GTS_PDFA1 /OutputConditionIdentifier (sRGB IEC61966-2.1)'
      + ' /Info (sRGB IEC61966-2.1) /RegistryName (http://www.color.org) /DestOutputProfile ' + nIcc + ' 0 R >>]'
      + (specs.length ? ' /Names << /EmbeddedFiles << /Names [' + specs.map((s) => chainePdf(s.nom) + ' ' + s.numero + ' 0 R').join(' ') + '] >> >>'
        + ' /AF [' + specs.map((s) => s.numero + ' 0 R').join(' ') + ']' : '')
      + (this.infos.titre ? ' /ViewerPreferences << /DisplayDocTitle true >>' : '') + ' >>');

    const i = this.infos;
    const nInfo = ajouter('<< ' + (i.titre ? '/Title ' + chainePdf(i.titre) + ' ' : '') + (i.auteur ? '/Author ' + chainePdf(i.auteur) + ' ' : '')
      + (i.sujet ? '/Subject ' + chainePdf(i.sujet) + ' ' : '')
      + '/Creator ' + chainePdf(i.createur) + ' /Producer ' + chainePdf(i.createur)
      + ' /CreationDate (' + d.pdf + ') /ModDate (' + d.pdf + ') >>');

    // Serialisation : en-tete binaire, objets, table xref, remorque.
    const morceaux = [Buffer.from('%PDF-1.7\n%', 'latin1'), Buffer.from([0xE2, 0xE3, 0xCF, 0xD3, 0x0A])];
    let position = morceaux.reduce((s, b) => s + b.length, 0);
    const positions = [];
    objets.forEach((contenu, k) => {
      if (!contenu) throw new Error('objet PDF ' + (k + 1) + ' reserve mais jamais defini');
      positions.push(position);
      const bloc = Buffer.concat([Buffer.from((k + 1) + ' 0 obj\n', 'latin1'), contenu, Buffer.from('\nendobj\n', 'latin1')]);
      morceaux.push(bloc);
      position += bloc.length;
    });
    const id = crypto.createHash('md5').update(Buffer.concat(morceaux)).update(d.iso).digest('hex').toUpperCase();
    const xref = 'xref\n0 ' + (objets.length + 1) + '\n0000000000 65535 f \n'
      + positions.map((p) => String(p).padStart(10, '0') + ' 00000 n \n').join('')
      + 'trailer\n<< /Size ' + (objets.length + 1) + ' /Root ' + nCatalogue + ' 0 R /Info ' + nInfo + ' 0 R'
      + ' /ID [<' + id + '> <' + id + '>] >>\nstartxref\n' + position + '\n%%EOF\n';
    morceaux.push(Buffer.from(xref, 'latin1'));
    return Buffer.concat(morceaux);
  }
}

module.exports = { DocumentPdf, chainePdf, nomPdf, RESSOURCES };
