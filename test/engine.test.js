import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { Engine, defaultFloor } from '../src/engine.js';
import { DEFAULT_SETTINGS } from '../src/config.js';

/** A deterministic fake marketplace. */
function fakeMarketplace() {
  const state = {
    events: [{ externalEventId: 'E1', shEventId: '160227629', name: 'Bruno Mars', venue: 'Falcon Stadium', venueId: '2224', dateText: '09/26/26', timeText: '7pm' }],
    mine: [
      { listingId: 'L-1', taInventoryId: 'ta1', shListingId: 'SH1', section: 'U 9', row: 'N', seats: '1-2', quantity: 2, price: 230, cost: 150 },
      { listingId: 'L-2', taInventoryId: 'ta2', shListingId: 'SH2', section: 'Floor A', row: '3', seats: '5-8', quantity: 4, price: 600, cost: 500 },
    ],
    market: [
      { section: 'u 9', row: 'n', quantity: 2, price: 207 },
      { section: 'u 9', row: 't', quantity: 4, price: 210 },
      { section: 'floor a', row: '9', quantity: 2, price: 505 },
    ],
    updates: [],
  };
  return {
    state,
    name: 'fake',
    label: 'Fake',
    status: () => ({ hasSession: true }),
    listEvents: async () => state.events,
    findEventBySHId: async (id) => state.events.find((e) => e.shEventId === id) || null,
    getMyListings: async () => state.mine.map((m) => ({ ...m })),
    getMarketListings: async () => [
      ...state.market.map((m) => ({ ...m, isMine: false })),
      ...state.mine.map((m) => ({ section: m.section, row: m.row, quantity: m.quantity, price: m.price, isMine: false })), // marketplace did not flag them
    ],
    updateListingPrice: async (listing, price) => {
      state.updates.push({ listingId: listing.listing_id, price });
      const m = state.mine.find((x) => x.listingId === listing.listing_id);
      const prev = m.price;
      m.price = price;
      return { price, previousPrice: prev };
    },
  };
}

function setup(settingsPatch = {}) {
  const db = openDb(':memory:', DEFAULT_SETTINGS);
  db.setSettings({ dryRun: false, undercutAmount: 1, defaultFloorMode: 'cost', repriceCooldownSec: 0, ...settingsPatch });
  const marketplace = fakeMarketplace();
  const engine = new Engine({ db, marketplace, logger: { log() {}, warn() {}, error() {} } });
  return { db, marketplace, engine };
}

test('defaultFloor honours the configured mode', () => {
  assert.equal(defaultFloor({ price: 230, cost: 150 }, { defaultFloorMode: 'cost' }), 150);
  assert.equal(defaultFloor({ price: 230, cost: 0 }, { defaultFloorMode: 'cost' }), 230);
  assert.equal(defaultFloor({ price: 230 }, { defaultFloorMode: 'percent', defaultFloorPercent: 50 }), 115);
  assert.equal(defaultFloor({ price: 230 }, { defaultFloorMode: 'current' }), 230);
});

test('sync + reprice: undercuts by $1, respects floor, ignores my own fingerprint', async () => {
  const { db, marketplace, engine } = setup();
  await engine.syncEvents();
  const [event] = db.listEvents();
  assert.equal(event.enabled, 0, 'synced events start disabled');
  db.updateEvent(event.id, { enabled: 1 });

  const summary = await engine.runCycle();
  assert.equal(summary.events, 1);
  assert.equal(summary.listings, 2);
  assert.equal(summary.changed, 2);
  assert.equal(summary.errors, 0);

  const listings = db.listListings(event.id);
  const u9 = listings.find((l) => l.listing_id === 'L-1');
  const floorA = listings.find((l) => l.listing_id === 'L-2');
  assert.equal(u9.floor_price, 150);
  assert.equal(u9.current_price, 206); // 207 - 1
  assert.equal(u9.last_reason, 'undercut');
  assert.equal(u9.is_lowest, 1);
  assert.equal(floorA.current_price, 504); // 505 - 1, above floor 500
  assert.deepEqual(marketplace.state.updates.map((u) => u.price).sort((a, b) => a - b), [206, 504]);

  // Competitor drops below my floor: hold at the floor and report it.
  marketplace.state.market[2].price = 480;
  await engine.runCycle();
  const after = db.getListing(floorA.id);
  assert.equal(after.current_price, 500);
  assert.equal(after.last_reason, 'floor');
  assert.equal(after.is_lowest, 0);

  // Nothing changes when the market is stable: no extra update calls.
  const before = marketplace.state.updates.length;
  await engine.runCycle();
  assert.equal(marketplace.state.updates.length, before);

  // My own listing at 206 must not be treated as a competitor (fingerprint match) — still 206, not 205.
  assert.equal(db.getListing(u9.id).current_price, 206);
  assert.ok(db.listHistory(u9.id).length >= 1);
});

