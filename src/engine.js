import { computeTargetPrice, describeDecision, findCompetitors, normalizeSection, roundMoney } from './pricing.js';

const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);

/** Decide the starting floor for a listing we have never seen before. */
export function defaultFloor(listing, settings) {
  const current = Number(listing.price) || 0;
  const cost = Number(listing.cost) || 0;
  switch (settings.defaultFloorMode) {
    case 'cost':
      return roundMoney(cost > 0 ? cost : current);
    case 'percent':
      return roundMoney((current * (Number(settings.defaultFloorPercent) || 100)) / 100);
    case 'current':
    default:
      return roundMoney(current);
  }
}

/**
 * The repricing loop. Reads inventory from the marketplace connector, reads the StubHub market,
 * decides a price per listing (see pricing.js) and pushes changes back.
 */
export class Engine {
  constructor({ db, marketplace, logger = console }) {
    this.db = db;
    this.marketplace = marketplace;
    this.logger = logger;
    this.timer = null;
    this.running = false;
    this.cycleInProgress = false;
    this.lastCycleAt = null;
    this.lastCycleSummary = null;
    this.nextRunAt = null;
    this.authBlocked = false; // true while the marketplace needs a human (authenticator code / login)
  }

  log(level, message, ctx = {}) {
    this.db.log(level, message, ctx);
    const fn = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
    this.logger[fn](`[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`);
  }

