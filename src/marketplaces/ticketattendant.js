/**
 * Connector for Ticket Attendant Terminal (terminal.ticketattendant.com).
 *
 * Ticket Attendant is the point-of-sale that syndicates your inventory to StubHub and the other
 * exchanges, so price changes are pushed there and TA propagates them. This module talks to the same
 * JSON endpoints the TA web app uses:
 *
 *   GET  event-search-sr        -> your events (with StubHub event ids)
 *   POST inventory-search-mt    -> your listings for one event
 *   POST get-shdata             -> every StubHub listing for the event (qty / section / row / price)
 *   POST change-list-price      -> change the gross (list) price of one of your listings
 *
 * Auth is the normal TA login form (username + password, "keep me signed in"), with an optional
 * pre-baked cookie header as a fallback. The session is re-established automatically when it expires.
 */

// Column layout of the event-inventory grid for TA accounts on POS type 3/4/5 (SkyBox-style grid).
// Taken from the TA front end (gridEventHeader). Only the columns we use are named here.
export const INVENTORY_COLUMNS = {
  listingId: 13,
  event: 14,
  eventDate: 15,
  eventTime: 16,
  venue: 17,
  shownQuantity: 18,
  quantity: 19,
  section: 20,
  row: 21,
  seats: 22,
  netPrice: 23,
  grossPrice: 24,
  costUsd: 26,
  cost: 27,
  stockType: 28,
  itemId: 37,
  venueId: 38,
  shListingId: 39,
  splitOption: 48,
};

// Column layout of the events grid (event-search-sr).
export const EVENT_COLUMNS = {
  name: 3,
  venue: 4,
  date: 5,
  time: 6,
  open: 7,
  reserved: 8,
  sold: 9,
  eventId: 12,
  category: 14,
  shEventId: 15,
  venueId: 16,
};

// get-shdata rows: Qty, Sec, Row, Price
export const MARKET_COLUMNS = { quantity: 0, section: 1, row: 2, price: 3 };

export class TicketAttendantAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TicketAttendantAuthError';
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#160': ' ' };

export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code in ENTITIES) return ENTITIES[code];
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return m;
  });
}

