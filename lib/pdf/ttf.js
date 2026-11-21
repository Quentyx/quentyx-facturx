'use strict';
/*
 * POLICES TRUETYPE : lecture, mesure du texte, sous-ensemble.
 *
 * PDF/A exige que chaque police soit EMBARQUEE. DejaVu Sans entiere pese
 * 750 Ko : l embarquer dans chaque facture serait absurde. Le sous-ensemble
 * garde les NUMEROS de glyphes et vide ceux qui ne servent pas. La table des
 * glyphes fond a quelques Ko, et le PDF adresse chaque glyphe par son numero
 * d origine (CIDToGIDMap /Identity), sans table de correspondance a tenir.
 *
 * Seules les polices a contours TrueType (table glyf) sont prises en charge.
 * Une police CFF (OTF a contours PostScript) est refusee avec un message clair.
 */

function somme32(buf) {
  let s = 0;
  const n = Math.ceil(buf.length / 4) * 4;
  const b = buf.length === n ? buf : Buffer.concat([buf, Buffer.alloc(n - buf.length)]);
  for (let i = 0; i < n; i += 4) s = (s + b.readUInt32BE(i)) >>> 0;
  return s;
}

class Police {
  constructor(buf, nom) {
    this.buf = buf;
    this.nom = nom || 'police';
    const version = buf.readUInt32BE(0);
    if (version === 0x4F54544F) throw new Error(this.nom + ' : police CFF (OTTO) non prise en charge, fournir une police TrueType');
    if (version !== 0x00010000 && version !== 0x74727565) throw new Error(this.nom + ' : ce fichier n est pas une police TrueType');
    this.tables = {};
    const n = buf.readUInt16BE(4);
    for (let i = 0; i < n; i++) {
      const o = 12 + i * 16;
      this.tables[buf.toString('latin1', o, o + 4)] = { offset: buf.readUInt32BE(o + 8), length: buf.readUInt32BE(o + 12) };
    }
    for (const t of ['head', 'hhea', 'maxp', 'hmtx', 'cmap', 'loca', 'glyf']) {
      if (!this.tables[t]) throw new Error(this.nom + ' : table ' + t + ' absente');
    }
    const head = this.tables.head.offset;
    this.unitsPerEm = buf.readUInt16BE(head + 18);
    this.bbox = [buf.readInt16BE(head + 36), buf.readInt16BE(head + 38), buf.readInt16BE(head + 40), buf.readInt16BE(head + 42)];
    this.locLong = buf.readInt16BE(head + 50) === 1;
    const hhea = this.tables.hhea.offset;
    this.ascender = buf.readInt16BE(hhea + 4);
    this.descender = buf.readInt16BE(hhea + 6);
    this.numberOfHMetrics = buf.readUInt16BE(hhea + 34);
    this.numGlyphs = buf.readUInt16BE(this.tables.maxp.offset + 4);

    this.capHeight = Math.round(this.ascender * 0.7);
    this.poids = 400;
    const os2 = this.tables['OS/2'];
    if (os2) {
      const o = os2.offset;
      this.poids = buf.readUInt16BE(o + 4);
      const fsType = buf.readUInt16BE(o + 8);
      // Bit 1 : embarquement interdit par la licence. PDF/A exige un droit d embarquer.
      if ((fsType & 0x000F) === 0x0002) throw new Error(this.nom + ' : licence restreinte, la police ne peut pas etre embarquee');
      if (buf.readUInt16BE(o) >= 2 && os2.length >= 90) this.capHeight = buf.readInt16BE(o + 88);
    }
    this.italique = 0;
    this.chasseFixe = false;
    if (this.tables.post) {
      const o = this.tables.post.offset;
      this.italique = buf.readInt32BE(o + 4) / 65536;
      this.chasseFixe = buf.readUInt32BE(o + 12) !== 0;
    }
    this.nomPostScript = (this.lireNom(6) || this.nom).replace(/[^A-Za-z0-9-]/g, '');
    this.cmap = this.lireCmap();
    this.utilises = new Map();   // glyphe -> texte unicode, pour la table ToUnicode
    this.manquants = new Set();  // caracteres que la police ne sait pas dessiner
  }

  table(tag) {
    const t = this.tables[tag];
    return this.buf.subarray(t.offset, t.offset + t.length);
  }

