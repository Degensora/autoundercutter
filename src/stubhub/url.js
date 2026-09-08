/**
 * Turn a StubHub event link into an event id + a best-effort name and date.
 *
 * Handles links like:
 *   https://www.stubhub.com/bruno-mars-colorado-springs-tickets-9-26-2026/event/160227629/
 *   https://www.stubhub.com/event/160227629?quantity=2
 *   https://www.stubhub.ca/some-slug/event/160227629/
 *   160227629                       (a bare event id)
 */

const STUBHUB_HOST =
  /(^|\.)stubhub\.(com|ca|co\.uk|de|fr|es|it|com\.au|ie|com\.mx|mx|nl|ch|at|be|pt|se|dk|fi|no|pl|jp|hk|sg|co\.nz|com\.br)$/i;

const KEEP_UPPER = new Set(['nyc', 'la', 'sf', 'dc', 'ufc', 'nba', 'nfl', 'nhl', 'mlb', 'mls', 'wwe', 'usa', 'uk']);
const KEEP_LOWER = new Set(['vs', 'at', 'and', 'the', 'of', 'in', 'on', 'de', 'del', 'with', 'feat']);

export function parseSlug(slug) {
  if (!slug) return { name: null, dateText: null };
  let s = String(slug).toLowerCase();
  let dateText = null;
  const dm = s.match(/-(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dm) {
    dateText = `${dm[1]}/${dm[2]}/${dm[3]}`;
    s = s.slice(0, dm.index);
  }
  s = s.replace(/-tickets(-.*)?$/, '');
  const words = s.split('-').filter(Boolean);
  const name = words
    .map((w, i) => {
      if (KEEP_UPPER.has(w)) return w.toUpperCase();
      if (i > 0 && KEEP_LOWER.has(w)) return w;
      return w[0].toUpperCase() + w.slice(1);
    })
    .join(' ');
  return { name: name || null, dateText };
}

export function parseStubHubUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Paste a StubHub event link.');

  if (/^\d{5,}$/.test(raw)) {
    return {
      eventId: raw,
      name: null,
      dateText: null,
      quantity: null,
      host: 'www.stubhub.com',
      url: `https://www.stubhub.com/event/${raw}/`,
    };
  }

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error('That does not look like a valid link.');
  }
  if (!STUBHUB_HOST.test(url.hostname)) {
    throw new Error(`That is not a StubHub link (${url.hostname}).`);
  }

  const parts = url.pathname.split('/').filter(Boolean);
  let eventId = null;
  const idx = parts.findIndex((p) => p.toLowerCase() === 'event');
  if (idx >= 0 && /^\d+$/.test(parts[idx + 1] || '')) eventId = parts[idx + 1];
  if (!eventId) {
    for (const key of ['event_id', 'eventId', 'eventid']) {
      const v = url.searchParams.get(key);
      if (v && /^\d+$/.test(v)) {
        eventId = v;
        break;
      }
    }
  }
  if (!eventId) {
    const numeric = parts.filter((p) => /^\d{5,}$/.test(p));
    if (numeric.length) eventId = numeric[numeric.length - 1];
  }
  if (!eventId) throw new Error('Could not find an event id in that link.');

  let slug = idx > 0 ? parts[idx - 1] : parts.find((p) => /-tickets(-|$)/.test(p)) || null;
  if (slug && /^\d+$/.test(slug)) slug = null;
  const { name, dateText } = parseSlug(slug);
  const quantity = Number(url.searchParams.get('quantity')) || null;

  return {
    eventId,
    name,
    dateText,
    quantity,
    host: url.hostname,
    url: `https://${url.hostname}/${slug ? `${slug}/` : ''}event/${eventId}/`,
  };
}

export function stubhubEventUrl(eventId) {
  return `https://www.stubhub.com/event/${eventId}/`;
}