function stripCdata(s) {
  return String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

/** "$<font color="white">207.00</font>" -> { text: "$207.00", color: "white" } */
function cellInfo(rawCell) {
  const inner = stripCdata(rawCell);
  const color = inner.match(/color\s*=\s*['"]?([#\w]+)/i)?.[1]?.toLowerCase() ?? null;
  const text = decodeEntities(inner.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  return { text, color };
}

export function parseMoney(text) {
  if (text == null) return null;
  const cleaned = String(text).replace(/[^0-9.\-]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a dhtmlx grid XML string into rows.
 * @returns {{ id: string|null, userdata: Record<string,string>, cells: {text:string,color:string|null}[] }[]}
 */
export function parseGridXml(xml) {
  const out = [];
  if (!xml) return out;
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let m;
  while ((m = rowRe.exec(xml))) {
    const attrs = m[1];
    const body = m[2];
    const id = attrs.match(/\bid\s*=\s*"([^"]*)"/)?.[1] ?? null;
    const userdata = {};
    const udRe = /<userdata\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/userdata>/g;
    let u;
    while ((u = udRe.exec(body))) userdata[u[1]] = decodeEntities(stripCdata(u[2]).trim());
    const cells = [];
    const cellRe = /<cell\b[^>]*>([\s\S]*?)<\/cell>|<cell\b[^>]*\/>/g;
    let c;
    while ((c = cellRe.exec(body))) cells.push(cellInfo(c[1] ?? ''));
    out.push({ id, userdata, cells });
  }
  return out;
}

/** dhtmlx "json" is not strict JSON: keys are unquoted (`{ id:1, userdata:{...}, data:[...] }`). */
export function parseLooseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const fixed = String(text).replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
    return JSON.parse(fixed);
  }
}

class CookieJar {
  constructor(initial) {
    this.cookies = new Map();
    if (initial) this.setFromHeader(initial);
  }
  setFromHeader(header) {
    for (const part of String(header).split(/;\s*/)) {
      const i = part.indexOf('=');
      if (i > 0) this.cookies.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
  }
  absorb(setCookieHeaders = []) {
    for (const sc of setCookieHeaders) {
      const first = sc.split(';')[0];
      const i = first.indexOf('=');
      if (i <= 0) continue;
      const name = first.slice(0, i).trim();
      const value = first.slice(i + 1).trim();
      if (value === '' || /expires=Thu, 01-Jan-1970/i.test(sc)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  has(name) {
    return this.cookies.has(name);
  }
  clear() {
    this.cookies.clear();
  }
}

export class TicketAttendantClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl
   * @param {string} [opts.username]
   * @param {string} [opts.password]
   * @param {string} [opts.cookie]        raw Cookie header to start with
   * @param {string} [opts.userAgent]
   * @param {number} [opts.timeoutMs]
   * @param {(cookieHeader:string)=>void} [opts.onCookies]  called whenever the session cookies change (persist them)
   * @param {typeof fetch} [opts.fetch]
   */
  constructor(opts) {
    this.baseUrl = String(opts.baseUrl || 'https://terminal.ticketattendant.com').replace(/\/+$/, '');
    this.username = opts.username || null;
    this.password = opts.password || null;
    this.userAgent = opts.userAgent || 'Mozilla/5.0';
    this.timeoutMs = opts.timeoutMs || 30000;
    this.jar = new CookieJar(opts.cookie);
    this.onCookies = opts.onCookies || (() => {});
    this.fetch = opts.fetch || globalThis.fetch.bind(globalThis);
    this.lastLoginAt = null;
    this.loginPromise = null;
  }

  get canLogin() {
    return Boolean(this.username && this.password);
  }

  status() {
    return {
      baseUrl: this.baseUrl,
      hasSession: this.jar.has('.ASPXAUTH'),
      canLogin: this.canLogin,
      username: this.username,
      lastLoginAt: this.lastLoginAt,
    };
  }

  async _fetch(url, init = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const headers = {
        'User-Agent': this.userAgent,
        Accept: 'application/json, text/javascript, */*; q=0.01',
        ...(init.headers || {}),
      };
      const cookie = this.jar.header();
      if (cookie) headers.Cookie = cookie;
      const res = await this.fetch(url, { ...init, headers, redirect: 'manual', signal: ctrl.signal });
      const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      if (setCookies.length) {
        this.jar.absorb(setCookies);
        this.onCookies(this.jar.header());
      }
      return res;
    } finally {
      clearTimeout(t);
    }
  }

  /** Log in with username/password. Safe to call concurrently. */
  async login() {
    if (!this.canLogin) throw new TicketAttendantAuthError('Ticket Attendant session expired and no TA_USERNAME / TA_PASSWORD is configured.');
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = (async () => {
      this.jar.clear();
      // Prime the ASP.NET session cookie and pick up any anti-forgery token on the form.
      const page = await this._fetch(`${this.baseUrl}/login?ReturnUrl=%2f`, { headers: { Accept: 'text/html' } });
      const html = await page.text();
      const token = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)?.[1];
      const form = new URLSearchParams();
      form.set('UserName', this.username);
      form.set('Password', this.password);
      form.append('KeepSignedIn', 'true');
      form.append('KeepSignedIn', 'false');
      if (token) form.set('__RequestVerificationToken', token);
      const res = await this._fetch(`${this.baseUrl}/login?ReturnUrl=%2f`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html', Referer: `${this.baseUrl}/login` },
        body: form.toString(),
      });
      if (!this.jar.has('.ASPXAUTH')) {
        const body = await res.text().catch(() => '');
        const hint = body.match(/validation-summary-errors[\s\S]*?<li>([^<]+)</)?.[1] || body.match(/<div[^>]*class="[^"]*alert[^"]*"[^>]*>([^<]+)</)?.[1];
        throw new TicketAttendantAuthError(`Ticket Attendant login failed${hint ? `: ${hint.trim()}` : ` (HTTP ${res.status})`}. Check TA_USERNAME / TA_PASSWORD.`);
      }
      this.lastLoginAt = new Date().toISOString();
      this.onCookies(this.jar.header());
    })();
    try {
      return await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  static _looksLoggedOut(res) {
    if (res.status === 401 || res.status === 403) return true;
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') || '';
      return /login/i.test(loc);
    }
    return false;
  }

  /** POST JSON to a TA endpoint and return the parsed body. Re-logs in once if the session is dead. */
  async postJson(path, body, { retry = true } = {}) {
    if (!this.jar.has('.ASPXAUTH') && this.canLogin) await this.login();
    const url = `${this.baseUrl}/${path.replace(/^\/+/, '')}`;
    const res = await this._fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `${this.baseUrl}/`,
        Origin: this.baseUrl,
      },
      body: JSON.stringify(body ?? {}),
    });
    return this._handle(res, () => this.postJson(path, body, { retry: false }), retry, path);
  }

  /** GET a TA endpoint with query params. */
  async getJson(path, params, { retry = true } = {}) {
    if (!this.jar.has('.ASPXAUTH') && this.canLogin) await this.login();
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) qs.set(k, String(v));
    const url = `${this.baseUrl}/${path.replace(/^\/+/, '')}${qs.toString() ? `?${qs}` : ''}`;
    const res = await this._fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: `${this.baseUrl}/` } });
    return this._handle(res, () => this.getJson(path, params, { retry: false }), retry, path);
  }

  async _handle(res, retryFn, retry, path) {
    if (TicketAttendantClient._looksLoggedOut(res)) {
      if (retry && this.canLogin) {
        await this.login();
        return retryFn();
      }
      throw new TicketAttendantAuthError('Ticket Attendant session expired. Log in again (set TA_USERNAME / TA_PASSWORD, or refresh TA_COOKIE).');
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Ticket Attendant ${path} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    const ct = res.headers.get('content-type') || '';
    if (/text\/html/i.test(ct) && /<form[^>]+login/i.test(text)) {
      if (retry && this.canLogin) {
        await this.login();
        return retryFn();
      }
      throw new TicketAttendantAuthError('Ticket Attendant returned the login page. Session expired.');
    }
    try {
      return parseLooseJson(text);
    } catch (e) {
      throw new Error(`Ticket Attendant ${path} returned something that is not JSON: ${text.slice(0, 200)}`);
    }
  }
}

