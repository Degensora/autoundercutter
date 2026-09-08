/**
 * A simulated marketplace so the app can be tried without touching a real account.
 * Competitor prices drift every time the market is read, so the engine has something to react to.
 */
import { normalizeSection } from '../pricing.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEMO_EVENTS = [
  { externalEventId: 'mock-1001', shEventId: '160227629', name: 'Bruno Mars', venue: 'Falcon Stadium', venueId: '2224', dateText: '09/26/26 Sat', timeText: '07:00 PM' },
  { externalEventId: 'mock-1002', shEventId: '160212593', name: 'Chicago Sky at Atlanta Dream', venue: 'State Farm Arena', venueId: '2578', dateText: '09/19/26 Sat', timeText: '07:00 PM' },
];

const DEMO_INVENTORY = {
  'mock-1001': [
    { listingId: 'M-5001', section: 'U 9', row: 'N', seats: '1-2', quantity: 2, cost: 150, price: 230 },
    { listingId: 'M-5002', section: 'Floor A', row: '12', seats: '5-8', quantity: 4, cost: 400, price: 650 },
  ],
  'mock-1002': [{ listingId: 'M-6001', section: '112', row: 'C', seats: '7-8', quantity: 2, cost: 40, price: 95 }],
};

export class MockMarketplace {
  constructor({ volatility = 0.25, seed = 42 } = {}) {
    this.name = 'mock';
    this.label = 'Simulated market (nothing real is changed)';
    this.volatility = volatility;
    this.rand = mulberry32(seed);
    this.events = new Map(DEMO_EVENTS.map((e) => [e.externalEventId, { ...e }]));
    this.inventory = new Map(Object.entries(DEMO_INVENTORY).map(([k, v]) => [k, v.map((l) => ({ ...l, shListingId: `SH${l.listingId}`, taInventoryId: `TA${l.listingId}` }))]));
    this.markets = new Map(); // externalEventId -> competitor rows
    this.nextId = 7000;
    this.supportsCreate = false;
  }

  status() {
    return { name: this.name, label: this.label, hasSession: true, canLogin: true };
  }

  async listEvents() {
    return [...this.events.values()].map((e) => ({ ...e, taEventId: null, openCount: (this.inventory.get(e.externalEventId) || []).length, soldCount: 0 }));
  }

  async findEventBySHId(shEventId) {
    const found = [...this.events.values()].find((e) => String(e.shEventId) === String(shEventId));
    if (found) return found;
    // Unknown link: invent an event with a couple of listings so the demo has something to reprice.
    const ev = { externalEventId: `mock-${this.nextId++}`, shEventId: String(shEventId), name: `Demo event ${shEventId}`, venue: 'Demo Arena', venueId: '1', dateText: '12/31/26 Thu', timeText: '08:00 PM' };
    this.events.set(ev.externalEventId, ev);
    this.inventory.set(ev.externalEventId, [
      { listingId: `M-${this.nextId++}`, shListingId: `SH${this.nextId}`, taInventoryId: `TA${this.nextId}`, section: '101', row: 'A', seats: '1-2', quantity: 2, cost: 80, price: 140 },
      { listingId: `M-${this.nextId++}`, shListingId: `SH${this.nextId}`, taInventoryId: `TA${this.nextId}`, section: '215', row: 'K', seats: '9-12', quantity: 4, cost: 45, price: 90 },
    ]);
    return ev;
  }

  async getMyListings(event) {
    return (this.inventory.get(event.external_event_id) || []).map((l) => ({ ...l, netPrice: Math.round(l.price * 0.9 * 100) / 100, shownQuantity: l.quantity }));
  }

  _ensureMarket(event) {
    const key = event.external_event_id;
    if (!this.markets.has(key)) {
      const rows = [];
      for (const mine of this.inventory.get(key) || []) {
        const n = 3 + Math.floor(this.rand() * 4);
        for (let i = 0; i < n; i++) {
          rows.push({
            id: `c${this.nextId++}`,
            section: mine.section.toLowerCase(),
            row: String.fromCharCode(65 + Math.floor(this.rand() * 20)),
            quantity: [2, 2, 2, 4, 4, 6][Math.floor(this.rand() * 6)],
            price: Math.round(mine.price * (1.0 + this.rand() * 0.6) * 100) / 100,
          });
        }
      }
      for (let i = 0; i < 6; i++) {
        rows.push({ id: `c${this.nextId++}`, section: String(200 + i), row: 'F', quantity: 2, price: Math.round((60 + this.rand() * 300) * 100) / 100 });
      }
      this.markets.set(key, rows);
    }
    return this.markets.get(key);
  }

  _driftMarket(rows) {
    for (const r of rows) {
      if (this.rand() < this.volatility) {
        const pct = -0.1 + this.rand() * 0.16; // mostly small moves, biased slightly down
        r.price = Math.max(5, Math.round(r.price * (1 + pct) * 100) / 100);
      }
    }
    // occasionally somebody sells out or a new seller shows up
    if (rows.length > 3 && this.rand() < 0.08) rows.splice(Math.floor(this.rand() * rows.length), 1);
  }

  async getMarketListings(event, { myListings = [] } = {}) {
    const rows = this._ensureMarket(event);
    this._driftMarket(rows);
    const mine = (this.inventory.get(event.external_event_id) || []).map((l) => ({
      section: l.section.toLowerCase(),
      row: l.row.toLowerCase(),
      quantity: l.quantity,
      price: l.price,
      isMine: true,
    }));
    return [...rows.map((r) => ({ ...r, isMine: false })), ...mine].sort((a, b) => a.price - b.price);
  }

  async updateListingPrice(listing, newPrice) {
    const inv = this.inventory.get(listing.external_event_id ?? listing.event_external_id) || [...this.inventory.values()].flat();
    const mine = inv.find((l) => String(l.listingId) === String(listing.listing_id));
    if (!mine) throw new Error(`Mock listing ${listing.listing_id} not found`);
    const prev = mine.price;
    mine.price = Number(newPrice);
    return { price: mine.price, previousPrice: prev, payoutPercentage: 0.9, warning: null };
  }
}

export function normalizeMockSection(s) {
  return normalizeSection(s);
}
