import test from 'node:test';
import assert from 'node:assert/strict';
import {total, discountedTotal, receiptLabel} from '../src/index.mjs';

test('quantities, including zero, contribute to the order total', () => {
  assert.equal(total([{price: 12, quantity: 3}, {price: 5, quantity: 0}]), 36);
  assert.equal(total([]), 0);
});

test('discount uses the documented fractional rate', () => {
  assert.equal(discountedTotal(100, 0.2), 80);
});

test('receipt label remains an exported string', () => {
  assert.equal(typeof receiptLabel, 'string');
});