/* --------------------------------------------------------------------------------------------- */

const EMPTY_FILTERS = {
  Category_ID: -1, Category_ID_TU: -1, Headliner_ID: -1, Headliner_ID_TU: -1,
  Event_FromDate: '', Event_ToDate: '', Text: '', City: '', Venue_Name: '', State: '', Section: '', Row: '', ListingId: '',
  StockType: '', SortColumn: '', SortDirection: '', SortColumnNumber: '',
  Open: 0, Sold: 0, Reserved: 0, Expired: 0, SoldOut: 0, Unshared: 0, HardTickets: 0, ETickets: 0, NotInHand: 0, ZeroPrice: 0,
  ShowPostponedEvents: null, Version: '3',
};

export class TicketAttendantMarketplace {
  /**
   * @param {TicketAttendantClient} client
   * @param {{ maxMarketPages?: number, log?: (level:string, msg:string)=>void }} [opts]
   */
  constructor(client, opts = {}) {
    this.name = 'ticketattendant';
    this.label = 'Ticket Attendant Terminal';
    this.client = client;
    this.maxMarketPages = Math.max(1, Number(opts.maxMarketPages) || 2);
    this.log = opts.log || (() => {});
    this.supportsCreate = false;
  }

  status() {
    return { name: this.name, label: this.label, ...this.client.status() };
  }

  /** All events in the account (open inventory or not). */
  async listEvents() {
    const data = await this.client.getJson('event-search-sr', { ...EMPTY_FILTERS, Event_ID: -1, Venue_ID: -1, Purchase_FromDate: '', Purchase_ToDate: '', pageSize: 500 });
    const rows = data?.rows || [];
    return rows
      .map((r) => {
        const d = r.data || [];
        const cell = (i) => decodeEntities(String(d[i] ?? '').replace(/<[^>]+>/g, '')).trim();
        return {
          externalEventId: cell(EVENT_COLUMNS.eventId) || null,
          taEventId: r.userdata?.TAEventId ?? null,
          shEventId: cell(EVENT_COLUMNS.shEventId) || null,
          name: cell(EVENT_COLUMNS.name),
          venue: cell(EVENT_COLUMNS.venue),
          venueId: cell(EVENT_COLUMNS.venueId) || null,
          dateText: cell(EVENT_COLUMNS.date),
          timeText: cell(EVENT_COLUMNS.time),
          openCount: Number(cell(EVENT_COLUMNS.open)) || 0,
          soldCount: Number(cell(EVENT_COLUMNS.sold)) || 0,
        };
      })
      .filter((e) => e.externalEventId);
  }

