'use strict';
/*
 * IMAGES PNG, decodees avec le zlib de Node et rien d autre.
 * Le PDF ne sait pas lire un PNG avec sa transparence : on separe la couleur
 * et l alpha (SMask). Pris en charge : 8 bits, non entrelace, niveaux de gris,
 * couleur, palette, avec ou sans alpha. Le reste est refuse clairement.
 */
const zlib = require('zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
}

function decoderPng(buf) {
  if (!Buffer.isBuffer(buf) || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('image : ce n est pas un PNG');
  let p = 8, largeur, hauteur, profondeur, type, entrelace, palette = null, trns = null;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), tag = buf.toString('latin1', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (tag === 'IHDR') {
      largeur = d.readUInt32BE(0); hauteur = d.readUInt32BE(4);
      profondeur = d[8]; type = d[9]; entrelace = d[12];
    } else if (tag === 'PLTE') palette = d;
    else if (tag === 'tRNS') trns = d;
    else if (tag === 'IDAT') idat.push(d);
    else if (tag === 'IEND') break;
    p += 12 + len;
  }
  if (profondeur !== 8) throw new Error('image PNG : seule la profondeur 8 bits est prise en charge (recu ' + profondeur + ')');
  if (entrelace) throw new Error('image PNG : l entrelacement n est pas pris en charge');
  const canauxSource = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!canauxSource) throw new Error('image PNG : type de couleur inconnu ' + type);
  const brut = zlib.inflateSync(Buffer.concat(idat));
  const ligne = largeur * canauxSource;
  const pixels = Buffer.alloc(ligne * hauteur);
  for (let y = 0; y < hauteur; y++) {
    const filtre = brut[y * (ligne + 1)];
    const src = y * (ligne + 1) + 1, dst = y * ligne;
    for (let x = 0; x < ligne; x++) {
      const a = x >= canauxSource ? pixels[dst + x - canauxSource] : 0;
      const b = y ? pixels[dst - ligne + x] : 0;
      const c = (y && x >= canauxSource) ? pixels[dst - ligne + x - canauxSource] : 0;
      const v = brut[src + x];
      pixels[dst + x] = (filtre === 0 ? v : filtre === 1 ? v + a : filtre === 2 ? v + b
        : filtre === 3 ? v + ((a + b) >> 1) : v + paeth(a, b, c)) & 0xFF;
    }
  }
  const n = largeur * hauteur;
  let couleurs, canaux, alpha = null;
  if (type === 0 || type === 2) {
    canaux = type === 0 ? 1 : 3; couleurs = pixels;
  } else if (type === 3) {
    canaux = 3; couleurs = Buffer.alloc(n * 3);
    if (trns) alpha = Buffer.alloc(n, 255);
    for (let i = 0; i < n; i++) {
      const k = pixels[i];
      palette.copy(couleurs, i * 3, k * 3, k * 3 + 3);
      if (trns && k < trns.length) alpha[i] = trns[k];
    }
  } else {
    canaux = type === 4 ? 1 : 3;
    couleurs = Buffer.alloc(n * canaux); alpha = Buffer.alloc(n);
    for (let i = 0; i < n; i++) {
      pixels.copy(couleurs, i * canaux, i * (canaux + 1), i * (canaux + 1) + canaux);
      alpha[i] = pixels[i * (canaux + 1) + canaux];
    }
  }
  if (alpha && alpha.every((v) => v === 255)) alpha = null;
  return { largeur, hauteur, canaux, couleurs, alpha };
}

/** Un PNG minimal, pour les essais et pour qui veut fabriquer une image sans outil. */
function encoderPng(largeur, hauteur, canaux, pixels) {
  const type = { 1: 0, 2: 4, 3: 2, 4: 6 }[canaux];
  const brut = Buffer.alloc((largeur * canaux + 1) * hauteur);
  for (let y = 0; y < hauteur; y++) pixels.copy(brut, y * (largeur * canaux + 1) + 1, y * largeur * canaux, (y + 1) * largeur * canaux);
  const morceau = (tag, d) => {
    const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
    const t = Buffer.from(tag, 'latin1');
    const c = Buffer.alloc(4); c.writeUInt32BE(zlib.crc32(Buffer.concat([t, d])) >>> 0);
    return Buffer.concat([l, t, d, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largeur, 0); ihdr.writeUInt32BE(hauteur, 4); ihdr[8] = 8; ihdr[9] = type;
  return Buffer.concat([SIGNATURE, morceau('IHDR', ihdr), morceau('IDAT', zlib.deflateSync(brut)), morceau('IEND', Buffer.alloc(0))]);
}

module.exports = { decoderPng, encoderPng };