test('dry run records intended changes without calling the marketplace', async () => {
  const { db, marketplace, engine } = setup({ dryRun: true });
  await engine.syncEvents();
  const [event] = db.listEvents();
  db.updateEvent(event.id, { enabled: 1 });
  const summary = await engine.runCycle();
  assert.equal(summary.changed, 2);
  assert.equal(marketplace.state.updates.length, 0);
  const l = db.listListings(event.id)[0];
  assert.equal(l.current_price, marketplace.state.mine.find((m) => m.listingId === l.listing_id).price);
  assert.ok(db.listHistory(l.id).every((h) => h.dry_run === 1));
});

test('listings that disappear are marked gone, paused listings are left alone', async () => {
  const { db, marketplace, engine } = setup();
  await engine.syncEvents();
  const [event] = db.listEvents();
  db.updateEvent(event.id, { enabled: 1 });
  await engine.runCycle();
  const l2 = db.listListings(event.id).find((l) => l.listing_id === 'L-2');
  db.updateListing(l2.id, { status: 'paused' });
  marketplace.state.market[2].price = 100; // would force a change if active
  marketplace.state.mine = marketplace.state.mine.filter((m) => m.listingId !== 'L-1'); // L-1 sold
  await engine.runCycle();
  const all = db.listListings(event.id, { includeGone: true });
  assert.equal(all.find((l) => l.listing_id === 'L-1').status, 'gone');
  assert.equal(all.find((l) => l.listing_id === 'L-2').current_price, 504);
  assert.equal(marketplace.state.updates.filter((u) => u.listingId === 'L-2').length, 1);
});

test('my own stale row in the market data (old price still shown) is not treated as a competitor', async () => {
  const { db, marketplace, engine } = setup();
  await engine.syncEvents();
  const [event] = db.listEvents();
  db.updateEvent(event.id, { enabled: 1 });
  await engine.runCycle(); // U 9 goes 230 -> 206
  // StubHub's copy lags: my listing still shows at the OLD price 230 and the only real competitor is gone.
  marketplace.state.market = [{ section: 'u 9', row: 'n', quantity: 2, price: 230 }];
  await engine.runCycle();
  const u9 = db.listListings(event.id).find((l) => l.listing_id === 'L-1');
  assert.equal(u9.current_price, 206, 'must not chase its own stale row up to 229');
  assert.equal(u9.last_reason, 'no_competition');
});

test('engine pauses while the marketplace needs a login and resumes afterwards', async () => {
  const { db, marketplace, engine } = setup();
  await engine.syncEvents();
  const [event] = db.listEvents();
  db.updateEvent(event.id, { enabled: 1 });
  let authState = 'needs_code';
  marketplace.status = () => ({ hasSession: authState === 'ok', authState });
  const realGet = marketplace.getMyListings;
  marketplace.getMyListings = async () => {
    if (authState !== 'ok') throw Object.assign(new Error('Ticket Attendant needs an authenticator code.'), { name: 'TicketAttendantAuthError' });
    return realGet();
  };
  const first = await engine.runCycle();
  assert.equal(first.errors, 1);
  assert.equal(engine.status().authBlocked, true);
  const second = await engine.runCycle();
  assert.equal(second.skipped, 'auth');
  assert.equal(db.recentLog().filter((l) => l.level === 'error').length, 1, 'logs the pause once, not every cycle');
  authState = 'ok';
  const third = await engine.runCycle();
  assert.equal(third.changed, 2);
  assert.equal(engine.status().authBlocked, false);
});