  async findEventBySHId(shEventId) {
    const events = await this.listEvents();
    return events.find((e) => String(e.shEventId) === String(shEventId)) || null;
  }

  /**
   * My open listings for one event.
   * @param {{external_event_id:string, sh_event_id?:string, venue_id?:string}} event
   */
  async getMyListings(event) {
    const listings = [];
    const pageSize = 100;
    for (let page = 1; page <= 20; page++) {
      const body = {
        ...EMPTY_FILTERS,
        PageNumber: page,
        PageSize: String(pageSize),
        Event_ID: String(event.external_event_id),
        Venue_ID: event.venue_id ?? -1,
        External_Notes: '', Internal_Notes: '', Tags: '', PurchaseExternalRef: '', ClientAccountIds: [],
        PO_FromDate: '', PO_ToDate: '',
        AllActiveSHListings: false, AllSoldSHListings: false, QualifiedActiveSHListings: false, QualifiedSoldSHListings: false,
        SHEventID: event.sh_event_id ?? '',
        Event_ID_TU: String(event.external_event_id),
        Venue_ID_TU: event.venue_id ?? '',
        ShowSHData: 0,
        ClientId: null,
      };
      const data = await this.client.postJson('inventory-search-mt', body);
      if (data && data.success === false) throw new Error(data.message || 'inventory-search-mt failed');
      const rows = parseGridXml(Array.isArray(data) ? data[0] : data?.inventory);
      for (const r of rows) {
        const c = (i) => r.cells[i]?.text ?? '';
        const listingId = c(INVENTORY_COLUMNS.listingId);
        if (!listingId) continue;
        listings.push({
          listingId,
          taInventoryId: r.userdata.TAInventoryId ?? null,
          ticketGroupId: r.userdata.TicketGroupId ?? null,
          shListingId: c(INVENTORY_COLUMNS.shListingId) || null,
          itemId: c(INVENTORY_COLUMNS.itemId) || null,
          section: c(INVENTORY_COLUMNS.section),
          row: c(INVENTORY_COLUMNS.row),
          seats: c(INVENTORY_COLUMNS.seats),
          quantity: Number(c(INVENTORY_COLUMNS.quantity)) || null,
          shownQuantity: Number(c(INVENTORY_COLUMNS.shownQuantity)) || null,
          price: parseMoney(c(INVENTORY_COLUMNS.grossPrice)),
          netPrice: parseMoney(c(INVENTORY_COLUMNS.netPrice)),
          cost: parseMoney(c(INVENTORY_COLUMNS.cost)) ?? parseMoney(c(INVENTORY_COLUMNS.costUsd)),
          raw: r.cells.map((x) => x.text),
        });
      }
      if (rows.length < pageSize) break;
    }
    return listings;
  }

