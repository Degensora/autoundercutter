import express from 'express';
import { parseStubHubUrl } from './stubhub/url.js';
import { normalizeSection } from './pricing.js';

const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

function ok(res, data) {
  res.json({ ok: true, ...data });
}

/**
 * @param {{ db: any, engine: import('./engine.js').Engine, marketplace: any, config: any }} deps
 */
export function createRouter({ db, engine, marketplace, config }) {
  const r = express.Router();
  r.use(express.json({ limit: '1mb' }));

  const wrap = (fn) => (req, res) =>
    Promise.resolve(fn(req, res)).catch((err) => {
      const status = err.status || (err.name === 'TicketAttendantAuthError' ? 401 : 400);
      res.status(status).json({ ok: false, error: err.message });
    });

  function marketBySection(eventId) {
    const snap = db.getSnapshot(eventId);
    if (!snap) return null;
    const bySection = new Map();
    for (const m of snap.listings) {
      const key = normalizeSection(m.section) || '(none)';
      const cur = bySection.get(key) || { key, section: m.section, count: 0, low: null, mine: 0, prices: [] };
      cur.count++;
      if (m.isMine) cur.mine++;
      else {
        cur.prices.push(m.price);
        if (cur.low == null || m.price < cur.low) cur.low = m.price;
      }
      bySection.set(key, cur);
    }
    return {
      fetchedAt: snap.fetchedAt,
      total: snap.listings.length,
      sections: [...bySection.values()]
        .map((s) => ({ ...s, prices: undefined, median: s.prices.length ? s.prices.sort((a, b) => a - b)[Math.floor(s.prices.length / 2)] : null }))
        .sort((a, b) => a.section.localeCompare(b.section)),
    };
  }

  r.get(
    '/state',
    wrap((req, res) => {
      const events = db.listEvents().map((e) => {
        const listings = db.listListings(e.id);
        return { ...e, listings, listingCount: listings.length, market: marketBySection(e.id) };
      });
      ok(res, {
        settings: db.getSettings(),
        engine: engine.status(),
        marketplace: marketplace.status(),
        mode: config.marketplace,
        events,
        log: db.recentLog(150),
      });
    }),
  );

  r.put(
    '/settings',
    wrap((req, res) => {
      const patch = { ...req.body };
      for (const k of ['undercutAmount', 'pollIntervalSec', 'defaultFloorPercent']) if (k in patch) patch[k] = Number(patch[k]);
      if ('undercutAmount' in patch && !(patch.undercutAmount >= 0)) throw new Error('Undercut amount must be 0 or more');
      if ('pollIntervalSec' in patch && !(patch.pollIntervalSec >= 15)) throw new Error('Poll interval must be at least 15 seconds');
      for (const k of ['autoRun', 'dryRun', 'compareQuantity', 'raisePrices', 'wholeDollars', 'autoEnrollListings']) if (k in patch) patch[k] = Boolean(patch[k]);
      if ('defaultFloorMode' in patch && !['cost', 'current', 'percent'].includes(patch.defaultFloorMode)) throw new Error('Bad floor mode');
      const settings = db.setSettings(patch);
      db.log('info', `Settings updated: ${Object.keys(patch).join(', ')}`);
      ok(res, { settings });
    }),
  );

  // ---- events ----
  r.post(
    '/events/sync',
    wrap(async (req, res) => {
      const result = await engine.syncEvents();
      ok(res, { ...result, events: db.listEvents() });
    }),
  );

  r.post(
    '/events',
    wrap(async (req, res) => {
      const parsed = parseStubHubUrl(req.body?.url);
      let event = db.getEventBySHId(parsed.eventId);
      let matched = null;
      try {
        matched = await marketplace.findEventBySHId(parsed.eventId);
      } catch (err) {
        db.log('warn', `Could not look up StubHub event ${parsed.eventId} in ${marketplace.label}: ${err.message}`);
      }
      const patch = {
        sh_event_id: parsed.eventId,
        stubhub_url: parsed.url,
        name: matched?.name || event?.name || parsed.name || `StubHub event ${parsed.eventId}`,
        venue: matched?.venue ?? event?.venue ?? null,
        venue_id: matched?.venueId ?? event?.venue_id ?? null,
        event_date: matched?.dateText ?? event?.event_date ?? parsed.dateText,
        event_time: matched?.timeText ?? event?.event_time ?? null,
        external_event_id: matched?.externalEventId ?? event?.external_event_id ?? null,
        ta_event_id: matched?.taEventId ?? event?.ta_event_id ?? null,
        enabled: 1,
        last_error: matched ? null : `Not found in ${marketplace.label}. Add the inventory there first, then click "Refresh events".`,
      };
      event = event ? db.updateEvent(event.id, patch) : db.insertEvent({ ...patch, source: 'link' });
      db.log('info', `Event added from StubHub link: ${event.name} (StubHub #${parsed.eventId})${matched ? '' : ' — not matched to marketplace inventory yet'}`, { eventId: event.id });
      if (matched) engine.runCycle({ eventId: event.id, force: true }).catch(() => {});
      ok(res, { event, matched: Boolean(matched) });
    }),
  );

  r.patch(
    '/events/:id',
    wrap((req, res) => {
      const event = db.getEvent(Number(req.params.id));
      if (!event) throw Object.assign(new Error('Event not found'), { status: 404 });
      const patch = {};
      if ('enabled' in req.body) patch.enabled = req.body.enabled ? 1 : 0;
      if ('name' in req.body) patch.name = String(req.body.name);
      const updated = db.updateEvent(event.id, patch);
      if ('enabled' in patch) db.log('info', `${updated.name}: repricing ${patch.enabled ? 'enabled' : 'disabled'}`, { eventId: event.id });
      if (patch.enabled) engine.runCycle({ eventId: event.id, force: true }).catch(() => {});
      ok(res, { event: updated });
    }),
  );

  r.delete(
    '/events/:id',
    wrap((req, res) => {
      const event = db.getEvent(Number(req.params.id));
      if (!event) throw Object.assign(new Error('Event not found'), { status: 404 });
      db.deleteEvent(event.id);
      db.log('info', `Removed event ${event.name} from the repricer (nothing changed on the marketplace)`);
      ok(res, {});
    }),
  );

  r.post(
    '/events/:id/run',
    wrap(async (req, res) => {
      const event = db.getEvent(Number(req.params.id));
      if (!event) throw Object.assign(new Error('Event not found'), { status: 404 });
      const summary = await engine.runCycle({ eventId: event.id, force: true });
      ok(res, { summary });
    }),
  );

  r.get(
    '/events/:id/market',
    wrap((req, res) => {
      const snap = db.getSnapshot(Number(req.params.id));
      ok(res, { market: snap });
    }),
  );

  // ---- listings ----
  r.patch(
    '/listings/:id',
    wrap((req, res) => {
      const listing = db.getListing(Number(req.params.id));
      if (!listing) throw Object.assign(new Error('Listing not found'), { status: 404 });
      const patch = {};
      if ('floor_price' in req.body) {
        patch.floor_price = num(req.body.floor_price);
        if (patch.floor_price == null || !(patch.floor_price >= 0)) throw new Error('Floor must be a number ≥ 0');
      }
      if ('ceiling_price' in req.body) {
        patch.ceiling_price = num(req.body.ceiling_price);
        if (patch.ceiling_price != null && !(patch.ceiling_price > 0)) throw new Error('Ceiling must be a positive number or blank');
      }
      if ('undercut_amount' in req.body) {
        patch.undercut_amount = num(req.body.undercut_amount);
        if (patch.undercut_amount != null && !(patch.undercut_amount >= 0)) throw new Error('Undercut must be ≥ 0 or blank');
      }
      if ('status' in req.body) {
        if (!['active', 'paused'].includes(req.body.status)) throw new Error('Status must be active or paused');
        patch.status = req.body.status;
      }
      const floor = patch.floor_price ?? listing.floor_price;
      const ceiling = 'ceiling_price' in patch ? patch.ceiling_price : listing.ceiling_price;
      if (ceiling != null && floor != null && ceiling < floor) throw new Error('Ceiling cannot be below the floor');
      const updated = db.updateListing(listing.id, patch);
      db.log('info', `Listing ${listing.listing_id} (sec ${listing.section} row ${listing.row}) updated: ${Object.entries(patch).map(([k, v]) => `${k}=${v ?? '—'}`).join(', ')}`, { eventId: listing.event_id, listingId: listing.id });
      ok(res, { listing: updated });
    }),
  );

  r.get(
    '/listings/:id/history',
    wrap((req, res) => {
      ok(res, { history: db.listHistory(Number(req.params.id)) });
    }),
  );

  // ---- engine ----
  r.post(
    '/run',
    wrap(async (req, res) => {
      const summary = await engine.runCycle({ force: true });
      ok(res, { summary });
    }),
  );

  r.get(
    '/log',
    wrap((req, res) => {
      ok(res, { log: db.recentLog(Number(req.query.limit) || 300) });
    }),
  );

  r.post(
    '/marketplace/test',
    wrap(async (req, res) => {
      const events = await marketplace.listEvents();
      ok(res, { status: marketplace.status(), eventCount: events.length, sample: events.slice(0, 5) });
    }),
  );

  return r;
}