test('two own listings in one section are laddered by sell order, not tied or leapfrogged', async () => {
  const { db, marketplace, engine } = setup({ repriceCooldownSec: 0 });
  marketplace.state.mine.push({ listingId: 'L-3', taInventoryId: 'ta3', shListingId: 'SH3', section: 'u9', row: 'P', seats: '3-4', quantity: 2, price: 240, cost: 120 });
  await engine.syncEvents();
  const [event] = db.listEvents();
  db.updateEvent(event.id, { enabled: 1 });
  await engine.runCycle();
  let l1 = db.listListings(event.id).find((l) => l.listing_id === 'L-1');
  let l3 = db.listListings(event.id).find((l) => l.listing_id === 'L-3');
  // default order = cheaper cost first: L-3 (cost 120) leads at 206, L-1 follows at 205
  assert.equal(l3.current_price, 206);
  assert.equal(l1.current_price, 205);
  assert.equal(l1.last_reason, 'stagger');
  // stable on the next cycle: my own rows in the market are not competitors
  const before = marketplace.state.updates.length;
  await engine.runCycle();
  assert.equal(marketplace.state.updates.length, before);
  // flip the sell order: L-1 should lead now
  db.updateListing(l1.id, { sell_order: 1 });
  db.updateListing(l3.id, { sell_order: 2 });
  await engine.runCycle();
  l1 = db.getListing(l1.id);
  l3 = db.getListing(l3.id);
  assert.equal(l1.current_price, 206);
  assert.equal(l3.current_price, 205);
});

test('cooldown: a listing changed recently is left alone and shows the pending price', async () => {
  const { db, marketplace, engine } = setup({ repriceCooldownSec: 600 });
  await engine.syncEvents();
  const [event] = db.listEvents();
  db.updateEvent(event.id, { enabled: 1 });
  await engine.runCycle(); // U 9 -> 206
  marketplace.state.market[0].price = 200; // competitor drops right after
  await engine.runCycle();
  const u9 = db.listListings(event.id).find((l) => l.listing_id === 'L-1');
  assert.equal(u9.current_price, 206, 'not changed during cooldown');
  assert.equal(u9.last_reason, 'cooldown');
  assert.equal(u9.pending_price, 199);
  assert.equal(u9.is_lowest, 0);
  // once the cooldown has passed it catches up
  db.updateListing(u9.id, { last_price_change_at: new Date(Date.now() - 11 * 60 * 1000).toISOString() });
  await engine.runCycle();
  assert.equal(db.getListing(u9.id).current_price, 199);
});

test('new unpriced, un-broadcast inventory gets a price and is broadcast once; user unbroadcast is respected', async () => {
  const { db, marketplace, engine } = setup({ newListingMarkupPercent: 30 });
  const broadcasts = [];
  marketplace.broadcastListings = async (ls, opts) => {
    broadcasts.push({ ids: ls.map((l) => l.listing_id), splits: opts.splits });
    for (const l of ls) marketplace.state.mine.find((m) => m.listingId === l.listing_id).broadcast = true;
    return { updated: ls.length };
  };
  // fresh PO: no price, nobody else in section 305, not broadcast
  marketplace.state.mine.push({ listingId: 'L-9', taInventoryId: 'ta9', shListingId: null, section: '305', row: 'B', seats: '1-4', quantity: 4, price: 0, cost: 100, broadcast: false });
  await engine.syncEvents();
  const [event] = db.listEvents();
  db.updateEvent(event.id, { enabled: 1 });
  await engine.runCycle();
  let l9 = db.listListings(event.id).find((l) => l.listing_id === 'L-9');
  assert.equal(l9.current_price, 130, 'cost + 30% when there is nobody to undercut');
  assert.equal(l9.floor_price, 100);
  assert.equal(l9.broadcast, 1);
  assert.deepEqual(broadcasts, [{ ids: ['L-9'], splits: '-1' }]);
  // the user takes it off the exchanges by hand: we do not put it back
  marketplace.state.mine.find((m) => m.listingId === 'L-9').broadcast = false;
  await engine.runCycle();
  l9 = db.getListing(l9.id);
  assert.equal(l9.broadcast, 0);
  assert.equal(broadcasts.length, 1);
  // a competitor shows up in 305: normal undercutting takes over
  marketplace.state.market.push({ section: '305', row: 'A', quantity: 4, price: 150 });
  db.updateListing(l9.id, { last_price_change_at: null });
  await engine.runCycle();
  assert.equal(db.getListing(l9.id).current_price, 149);
});

test('unpriced listing with no cost is flagged instead of being listed at $0', async () => {
  const { db, marketplace, engine } = setup();
  marketplace.state.mine.push({ listingId: 'L-0', taInventoryId: 'ta0', section: '401', row: 'A', seats: '1-2', quantity: 2, price: 0, cost: 0, broadcast: false });
  await engine.syncEvents();
  const [event] = db.listEvents();
  db.updateEvent(event.id, { enabled: 1 });
  await engine.runCycle();
  const l0 = db.listListings(event.id).find((l) => l.listing_id === 'L-0');
  assert.equal(l0.current_price, 0);
  assert.match(l0.last_error, /No price and no cost/);
  assert.equal(marketplace.state.updates.some((u) => u.listingId === 'L-0'), false);
});
