# AutoUndercutter

Keeps every ticket listing you have in **Ticket Attendant Terminal** priced **$1 under the lowest
competing StubHub listing in the same section**, and re-checks the market every couple of minutes so
you stay the cheapest in the section as prices move. Ticket Attendant then pushes the new price out
to StubHub and your other exchanges the same way it does when you edit a price by hand.

You add events by pasting their StubHub link. Everything you already have in Ticket Attendant for that
event is picked up automatically.

```
 StubHub market (via Ticket Attendant)  ──▶  AutoUndercutter  ──▶  change price in Ticket Attendant
   "u 9: lowest competitor $207"               $207 − $1 = $206        ──▶ StubHub / Vivid / SeatGeek…
```

## How it prices

For each of your open listings, every check:

1. Pull every StubHub listing for the event in your listing's **section** (your own listings are excluded).
2. Target price = **lowest competitor − undercut** (default `$1.00`).
3. If nobody else is in the section, hold the current price (or your ceiling if you set one).
4. Never go **below the floor** you set. If a competitor is under your floor you sit at the floor and the
   dashboard tells you so.
5. Never go **above the ceiling** if you set one.
6. If competitors move *up*, follow them up (still $1 under) so you are not leaving money on the table.
   Turn "Follow the market up" off if you never want a price raised.
7. Only push a change when the price actually changes.

A brand-new listing gets a floor automatically so nothing sells for less than you meant. The default is
**your cost** from Ticket Attendant (falls back to the current price when there is no cost); you can
change that rule and edit each floor in the dashboard.

## Quick start

Requirements: Node.js 22.13 or newer.

```bash
npm install
cp .env.example .env      # fill in TA_USERNAME / TA_PASSWORD
npm start                 # open http://localhost:3000
```

The app starts in **dry run** when connected to a real account: it logs exactly what it *would* change
without touching anything. Watch the Activity panel for a few cycles, then untick "Dry run" in Rules
when you are happy.

Without Ticket Attendant credentials it starts against a **simulated market** so you can try it safely.

## Using the dashboard

* **Add an event** – paste the StubHub event link (e.g. `https://www.stubhub.com/…/event/160227629/`).
  The event is matched to your Ticket Attendant inventory by StubHub event id and repricing starts.
  "Refresh events" imports every event in your account instead; they come in switched off, flip
  **Repricing** on the ones you want managed.
* **Per listing** – set a **Floor** (required, pre-filled), an optional **Ceiling**, and an optional
  per-listing **Undercut** that overrides the global amount. **Pause** stops one listing without
  affecting the rest. The status column tells you whether you are currently the lowest in the section.
* **Rules** – undercut amount, how often to check, dry run, quantity matching, whole dollars, how new
  listings get their floor, and whether new listings start repricing automatically.
* **Market by section** – what the app saw on the last check (lowest competitor, median, count).
* **Activity** – every price change and why, plus anything that went wrong.

Listings that disappear from Ticket Attendant (sold / removed) are marked gone and left alone.
If you change a price by hand in Ticket Attendant the app notices and simply continues from there.

## Configuration

All configuration lives in `.env` (see `.env.example`).

| Variable | Meaning |
| --- | --- |
| `MARKETPLACE` | `ticketattendant` (real account) or `mock` (simulation). Defaults to `ticketattendant` when TA credentials are present. |
| `TA_USERNAME`, `TA_PASSWORD` | Your Ticket Attendant Terminal login. The app logs in with "keep me signed in" and re-logs in automatically when the session expires. |
| `TA_COOKIE` | Optional fallback: a browser `Cookie` header (`.ASPXAUTH=…; ASP.NET_SessionId=…`). Sessions expire within a day, so prefer username/password. |
| `TA_BASE_URL` | Defaults to `https://terminal.ticketattendant.com`. |
| `TA_MAX_MARKET_PAGES` | StubHub rows come 50 per page, cheapest first; pages read per section (default 2). |
| `PORT`, `DATA_DIR` | Web port (3000) and where the SQLite database lives (`./data`). |

Rules changed in the dashboard are stored in the database and survive restarts.

## How it talks to Ticket Attendant

The connector (`src/marketplaces/ticketattendant.js`) uses the same JSON endpoints the Ticket Attendant
web app itself uses, with your normal login:

| Endpoint | Used for |
| --- | --- |
| `event-search-sr` | your events with their StubHub event ids |
| `inventory-search-mt` | your open listings for an event (listing id, section, row, qty, gross price, cost) |
| `get-shdata` | every StubHub listing for the event, filtered to a section, cheapest first |
| `change-list-price` | change the gross price of one listing (TA syncs it to the exchanges) |

Prices are compared on the same basis Ticket Attendant shows in its own StubHub panel (the listing
price, before StubHub's buyer fees), so "$1 under" means $1 under what the competing seller listed.

If Ticket Attendant changes its front end, the column positions in `INVENTORY_COLUMNS` /
`EVENT_COLUMNS` at the top of the connector are the first place to look.

## Safety

* Dry run is on by default for real accounts.
* A floor is mandatory and is pre-filled from your cost. The floor always wins over the undercut rule.
* Turning dry run off in the dashboard asks you to confirm.
* Nothing is ever created or deleted on the marketplace; the app only changes prices of listings that
  already exist in Ticket Attendant.
* Your login and session cookies stay in `.env` and the local database (`data/`), both git-ignored.

## Development

```bash
npm test          # unit + integration tests (pricing rules, link parsing, connector parsing, engine)
npm run dev       # restart on file changes
```

Layout:

```
src/pricing.js                     pure repricing rules (no I/O)
src/engine.js                      the loop: sync listings → read market → decide → push
src/marketplaces/ticketattendant.js Ticket Attendant Terminal connector (login, parsing, endpoints)
src/marketplaces/mock.js           simulated market for trying things out
src/db.js                          SQLite storage (node:sqlite, no native build needed)
src/routes.js, src/index.js        REST API + static dashboard server
public/                            the dashboard
test/                              node:test suites
```
