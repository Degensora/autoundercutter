import path from 'node:path';

function env(name, fallback = undefined) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

const hasTaCreds = Boolean((env('TA_USERNAME') && env('TA_PASSWORD')) || env('TA_COOKIE'));

export const config = {
  port: Number(env('PORT', 3000)),
  dataDir: path.resolve(env('DATA_DIR', './data')),
  /** 'ticketattendant' talks to your real Ticket Attendant Terminal account; 'mock' is a simulated market. */
  marketplace: String(env('MARKETPLACE', hasTaCreds ? 'ticketattendant' : 'mock')).toLowerCase(),
  mock: {
    volatility: Number(env('MOCK_VOLATILITY', 0.25)),
  },
  ticketAttendant: {
    baseUrl: String(env('TA_BASE_URL', 'https://terminal.ticketattendant.com')).replace(/\/+$/, ''),
    username: env('TA_USERNAME'),
    password: env('TA_PASSWORD'),
    /** Optional: a raw Cookie header value copied from the browser, e.g. ".ASPXAUTH=...; ASP.NET_SessionId=..." */
    cookie: env('TA_COOKIE'),
    /** Optional: the base32 secret (or otpauth:// URL) behind your authenticator app, for fully automatic logins. */
    totpSecret: env('TA_TOTP_SECRET'),
    userAgent: env(
      'TA_USER_AGENT',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
    ),
    /** StubHub market rows come back 50 per page; how many pages to read per section. */
    maxMarketPages: Number(env('TA_MAX_MARKET_PAGES', 2)),
    requestTimeoutMs: Number(env('TA_TIMEOUT_MS', 30000)),
  },
};

/** Settings the user can change from the dashboard. Stored in the database. */
export const DEFAULT_SETTINGS = {
  undercutAmount: 1.0,        // dollars below the lowest competing listing in the section
  pollIntervalSec: 120,       // how often to re-check the market
  autoRun: true,              // run the repricing loop automatically
  dryRun: config.marketplace !== 'mock', // log what would happen instead of pushing price changes
  compareQuantity: false,     // only compete with listings that could sell the same quantity as mine
  raisePrices: true,          // if competitors move up, follow them up (still $1 under)
  staggerOwnListings: true,   // several of my listings in one section: ladder them instead of tying
  staggerAmount: 1.0,         // dollars between each of my listings in the same section
  repriceCooldownSec: 600,    // after changing a listing, leave it alone for this long (StubHub needs time to sync)
  wholeDollars: false,        // round prices down to whole dollars
  autoEnrollListings: true,   // new listings found on an enabled event start repricing automatically
  defaultFloorMode: 'cost',   // 'cost' | 'current' | 'percent' — how the floor is set for new listings
  defaultFloorPercent: 80,    // used when defaultFloorMode = 'percent' (percent of the current price)
  currency: 'USD',
};
