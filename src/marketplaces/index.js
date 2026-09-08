import { MockMarketplace } from './mock.js';
import { TicketAttendantClient, TicketAttendantMarketplace } from './ticketattendant.js';

/**
 * Build the marketplace connector selected by config.
 * @param {import('../config.js').config} config
 * @param {{ db?: any, log?: (level:string, msg:string)=>void }} deps
 */
export function createMarketplace(config, { db, log = () => {} } = {}) {
  if (config.marketplace === 'ticketattendant') {
    const ta = config.ticketAttendant;
    const saved = db?.getInternal?.('taCookies');
    const client = new TicketAttendantClient({
      baseUrl: ta.baseUrl,
      username: ta.username,
      password: ta.password,
      cookie: ta.cookie || saved || undefined,
      totpSecret: ta.totpSecret,
      userAgent: ta.userAgent,
      timeoutMs: ta.requestTimeoutMs,
      onCookies: (header) => {
        // keep the session across restarts (stored locally in the sqlite file, never committed)
        try {
          db?.setInternal?.('taCookies', header);
        } catch {
          /* ignore */
        }
      },
    });
    return new TicketAttendantMarketplace(client, { maxMarketPages: ta.maxMarketPages, log });
  }
  if (config.marketplace === 'mock') return new MockMarketplace({ volatility: config.mock.volatility });
  throw new Error(`Unknown MARKETPLACE "${config.marketplace}". Use "ticketattendant" or "mock".`);
}