  status() {
    return {
      running: this.running,
      cycleInProgress: this.cycleInProgress,
      lastCycleAt: this.lastCycleAt,
      lastCycleSummary: this.lastCycleSummary,
      nextRunAt: this.nextRunAt,
      authBlocked: this.authBlocked,
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._schedule(1500);
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
  }

  _schedule(delayMs) {
    if (this.timer) clearTimeout(this.timer);
    this.nextRunAt = new Date(Date.now() + delayMs).toISOString();
    this.timer = setTimeout(() => this._tick(), delayMs);
  }

  async _tick() {
    this.timer = null;
    try {
      const settings = this.db.getSettings();
      if (settings.autoRun) await this.runCycle();
    } catch (err) {
      this.log('error', `Cycle failed: ${err.message}`);
    } finally {
      if (this.running) {
        const sec = Math.max(15, Number(this.db.getSettings().pollIntervalSec) || 60);
        this._schedule(sec * 1000);
      }
    }
  }

  /** Import the marketplace's event list into the local database (disabled by default). */
  async syncEvents() {
    const events = await this.marketplace.listEvents();
    let added = 0;
    for (const ev of events) {
      const existing = (ev.shEventId && this.db.getEventBySHId(ev.shEventId)) || this.db.getEventByExternalId(ev.externalEventId);
      const patch = {
        external_event_id: ev.externalEventId,
        ta_event_id: ev.taEventId ?? null,
        sh_event_id: ev.shEventId ?? null,
        name: ev.name,
        venue: ev.venue,
        venue_id: ev.venueId ?? null,
        event_date: ev.dateText,
        event_time: ev.timeText,
        stubhub_url: ev.shEventId ? `https://www.stubhub.com/event/${ev.shEventId}/` : null,
        last_synced_at: new Date().toISOString(),
      };
      if (existing) this.db.updateEvent(existing.id, patch);
      else {
        this.db.insertEvent({ ...patch, source: 'sync', enabled: 0 });
        added++;
      }
    }
    this.log('info', `Synced ${events.length} events from ${this.marketplace.label} (${added} new)`);
    return { total: events.length, added };
  }

  /** Run one repricing pass over every enabled event (or one event). */
  async runCycle({ eventId = null, force = false } = {}) {
    if (this.cycleInProgress) return { skipped: 'busy' };
    this.cycleInProgress = true;
    const started = Date.now();
    const summary = { events: 0, listings: 0, changed: 0, errors: 0, dryRun: false, startedAt: new Date().toISOString() };
    try {
      const settings = this.db.getSettings();
      summary.dryRun = Boolean(settings.dryRun);
      if (this.authBlocked && !force) {
        const st = this.marketplace.status();
        if (st.authState && st.authState !== 'ok') return { skipped: 'auth', authState: st.authState };
        this.authBlocked = false;
        this.log('info', 'Marketplace login restored — repricing resumes');
      }
      const events = eventId ? [this.db.getEvent(eventId)].filter(Boolean) : this.db.listEvents({ enabledOnly: true });
      for (const event of events) {
        if (!event.enabled && !force) continue;
        summary.events++;
        try {
          const r = await this.processEvent(event, settings);
          summary.listings += r.listings;
          summary.changed += r.changed;
          summary.errors += r.errors;
          this.db.updateEvent(event.id, { last_synced_at: new Date().toISOString(), last_error: null });
        } catch (err) {
          summary.errors++;
          this.db.updateEvent(event.id, { last_error: err.message });
          if (err.name === 'TicketAttendantAuthError') {
            if (!this.authBlocked) this.log('error', `Paused: ${err.message}`, { eventId: event.id });
            this.authBlocked = true;
            break; // no point hammering the other events until someone logs in
          }
          this.log('error', `${event.name}: ${err.message}`, { eventId: event.id });
        }
      }
      summary.durationMs = Date.now() - started;
      this.lastCycleAt = new Date().toISOString();
      this.lastCycleSummary = summary;
      return summary;
    } finally {
      this.cycleInProgress = false;
    }
  }

  /** Pull my listings for the event from the marketplace and reconcile with the local table. */
  async syncListings(event, settings) {
    const remote = await this.marketplace.getMyListings(event);
    const local = this.db.listListings(event.id, { includeGone: true });
    const seen = new Set();
    for (const r of remote) {
      seen.add(String(r.listingId));
      const existing = local.find((l) => String(l.listing_id) === String(r.listingId));
      const base = {
        ta_inventory_id: r.taInventoryId ?? null,
        ticket_group_id: r.ticketGroupId ?? null,
        sh_listing_id: r.shListingId ?? null,
        item_id: r.itemId ?? null,
        section: r.section ?? '',
        row: r.row ?? '',
        seats: r.seats ?? '',
        quantity: r.quantity ?? null,
        cost: r.cost ?? null,
        current_price: r.price ?? null,
        net_price: r.netPrice ?? null,
      };
      if (existing) {
        const patch = { ...base };
        if (existing.status === 'gone') {
          patch.status = 'active';
          patch.gone_since = null;
          this.log('info', `Listing ${r.listingId} (${r.section} row ${r.row}) is back on ${event.name}`, { eventId: event.id, listingId: existing.id });
        }
        if (existing.current_price != null && r.price != null && Math.abs(existing.current_price - r.price) >= 0.005) {
          this.log('info', `Listing ${r.listingId} price changed outside this app: ${money(existing.current_price)} → ${money(r.price)}`, { eventId: event.id, listingId: existing.id });
        }
        this.db.updateListing(existing.id, patch);
      } else {
        const floor = defaultFloor(r, settings);
        const row = this.db.insertListing({
          ...base,
          event_id: event.id,
          listing_id: r.listingId,
          status: settings.autoEnrollListings ? 'active' : 'paused',
          floor_price: floor,
        });
        this.log(
          'info',
          `New listing on ${event.name}: sec ${r.section} row ${r.row} x${r.quantity} at ${money(r.price)} — floor set to ${money(floor)} (${settings.defaultFloorMode})${settings.autoEnrollListings ? '' : ', paused until you enable it'}`,
          { eventId: event.id, listingId: row.id },
        );
      }
    }
    for (const l of local) {
      if (l.status !== 'gone' && !seen.has(String(l.listing_id))) {
        this.db.updateListing(l.id, { status: 'gone', gone_since: new Date().toISOString() });
        this.log('info', `Listing ${l.listing_id} (sec ${l.section} row ${l.row}) is no longer open on ${event.name} — sold or removed`, { eventId: event.id, listingId: l.id });
      }
    }
    return this.db.listListings(event.id);
  }

  async processEvent(event, settings = this.db.getSettings()) {
    const result = { listings: 0, changed: 0, errors: 0 };
    const listings = await this.syncListings(event, settings);
    const active = listings.filter((l) => l.status === 'active');
    if (!listings.length) return result;

    const sections = [...new Set(listings.map((l) => l.section).filter(Boolean))];
    const market = await this.marketplace.getMarketListings(event, {
      sections,
      myListings: listings,
      compareQuantity: Boolean(settings.compareQuantity),
    });

    // Never treat one of our own listings as a competitor. The connector flags what it can; on top of
    // that we match the (section, row, quantity, price) fingerprint of each of our listings — at its
    // current price AND at every price we set in the last hour, because the exchange's copy of the market
    // can lag a few minutes behind a change we just made.
    const fingerprints = new Set();
    const fp = (section, row, qty, price) => `${normalizeSection(section)}|${String(row ?? '').trim().toLowerCase()}|${qty}|${Number(price).toFixed(2)}`;
    const recentCutoff = Date.now() - 60 * 60 * 1000;
    for (const l of listings) {
      fingerprints.add(fp(l.section, l.row, l.quantity, l.current_price));
      for (const h of this.db.listHistory(l.id, 20)) {
        if (new Date(h.created_at).getTime() < recentCutoff) break;
        if (h.old_price != null) fingerprints.add(fp(l.section, l.row, l.quantity, h.old_price));
        if (h.new_price != null) fingerprints.add(fp(l.section, l.row, l.quantity, h.new_price));
      }
    }
    for (const m of market) {
      if (fingerprints.has(fp(m.section, m.row, m.quantity, m.price))) m.isMine = true;
    }
    this.db.saveSnapshot(event.id, market);

    // Group my listings by section so several in one section can be laddered (see pricing.js).
    const groups = new Map();
    for (const l of active) {
      const key = normalizeSection(l.section) || `#${l.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(l);
    }
    const asc = (a, b) => (a == null) - (b == null) || a - b; // nulls last
    for (const group of groups.values()) {
      group.sort((a, b) => asc(a.sell_order, b.sell_order) || asc(a.cost, b.cost) || a.id - b.id);
      let anchor = null;
      for (const listing of group) {
        const { appliedPrice } = await this.repriceListing(event, listing, market, settings, anchor, result);
        anchor = settings.staggerOwnListings ? appliedPrice : null;
      }
    }
    return result;
  }

  /**
   * Decide and (unless dry run) push the price for one listing.
   * Returns { decision, appliedPrice } where appliedPrice is what the listing is actually at afterwards.
   */
  async repriceListing(event, listing, market, settings, anchorPrice, result) {
    result.listings++;
    const competitors = findCompetitors(listing, market, { compareQuantity: settings.compareQuantity });
    const decision = computeTargetPrice({ listing, competitors, settings, anchorPrice });
    const now = new Date();
    const patch = {
      last_market_low: decision.marketLow,
      competitor_count: competitors.length,
      is_lowest: decision.isLowest ? 1 : 0,
      last_reason: decision.reason,
      last_checked_at: now.toISOString(),
      last_error: null,
      pending_price: null,
    };
    const label = `${event.name} · sec ${listing.section} row ${listing.row} x${listing.quantity}`;
    let appliedPrice = listing.current_price ?? decision.price;

    // Cooldown: a listing we changed recently is left alone so the exchanges can catch up.
    const cooldownMs = Math.max(0, Number(settings.repriceCooldownSec) || 0) * 1000;
    const lastChange = listing.last_price_change_at ? new Date(listing.last_price_change_at).getTime() : 0;
    if (decision.changed && cooldownMs && now.getTime() - lastChange < cooldownMs) {
      patch.last_reason = 'cooldown';
      patch.pending_price = decision.price;
      patch.is_lowest = decision.marketLow == null || Number(listing.current_price) < decision.marketLow ? 1 : 0;
      this.db.updateListing(listing.id, patch);
      return { decision, appliedPrice };
    }

    try {
      if (decision.changed) {
        appliedPrice = decision.price;
        patch.last_price_change_at = now.toISOString();
        if (settings.dryRun) {
          this.log('info', `[dry run] ${label}: would change ${money(listing.current_price)} → ${money(decision.price)}. ${describeDecision(decision)}`, { eventId: event.id, listingId: listing.id });
          this.db.addHistory({ listingId: listing.id, oldPrice: listing.current_price, newPrice: decision.price, marketLow: decision.marketLow, reason: decision.reason, dryRun: true });
        } else {
          const res = await this.marketplace.updateListingPrice({ ...listing, external_event_id: event.external_event_id }, decision.price);
          patch.current_price = res.price ?? decision.price;
          this.db.addHistory({ listingId: listing.id, oldPrice: listing.current_price, newPrice: patch.current_price, marketLow: decision.marketLow, reason: decision.reason, dryRun: false });
          this.log('info', `${label}: ${money(listing.current_price)} → ${money(patch.current_price)}. ${describeDecision(decision)}${res.warning ? ` (marketplace warning: ${res.warning})` : ''}`, { eventId: event.id, listingId: listing.id });
        }
        result.changed++;
      }
    } catch (err) {
      result.errors++;
      patch.last_error = err.message;
      this.log('error', `${label}: price update failed — ${err.message}`, { eventId: event.id, listingId: listing.id });
      if (err.name === 'TicketAttendantAuthError') {
        this.db.updateListing(listing.id, patch);
        throw err;
      }
    }
    this.db.updateListing(listing.id, patch);
    return { decision, appliedPrice };
  }
}

