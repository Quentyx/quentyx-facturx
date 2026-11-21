'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('../lib/montants');

test('aucun flottant : 3 x 19,99 = 59,97 exactement', () => {
  assert.strictEqual(M.xmlMontant(M.netLigne(M.dixMilliemes(3), M.dixMilliemes('19.99'))), '59.97');
});
test('un flottant approximatif est refuse, jamais arrondi en silence', () => {
  assert.throws(() => M.centimes(0.1 + 0.2), /au plus 2 decimales/);
  assert.throws(() => M.dixMilliemes('1.23456'), /au plus 4 decimales/);
  assert.throws(() => M.centimes('12,3,4'), /invalide/);
});
test('arrondi commercial : les demis s eloignent de zero', () => {
  assert.strictEqual(M.diviserArrondi(5n, 10n), 1n);
  assert.strictEqual(M.diviserArrondi(-5n, 10n), -1n);
  assert.strictEqual(M.diviserArrondi(4n, 10n), 0n);
  assert.strictEqual(M.xmlMontant(M.montantTva(M.centimes('0.05'), M.dixMilliemes(10))), '0.01');
});
test('formats : XML au point, francais a la virgule avec espaces insecables', () => {
  assert.strictEqual(M.xmlMontant(M.centimes('1234567.8')), '1234567.80');
  assert.strictEqual(M.frMontant(M.centimes('1234567.8')), '1' + M.ESPACE_FINE + '234' + M.ESPACE_FINE + '567,80' + M.INSECABLE + '€');
  assert.strictEqual(M.xmlDecimal(M.dixMilliemes('5.50')), '5.5');
  assert.strictEqual(M.frPrix(M.dixMilliemes('0.0125')), '0,0125' + M.INSECABLE + '€');
  assert.strictEqual(M.frMontant(M.centimes('-3')), '-3,00' + M.INSECABLE + '€');
});