  lireNom(id) {
    const t = this.tables.name;
    if (!t) return '';
    const b = this.buf, o = t.offset;
    const count = b.readUInt16BE(o + 2), base = o + b.readUInt16BE(o + 4);
    let repli = '';
    for (let i = 0; i < count; i++) {
      const r = o + 6 + i * 12;
      if (b.readUInt16BE(r + 6) !== id) continue;
      const plat = b.readUInt16BE(r), len = b.readUInt16BE(r + 8), off = base + b.readUInt16BE(r + 10);
      if (plat === 3) {
        let s = '';
        for (let k = 0; k < len; k += 2) s += String.fromCharCode(b.readUInt16BE(off + k));
        return s;
      }
      if (plat === 1 && !repli) repli = b.toString('latin1', off, off + len);
    }
    return repli;
  }

  lireCmap() {
    const b = this.buf, o = this.tables.cmap.offset;
    const n = b.readUInt16BE(o + 2);
    const sous = [];
    for (let i = 0; i < n; i++) {
      const r = o + 4 + i * 8;
      const plat = b.readUInt16BE(r), enc = b.readUInt16BE(r + 2), off = o + b.readUInt32BE(r + 4);
      sous.push({ plat, enc, off, format: b.readUInt16BE(off) });
    }
    const rang = (s) => (s.plat === 3 && s.enc === 10 && s.format === 12 ? 0
      : s.plat === 0 && s.format === 12 ? 1
      : s.plat === 3 && s.enc === 1 && s.format === 4 ? 2
      : s.plat === 0 && s.format === 4 ? 3 : 9);
    const choisie = sous.sort((a, c) => rang(a) - rang(c))[0];
    if (!choisie || rang(choisie) === 9) throw new Error(this.nom + ' : aucune table cmap Unicode exploitable');
    const map = new Map();
    const p = choisie.off;
    if (choisie.format === 12) {
      const groupes = b.readUInt32BE(p + 12);
      for (let i = 0; i < groupes; i++) {
        const g = p + 16 + i * 12;
        const debut = b.readUInt32BE(g), fin = b.readUInt32BE(g + 4), glyphe = b.readUInt32BE(g + 8);
        for (let c = debut; c <= fin; c++) map.set(c, glyphe + c - debut);
      }
    } else {
      const segX2 = b.readUInt16BE(p + 6), seg = segX2 / 2;
      const fins = p + 14, debuts = fins + segX2 + 2, deltas = debuts + segX2, plages = deltas + segX2;
      for (let i = 0; i < seg; i++) {
        const fin = b.readUInt16BE(fins + i * 2), debut = b.readUInt16BE(debuts + i * 2);
        const delta = b.readInt16BE(deltas + i * 2), ro = b.readUInt16BE(plages + i * 2);
        if (debut === 0xFFFF) continue;
        for (let c = debut; c <= fin; c++) {
          let g;
          if (ro === 0) g = (c + delta) & 0xFFFF;
          else {
            g = b.readUInt16BE(plages + i * 2 + ro + (c - debut) * 2);
            if (g) g = (g + delta) & 0xFFFF;
          }
          if (g) map.set(c, g);
        }
      }
    }
    return map;
  }

  avance(glyphe) {
    const i = Math.min(glyphe, this.numberOfHMetrics - 1);
    return this.buf.readUInt16BE(this.tables.hmtx.offset + i * 4);
  }

  glyphe(codePoint) { return this.cmap.get(codePoint) || 0; }

  /** Largeur d un texte, en points, a la taille donnee. */
  largeur(texte, taille) {
    let w = 0;
    for (const ch of String(texte)) w += this.avance(this.glyphe(ch.codePointAt(0)));
    return w * taille / this.unitsPerEm;
  }

  /** Caracteres du texte que la police ne sait pas dessiner. */
  absents(texte) {
    return [...new Set([...String(texte)].filter((ch) => !this.cmap.has(ch.codePointAt(0)) && ch.trim()))];
  }

  /** Encode un texte en numeros de glyphes (hexadecimal PDF) et retient ceux qui servent. */
  encoder(texte) {
    let hex = '';
    for (const ch of String(texte)) {
      const g = this.glyphe(ch.codePointAt(0));
      if (g && !this.utilises.has(g)) this.utilises.set(g, ch);
      if (!g && ch.trim()) this.manquants.add(ch);
      hex += g.toString(16).padStart(4, '0');
    }
    return hex.toUpperCase();
  }

