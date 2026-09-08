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

## How it avoids undercutting itself

Three layers, all of which have to miss before one of your own listings could be mistaken for a rival:

1. **Ticket Attendant's own flag.** Every market request includes your StubHub and POS listing ids, so
   rows Ticket Attendant knows are yours come back marked and are dropped.
2. **Fingerprint match.** Any market row whose section, row, quantity **and** price equal one of your
   listings is treated as yours. This is checked at the listing's current price *and* at every price
   the app set in the last hour, because StubHub's copy of the market can lag a few minutes behind a
   change you just made. Without this, a stale copy of your own listing at its old price could look
   like a competitor and start a ping-pong.
3. **Your listings never compete with each other; they are laddered.** If you hold several listings in
   the same section, the first one is priced $1 under the cheapest *other* seller and each additional
   one goes a fixed step (default $1) under the previous one, so they sell in a predictable order and
   never chase each other down. The order is the **Sell order** field on each listing (lowest number
   sells first); when you leave it blank the cheaper-cost listing leads. Each listing still keeps its
   own floor. Turn the stagger off in Rules if you would rather have them tie at the same price.

Two things you should also know: the floor stops the "always $1 under" rule from following a competitor
below what you allow, and the app never moves a price by more than what the market justifies in one
step, so a bad market read cannot produce a $1 listing. Set a **ceiling** if you also want to cap how
far it follows the market *up*.

## Cooldown after a change

After the app changes a listing it leaves that listing alone for a while (default **10 minutes**,
"After changing a listing, leave it alone for…" in Rules). StubHub and the other exchanges take a few
minutes to pick up a change from Ticket Attendant, and repricing again inside that window would react
to a market that still shows your *old* price. During the cooldown the dashboard shows what the
listing *wants* to move to and when it is allowed; the market is still read every cycle. Other
listings are not affected by one listing's cooldown.

## Which price is compared

Ticket Attendant's StubHub panel (`get-shdata`) reports what competing sellers **listed at, before
StubHub's buyer fees**: the same number you see on StubHub with *"Show prices without fees"* switched
on, and the same basis as the gross price you set on your own listing. So "$1 under" means $1 under the
other seller's list price, and the buyer sees the same fee percentage added to both. If you want to
double-check, open the event on StubHub with fees hidden and compare the section low with the
*Market by section* panel in the dashboard.

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

## Logging in (authenticator)

Ticket Attendant asks for an authenticator code after your password. The app handles that three ways;
pick whichever suits you:

| Option | How | When you have to do something |
| --- | --- | --- |
| **Code in the dashboard** (default) | Put `TA_USERNAME` / `TA_PASSWORD` in `.env` (or type them in the dashboard). The app posts them, sees the authenticator page, and shows a *"enter your code"* box at the top of the dashboard. Type the 6 digits from your app. | Once per login. The app logs in with *"keep me signed in for 2 weeks"* and stores the session, so this is roughly once every two weeks, and the dashboard turns red and pauses repricing until you do. |
| **Automatic codes** | Put the secret behind your authenticator app in `.env` as `TA_TOTP_SECRET` (the base32 string shown when you set up the authenticator, or the `otpauth://` URL from the QR code — many apps let you export it, or ask Ticket Attendant support to reset it and copy the new one). | Never. The app generates the same codes your phone does and logs itself back in whenever the session expires. |
| **Paste a cookie** | Log in normally in your browser with *keep me signed in* ticked, copy the `.ASPXAUTH` / `ASP.NET_SessionId` cookies, and paste them into the dashboard (or `TA_COOKIE` in `.env`). | Whenever that browser session expires (about two weeks if you ticked keep me signed in, otherwise within a day). |

While the app is waiting for a code it pauses repricing and logs that once; nothing else is touched.
As soon as you log in it runs a check immediately. Sessions are stored in the local database, so
restarting the app does not need a new code.

## Using the dashboard

* **Add an event** – paste the StubHub event link (e.g. `https://www.stubhub.com/…/event/160227629/`).
  The event is matched to your Ticket Attendant inventory by StubHub event id and repricing starts.
  "Refresh events" imports every event in your account instead; they come in switched off, flip
  **Repricing** on the ones you want managed.
* **Per listing** – set a **Floor** (required, pre-filled), an optional **Ceiling**, an optional
  per-listing **Undercut** that overrides the global amount, and a **Sell order** for sections where you
  hold more than one listing. **Pause** stops one listing without
  affecting the rest. The status column tells you whether you are currently the lowest in the section.
* **Rules** – undercut amount, how often to check, the cooldown after a change, staggering of your own
  listings, dry run, quantity matching, whole dollars, how new listings get their floor, and whether
  new listings start repricing automatically.
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
| `TA_TOTP_SECRET` | Optional: your authenticator secret, so the app answers the code prompt itself (see *Logging in*). |
| `TA_COOKIE` | Optional fallback: a browser `Cookie` header (`.ASPXAUTH=…; ASP.NET_SessionId=…`). |
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
  Passwords typed into the dashboard are kept in memory only; the session cookie is what gets saved.

## Development

```bash
npm test          # unit + integration tests (pricing rules, link parsing, connector parsing, engine)
npm run dev       # restart on file changes
```

Layout:

```
src/pricing.js                     pure repricing rules (no I/O)
src/engine.js                      the loop: sync listings → read market → decide → push
src/marketplaces/ticketattendant.js Ticket Attendant Terminal connector (login + authenticator, parsing, endpoints)
src/marketplaces/totp.js           authenticator (TOTP) code generation
src/marketplaces/mock.js           simulated market for trying things out
src/db.js                          SQLite storage (node:sqlite, no native build needed)
src/routes.js, src/index.js        REST API + static dashboard server
public/                            the dashboard
test/                              node:test suites
```
