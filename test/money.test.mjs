import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allocateExpense } from '../src/money.ts';

const amount = (userId, amountMinor) => ({ userId, amountMinor });

test('equal splits assign remainder cents by user ID and ignore input order', () => {
  const expected = {
    shares: [amount('a', 334), amount('b', 333), amount('c', 333)],
    allocations: [amountAllocation('b', 'a', 333), amountAllocation('c', 'a', 333)],
  };

  assert.deepEqual(allocateExpense(1000, [amount('a', 1000)], { type: 'equal', userIds: ['c', 'a', 'b'] }), expected);
  assert.deepEqual(allocateExpense(1000, [amount('a', 1000)], { type: 'equal', userIds: ['b', 'c', 'a'] }), expected);
});

test('multiple payers are netted into deterministic greedy allocations', () => {
  assert.deepEqual(allocateExpense(1000, [amount('d', 600), amount('b', 400)], {
    type: 'exact', shares: [amount('c', 500), amount('a', 500)],
  }), {
    shares: [amount('a', 500), amount('c', 500)],
    allocations: [
      amountAllocation('a', 'b', 400),
      amountAllocation('a', 'd', 100),
      amountAllocation('c', 'd', 500),
    ],
  });
});

test('safe integer boundary calculations stay exact without mutating inputs', () => {
  const payments = [amount('z', Number.MAX_SAFE_INTEGER)];
  const split = { type: 'equal', userIds: ['z', 'a'] };
  const paymentsBefore = structuredClone(payments);
  const splitBefore = structuredClone(split);

  assert.deepEqual(allocateExpense(Number.MAX_SAFE_INTEGER, payments, split), {
    shares: [amount('a', 4503599627370496), amount('z', 4503599627370495)],
    allocations: [amountAllocation('a', 'z', 4503599627370496)],
  });
  assert.deepEqual(payments, paymentsBefore);
  assert.deepEqual(split, splitBefore);
});

test('rejects invalid totals and amounts with actionable type and range errors', () => {
  assert.throws(() => allocateExpense(1.5, [amount('a', 1)], { type: 'equal', userIds: ['a'] }),
    error => error instanceof TypeError && /total.*safe integer/i.test(error.message));
  assert.throws(() => allocateExpense(0, [], { type: 'equal', userIds: ['a'] }),
    error => error instanceof RangeError && /total.*positive/i.test(error.message));
  assert.throws(() => allocateExpense(10, [amount('a', -1)], { type: 'equal', userIds: ['a'] }),
    error => error instanceof RangeError && /payments.*positive/i.test(error.message));
  assert.throws(() => allocateExpense(10, [amount('a', 10)], { type: 'exact', shares: [amount('a', 0)] }),
    error => error instanceof RangeError && /shares.*positive/i.test(error.message));
});

test('rejects empty and duplicate user IDs within each list', () => {
  assert.throws(() => allocateExpense(10, [amount('', 10)], { type: 'equal', userIds: ['a'] }),
    error => error instanceof TypeError && /payments.*userId.*non-empty/i.test(error.message));
  assert.throws(() => allocateExpense(10, [amount('a', 5), amount('a', 5)], { type: 'equal', userIds: ['a'] }),
    error => error instanceof RangeError && /duplicate.*payments.*a/i.test(error.message));
  assert.throws(() => allocateExpense(10, [amount('a', 10)], { type: 'equal', userIds: ['a', 'a'] }),
    error => error instanceof RangeError && /duplicate.*equal.*a/i.test(error.message));
  assert.throws(() => allocateExpense(10, [amount('a', 10)], { type: 'exact', shares: [amount('a', 5), amount('a', 5)] }),
    error => error instanceof RangeError && /duplicate.*shares.*a/i.test(error.message));
});

test('requires payment and exact share sums to equal the total exactly', () => {
  assert.throws(() => allocateExpense(Number.MAX_SAFE_INTEGER, [
    amount('a', Number.MAX_SAFE_INTEGER - 1), amount('b', 2),
  ], { type: 'equal', userIds: ['a'] }),
  error => error instanceof RangeError && /payments.*sum.*total/i.test(error.message));
  assert.throws(() => allocateExpense(10, [amount('a', 10)], { type: 'exact', shares: [amount('a', 9)] }),
    error => error instanceof RangeError && /shares.*sum.*total/i.test(error.message));
});

test('equal splits require at least one cent per person', () => {
  assert.throws(() => allocateExpense(2, [amount('a', 2)], { type: 'equal', userIds: ['a', 'b', 'c'] }),
    error => error instanceof RangeError && /total.*participant/i.test(error.message));
});

test('rejects more than 50 distinct payers and share participants', () => {
  const userIds = Array.from({ length: 50 }, (_, index) => `u${String(index).padStart(2, '0')}`);
  assert.throws(() => allocateExpense(50, [amount('payer', 50)], { type: 'equal', userIds }),
    error => error instanceof RangeError && /50 distinct users/i.test(error.message));
});

function amountAllocation(debtorUserId, creditorUserId, amountMinor) {
  return { debtorUserId, creditorUserId, amountMinor };
}