  plage(g) {
    const loca = this.tables.loca.offset, b = this.buf;
    const d = this.locLong ? b.readUInt32BE(loca + g * 4) : b.readUInt16BE(loca + g * 2) * 2;
    const f = this.locLong ? b.readUInt32BE(loca + g * 4 + 4) : b.readUInt16BE(loca + g * 2 + 2) * 2;
    return [d, f - d];
  }

  composants(g) {
    const [d, l] = this.plage(g);
    if (l < 10) return [];
    const b = this.buf, o = this.tables.glyf.offset + d;
    if (b.readInt16BE(o) >= 0) return [];
    const r = [];
    let p = o + 10, drapeaux;
    do {
      drapeaux = b.readUInt16BE(p);
      r.push(b.readUInt16BE(p + 2));
      p += 4 + ((drapeaux & 0x0001) ? 4 : 2);
      if (drapeaux & 0x0008) p += 2;
      else if (drapeaux & 0x0040) p += 4;
      else if (drapeaux & 0x0080) p += 8;
    } while (drapeaux & 0x0020);
    return r;
  }

  /** Les glyphes a garder : ceux du texte, le glyphe 0, et les composants des glyphes composes. */
  glyphesGardes() {
    const garder = new Set([0, ...this.utilises.keys()]);
    const pile = [...garder];
    while (pile.length) {
      for (const c of this.composants(pile.pop())) {
        if (!garder.has(c) && c < this.numGlyphs) { garder.add(c); pile.push(c); }
      }
    }
    return garder;
  }

  /** Le programme de police reduit, pret a embarquer (FontFile2). */
  sousEnsemble() {
    const garder = this.glyphesGardes();
    const glyf = this.tables.glyf.offset;
    const morceaux = [];
    const loca = Buffer.alloc((this.numGlyphs + 1) * 4);
    let pos = 0;
    for (let g = 0; g < this.numGlyphs; g++) {
      loca.writeUInt32BE(pos, g * 4);
      if (!garder.has(g)) continue;
      const [d, l] = this.plage(g);
      if (!l) continue;
      morceaux.push(this.buf.subarray(glyf + d, glyf + d + l));
      const bourrage = (4 - (l % 4)) % 4;
      if (bourrage) morceaux.push(Buffer.alloc(bourrage));
      pos += l + bourrage;
    }
    loca.writeUInt32BE(pos, this.numGlyphs * 4);

    const head = Buffer.from(this.table('head'));
    head.writeUInt32BE(0, 8);        // checkSumAdjustment, recalcule plus bas
    head.writeInt16BE(1, 50);        // loca au format long

    const tables = { head, glyf: Buffer.concat(morceaux), loca };
    for (const t of ['hhea', 'maxp', 'hmtx', 'cvt ', 'fpgm', 'prep']) {
      if (this.tables[t]) tables[t] = Buffer.from(this.table(t));
    }
    return assembler(tables);
  }
}

function assembler(tables) {
  const tags = Object.keys(tables).sort();
  const n = tags.length;
  const puissance = 2 ** Math.floor(Math.log2(n));
  const entete = Buffer.alloc(12 + n * 16);
  entete.writeUInt32BE(0x00010000, 0);
  entete.writeUInt16BE(n, 4);
  entete.writeUInt16BE(puissance * 16, 6);
  entete.writeUInt16BE(Math.log2(puissance), 8);
  entete.writeUInt16BE(n * 16 - puissance * 16, 10);
  const corps = [];
  let offset = entete.length, offsetHead = 0;
  tags.forEach((tag, i) => {
    const t = tables[tag];
    const r = 12 + i * 16;
    entete.write(tag, r, 4, 'latin1');
    entete.writeUInt32BE(somme32(t), r + 4);
    entete.writeUInt32BE(offset, r + 8);
    entete.writeUInt32BE(t.length, r + 12);
    if (tag === 'head') offsetHead = offset;
    const bourrage = (4 - (t.length % 4)) % 4;
    corps.push(t, Buffer.alloc(bourrage));
    offset += t.length + bourrage;
  });
  const police = Buffer.concat([entete, ...corps]);
  police.writeUInt32BE((0xB1B0AFBA - somme32(police)) >>> 0, offsetHead + 8);
  return police;
}

module.exports = { Police, somme32 };
