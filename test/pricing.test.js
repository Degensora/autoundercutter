import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTargetPrice, findCompetitors, normalizeSection, sectionsMatch } from '../src/pricing.js';

test('section names normalise across marketplaces', () => {
  assert.equal(normalizeSection('Sec 112'), '112');
  assert.equal(normalizeSection('Section 0112'), '112');
  assert.equal(normalizeSection('U 9'), 'u9');
  assert.equal(normalizeSection('u9'), 'u9');
  assert.equal(normalizeSection('Floor A'), 'floora');
  assert.equal(normalizeSection('Lower Level 10'), 'lowerlevel10');
  assert.ok(sectionsMatch('U 9', 'u9'));
  assert.ok(!sectionsMatch('112', '113'));
  assert.ok(!sectionsMatch('', ''));
  assert.equal(normalizeSection('Second Level'), 'secondlevel'); // "Sec" prefix only stripped as a word
});

const market = [
  { id: 'a', section: 'u 9', row: 'n', quantity: 2, price: 207 },
  { id: 'b', section: 'u 9', row: 't', quantity: 4, price: 210 },
  { id: 'c', section: 'u 9', row: 'w', quantity: 5, price: 215 },
  { id: 'd', section: 'floor a', row: '1', quantity: 2, price: 900 },
  { id: 'mine', section: 'u 9', row: 'n', quantity: 2, price: 206, isMine: true },
];

test('competitors are same-section only and never my own listing', () => {
  const c = findCompetitors({ section: 'U 9', quantity: 2 }, market);
  assert.deepEqual(c.map((x) => x.id), ['a', 'b', 'c']);
});

test('compareQuantity drops listings that cannot sell my quantity', () => {
  const c = findCompetitors({ section: 'U 9', quantity: 4 }, market, { compareQuantity: true });
  assert.deepEqual(c.map((x) => x.id), ['b', 'c']);
  const withSplits = findCompetitors({ section: 'U 9', quantity: 3 }, [{ id: 'x', section: 'u 9', quantity: 6, splits: [2, 4, 6], price: 100 }], { compareQuantity: true });
  assert.equal(withSplits.length, 0);
});

test('undercut by $1 below the lowest competitor', () => {
  const competitors = findCompetitors({ section: 'U 9', quantity: 2 }, market);
  const d = computeTargetPrice({ listing: { section: 'U 9', quantity: 2, current_price: 230, floor_price: 150 }, competitors, settings: { undercutAmount: 1 } });
  assert.equal(d.price, 206);
  assert.equal(d.reason, 'undercut');
  assert.equal(d.marketLow, 207);
  assert.ok(d.changed);
  assert.ok(d.isLowest);
});

test('follows the market back up when raisePrices is on, holds when off', () => {
  const competitors = [{ id: 'z', section: '112', price: 300 }];
  const up = computeTargetPrice({ listing: { section: '112', current_price: 250, floor_price: 100 }, competitors, settings: { undercutAmount: 1, raisePrices: true } });
  assert.equal(up.price, 299);
  const hold = computeTargetPrice({ listing: { section: '112', current_price: 250, floor_price: 100 }, competitors, settings: { undercutAmount: 1, raisePrices: false } });
  assert.equal(hold.price, 250);
  assert.equal(hold.reason, 'hold');
  assert.ok(!hold.changed);
});

test('the floor always wins', () => {
  const competitors = [{ id: 'z', section: '112', price: 120 }];
  const d = computeTargetPrice({ listing: { section: '112', current_price: 150, floor_price: 130 }, competitors, settings: { undercutAmount: 1 } });
  assert.equal(d.price, 130);
  assert.equal(d.reason, 'floor');
  assert.ok(!d.isLowest);
});

test('ceiling caps the price, no competition holds at ceiling / current', () => {
  const capped = computeTargetPrice({ listing: { section: '112', current_price: 150, floor_price: 50, ceiling_price: 180 }, competitors: [{ id: 'z', section: '112', price: 500 }], settings: { undercutAmount: 1 } });
  assert.equal(capped.price, 180);
  assert.equal(capped.reason, 'ceiling');
  const none = computeTargetPrice({ listing: { section: '112', current_price: 150, floor_price: 50 }, competitors: [], settings: {} });
  assert.equal(none.price, 150);
  assert.equal(none.reason, 'no_competition');
  assert.ok(!none.changed);
});

test('per-listing undercut override and whole-dollar rounding', () => {
  const competitors = [{ id: 'z', section: '112', price: 99.5 }];
  const d = computeTargetPrice({ listing: { section: '112', current_price: 120, floor_price: 10, undercut_amount: 2.5 }, competitors, settings: { undercutAmount: 1 } });
  assert.equal(d.price, 97);
  const whole = computeTargetPrice({ listing: { section: '112', current_price: 120, floor_price: 10 }, competitors, settings: { undercutAmount: 1, wholeDollars: true } });
  assert.equal(whole.price, 98);
});

test('staggering: second own listing sits staggerAmount under the first, floor still wins', () => {
  const competitors = [{ id: 'z', section: '112', price: 300 }];
  const leader = computeTargetPrice({ listing: { section: '112', current_price: 320, floor_price: 100 }, competitors, settings: { undercutAmount: 1, staggerAmount: 1 } });
  assert.equal(leader.price, 299);
  const second = computeTargetPrice({ listing: { section: '112', current_price: 320, floor_price: 100 }, competitors, settings: { undercutAmount: 1, staggerAmount: 1 }, anchorPrice: leader.price });
  assert.equal(second.price, 298);
  assert.equal(second.reason, 'stagger');
  const third = computeTargetPrice({ listing: { section: '112', current_price: 320, floor_price: 297.5 }, competitors, settings: { undercutAmount: 1, staggerAmount: 1 }, anchorPrice: second.price });
  assert.equal(third.price, 297.5);
  assert.equal(third.reason, 'floor');
  // no competition: followers still ladder under the leader's held price
  const alone = computeTargetPrice({ listing: { section: '112', current_price: 250, floor_price: 100 }, competitors: [], settings: { staggerAmount: 2 }, anchorPrice: 250 });
  assert.equal(alone.price, 248);
  assert.equal(alone.reason, 'stagger');
});
