/**
 * Pure repricing logic. No I/O here so it is easy to test.
 *
 * Rules, in order:
 *   1. Find competing listings in the same section (never your own listings).
 *   2. Target = lowest competitor - undercut (default $1).
 *      No competitors -> stay at ceiling / current / start price.
 *   3. Optional: round down to whole dollars.
 *   4. Never above the ceiling (if one is set).
 *   5. Never below the floor. The floor always wins.
 *   6. If raisePrices is off, never move a price up.
 *
 * Several of my own listings in one section are "staggered": the first is priced against the market,
 * each next one goes `staggerAmount` below the previous (anchorPrice), so they sell in a known order and
 * never leapfrog each other. The floor still wins for each listing individually.
 */

const SECTION_PREFIX = /^(section|sect|sec)(?=[^a-z]|$)\.?\s*/i;

export function normalizeSection(raw) {
  if (raw == null) return '';
  let s = String(raw).trim().toLowerCase();
  s = s.replace(SECTION_PREFIX, '');
  // Marketplaces write the same section many ways: "U 9", "u9", "Sec U-9", "Section 112", "112".
  // Compare on letters+digits only, with leading zeros dropped from digit runs.
  s = s.replace(/[^a-z0-9]+/g, '');
  s = s.replace(/\d+/g, (d) => String(parseInt(d, 10)));
  return s;
}

export function sectionsMatch(a, b) {
  const na = normalizeSection(a);
  const nb = normalizeSection(b);
  return na !== '' && na === nb;
}

/** Can this competitor sell exactly `quantity` tickets to a buyer? */
export function competitorCanSell(competitor, quantity) {
  const q = Number(quantity);
  if (!q) return true;
  if (Array.isArray(competitor.splits) && competitor.splits.length) {
    return competitor.splits.map(Number).includes(q);
  }
  const have = Number(competitor.quantity);
  return Number.isFinite(have) ? have >= q : true;
}

/**
 * @param listing        my listing ({ section, quantity, ... })
 * @param marketListings everything currently on the market for the event
 * @param opts.ownListingIds  ids of my own marketplace listings (never compete with yourself)
 * @param opts.compareQuantity only count competitors that could sell my quantity
 * @returns competitors sorted cheapest first
 */
export function findCompetitors(listing, marketListings, opts = {}) {
  const own =
    opts.ownListingIds instanceof Set
      ? opts.ownListingIds
      : new Set((opts.ownListingIds || []).map(String));
  return (marketListings || [])
    .filter((m) => {
      if (!m) return false;
      const price = Number(m.price);
      if (!(price > 0)) return false;
      if (m.isMine) return false;
      if (m.id != null && own.has(String(m.id))) return false;
      if (!sectionsMatch(m.section, listing.section)) return false;
      if (opts.compareQuantity && !competitorCanSell(m, listing.quantity)) return false;
      return true;
    })
    .sort((a, b) => Number(a.price) - Number(b.price));
}

export function roundMoney(n) {
  return Math.round(Number(n) * 100) / 100;
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Decide what my listing's price should be right now.
 * @returns {{ price:number, reason:string, marketLow:number|null, competitorId:any, changed:boolean, current:number|null, undercut:number, isLowest:boolean }}
 */
export function computeTargetPrice({ listing, competitors, settings = {}, anchorPrice = null, fallbackPrice = null }) {
  const undercut = num(listing.undercut_amount) ?? num(settings.undercutAmount) ?? 1;
  const stagger = num(settings.staggerAmount) ?? 1;
  const floor = num(listing.floor_price) ?? 0;
  const ceiling = num(listing.ceiling_price);
  let current = num(listing.current_price) ?? num(listing.start_price);
  if (!(current > 0)) current = null; // an unpriced ($0) listing has no "current" price to hold
  const lowest = competitors && competitors.length ? competitors[0] : null;
  const marketLow = lowest ? Number(lowest.price) : null;

  let target;
  let reason;
  if (lowest) {
    target = marketLow - undercut;
    reason = 'undercut';
  } else {
    target = ceiling ?? current ?? num(fallbackPrice) ?? floor;
    reason = 'no_competition';
  }

  // Another of my listings in this section is already going to `anchorPrice`: sit just under it.
  const anchor = num(anchorPrice);
  if (anchor != null) {
    const staggered = anchor - stagger;
    if (!lowest || staggered < target) {
      target = staggered;
      reason = 'stagger';
    }
  }

  if (settings.wholeDollars) target = Math.floor(target);

  if (ceiling != null && target > ceiling) {
    target = ceiling;
    if (lowest) reason = 'ceiling';
  }
  if (target < floor) {
    target = floor;
    reason = 'floor';
  }
  if (settings.raisePrices === false && current != null && target > current) {
    target = current;
    reason = 'hold';
  }

  target = roundMoney(target);
  const changed = current == null || Math.abs(target - current) >= 0.005;
  const isLowest = marketLow == null || target < marketLow;

  return {
    price: target,
    reason,
    marketLow,
    competitorId: lowest ? lowest.id ?? null : null,
    changed,
    current,
    undercut,
    isLowest,
    anchorPrice: anchor,
  };
}

/** Human readable explanation of a decision, used in the log and the dashboard. */
export function describeDecision(decision) {
  const $ = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);
  switch (decision.reason) {
    case 'undercut':
      return `Lowest competitor ${$(decision.marketLow)} → listing at ${$(decision.price)} (${$(decision.undercut)} under)`;
    case 'floor':
      return decision.marketLow == null
        ? `At floor ${$(decision.price)}`
        : `At floor ${$(decision.price)}; competitor at ${$(decision.marketLow)} is too cheap to beat`;
    case 'ceiling':
      return `Capped at ceiling ${$(decision.price)} (competitor low ${$(decision.marketLow)})`;
    case 'no_competition':
      return `No other listings in section → holding at ${$(decision.price)}`;
    case 'stagger':
      return `Staggered under my other listing at ${$(decision.anchorPrice)} → ${$(decision.price)}${decision.marketLow != null ? ` (next competitor ${$(decision.marketLow)})` : ''}`;
    case 'hold':
      return `Competitors moved up (low ${$(decision.marketLow)}) but raising is off → holding at ${$(decision.price)}`;
    default:
      return `Price ${$(decision.price)}`;
  }
}