  /** Every StubHub listing for the event in the given sections (or whole event when no sections). */
  async getMarketListings(event, { sections = [], myListings = [], compareQuantity = false } = {}) {
    const base = {
      PageSize: 50,
      Section: '', Row: '', QuantityFilter: '',
      Zones: [], ZoneNames: [], SectionIds: [], SectionNames: [],
      SortColumnNumber: '3', SortColumn: 'Price', SortDirection: 'asc',
      Event_ID_TU: String(event.external_event_id),
      SHEventID: String(event.sh_event_id),
      Venue_ID: event.venue_id ?? '', Venue_ID_TU: event.venue_id ?? '', Venue: event.venue ?? '',
      SHListingIDs: myListings.map((l) => l.sh_listing_id ?? l.shListingId).filter(Boolean),
      TUListingIDs: myListings.map((l) => l.listing_id ?? l.listingId).filter(Boolean),
      ClientSections: [],
      SaveSearches: false,
      Version: '3',
    };

    const first = await this.client.postJson('get-shdata', { ...base, PageNumber: 1 });
    if (first && first.success === false) throw new Error(first.message || 'get-shdata failed');
    const availableSections = Array.isArray(first[5]) ? first[5] : [];
    const total = Number(first[6]) || 0;

    const out = [];
    const pushRows = (data, target = out) => {
      for (const r of parseGridXml(data[1])) {
        const c = (i) => r.cells[i];
        const price = parseMoney(c(MARKET_COLUMNS.price)?.text);
        if (!(price > 0)) continue;
        const color = c(MARKET_COLUMNS.price)?.color;
        target.push({
          quantity: Number(c(MARKET_COLUMNS.quantity)?.text) || null,
          section: c(MARKET_COLUMNS.section)?.text ?? '',
          row: c(MARKET_COLUMNS.row)?.text ?? '',
          price,
          // TA renders competitor prices white; a different colour marks a listing the server knows is ours.
          isMine: Boolean(color && color !== 'white'),
        });
      }
    };

    // Ask the server for just the sections we care about (it can return up to 50 sorted rows per page).
    const { normalizeSection } = await import('../pricing.js');
    const wanted = new Set(sections.map(normalizeSection).filter(Boolean));
    const matched = availableSections.filter((s) => wanted.has(normalizeSection(s.Section)));

    if (!wanted.size || (!matched.length && total <= 50)) {
      pushRows(first);
      return out;
    }

    const targets = matched.length ? matched : [...wanted].map((s) => ({ Section: s, SectionId: 0 }));
    for (const s of targets) {
      const quantities = compareQuantity
        ? [...new Set(myListings.filter((l) => normalizeSection(l.section) === normalizeSection(s.Section)).map((l) => Number(l.quantity)))].filter(Boolean)
        : [null];
      const sectionRows = [];
      for (const q of quantities) {
        for (let page = 1; page <= this.maxMarketPages; page++) {
          const data = await this.client.postJson('get-shdata', {
            ...base,
            PageNumber: page,
            SectionIds: [String(s.SectionId ?? 0)],
            SectionNames: [s.Section],
            QuantityFilter: q == null ? '' : q >= 5 ? '5+' : String(q),
          });
          if (data && data.success === false) throw new Error(data.message || 'get-shdata failed');
          const before = sectionRows.length;
          pushRows(data, sectionRows);
          if (sectionRows.length - before < 50) break;
        }
      }
      if (quantities.length > 1) {
        // The same listing can match several quantity filters (a 4-pack sells 2 or 4): drop exact repeats.
        const seen = new Set();
        for (const r of sectionRows) {
          const k = `${r.section}|${r.row}|${r.quantity}|${r.price}|${r.isMine}`;
          if (seen.has(k)) continue;
          seen.add(k);
          out.push(r);
        }
      } else out.push(...sectionRows);
    }
    return out;
  }

  /**
   * Change the gross (list) price of one of my listings. TA pushes the change to StubHub & co.
   * @param {{listing_id:string, ta_inventory_id?:string, sh_listing_id?:string, current_price?:number}} listing
   */
  async updateListingPrice(listing, newPrice) {
    const price = Number(newPrice);
    if (!(price > 0)) throw new Error(`Refusing to set a non-positive price (${newPrice})`);
    const body = {
      Item_Price: price.toFixed(2),
      Item_Price_Old: listing.current_price != null ? Number(listing.current_price).toFixed(2) : '',
      TAInventoryIds: listing.ta_inventory_id ?? '',
      ListingIds: String(listing.listing_id),
      SHListingIds: listing.sh_listing_id ?? '',
      PriceOption: 0,
      Client: null,
    };
    const data = await this.client.postJson('change-list-price', body);
    if (!data || data.success === false) throw new Error(data?.message || 'change-list-price failed');
    const item = Array.isArray(data.Items) ? data.Items.find((i) => String(i.Listing_ID) === String(listing.listing_id)) || data.Items[0] : null;
    return {
      price: item?.Item_Price != null ? Number(item.Item_Price) : price,
      previousPrice: item?.Item_Price_Original != null ? Number(item.Item_Price_Original) : listing.current_price ?? null,
      payoutPercentage: data.PayoutPercentage ?? null,
      warning: data.WarningMessage ?? null,
    };
  }
}
