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
  db.setSettings({ dryRun: false, undercutAmount: 1, defaultFloorMode: 'cost', ...settingsPatch });
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
