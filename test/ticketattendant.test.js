import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TicketAttendantClient,
  TicketAttendantMarketplace,
  parseGridXml,
  parseLooseJson,
  parseMoney,
} from '../src/marketplaces/ticketattendant.js';

test('parses dhtmlx loose JSON (unquoted keys) from event-search-sr', () => {
  const txt = `{"total_count":1,"pos":0,"rows":[{ id:1,userdata:{TAEventId:"019b9e0b"}, data:["","<a href='x'>+</a>","<img/>","Bruno Mars","Falcon Stadium","09/26/26 Sat","07:00 PM","0","0","0","0","0","160227629","0","","160227629","2224"]}]}`;
  const d = parseLooseJson(txt);
  assert.equal(d.rows[0].userdata.TAEventId, '019b9e0b');
  assert.equal(d.rows[0].data[3], 'Bruno Mars');
});

test('parses StubHub market grid XML including price colour', () => {
  const xml = `<?xml version="1.0" ?> <rows><row><cell>2</cell><cell>u 9</cell><cell>n</cell><cell><![CDATA[$<font color="white">207.00</font>]]></cell></row><row><cell>4</cell><cell>u 9</cell><cell>t</cell><cell><![CDATA[$<font color="green">210.00</font>]]></cell></row></rows>`;
  const rows = parseGridXml(xml);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].cells.map((c) => c.text), ['2', 'u 9', 'n', '$207.00']);
  assert.equal(rows[0].cells[3].color, 'white');
  assert.equal(rows[1].cells[3].color, 'green');
  assert.equal(parseMoney('$1,207.50'), 1207.5);
  assert.equal(parseMoney(''), null);
});

test('parses inventory grid XML with row userdata', () => {
  const xml = `<rows><row id="7"><userdata name="TAInventoryId"><![CDATA[abc-123]]></userdata><cell>0</cell><cell>x</cell></row></rows>`;
  const rows = parseGridXml(xml);
  assert.equal(rows[0].id, '7');
  assert.equal(rows[0].userdata.TAInventoryId, 'abc-123');
  assert.equal(rows[0].cells.length, 2);
});

function fakeFetchFactory(handlers) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\//, '');
    calls.push({ path, init, url: u });
    const h = handlers[path];
    if (!h) return new Response('not found', { status: 404 });
    return h(u, init, calls);
  };
  return { fetch, calls };
}

const jsonRes = (body, extra = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', ...extra } });

test('client logs in automatically when the session is gone and retries the call', async () => {
  let loggedIn = false;
  const { fetch, calls } = fakeFetchFactory({
    login: (u, init) => {
      if (init.method === 'POST') {
        const body = new URLSearchParams(init.body);
        assert.equal(body.get('UserName'), 'me@x.com');
        loggedIn = true;
        return new Response('', { status: 302, headers: { location: '/', 'set-cookie': '.ASPXAUTH=abc; path=/; HttpOnly' } });
      }
      return new Response('<form action="/login" method="post"></form>', { status: 200, headers: { 'content-type': 'text/html', 'set-cookie': 'ASP.NET_SessionId=s1; path=/' } });
    },
    'get-shdata': (u, init) => {
      if (!loggedIn || !/\.ASPXAUTH=abc/.test(init.headers.Cookie || '')) return new Response('', { status: 302, headers: { location: '/login?ReturnUrl=%2f' } });
      return jsonRes(['', '<rows></rows>', [], '', '', [], 0]);
    },
  });
  const saved = [];
  const client = new TicketAttendantClient({ baseUrl: 'https://ta.test', username: 'me@x.com', password: 'pw', fetch, onCookies: (c) => saved.push(c) });
  const data = await client.postJson('get-shdata', { a: 1 });
  assert.equal(data[6], 0);
  assert.ok(saved.some((c) => c.includes('.ASPXAUTH=abc')));
  assert.ok(calls.filter((c) => c.path === 'get-shdata').length >= 1);
});

test('marketplace maps events, inventory, market and price updates', async () => {
  const requests = [];
  const { fetch } = fakeFetchFactory({
    'event-search-sr': () =>
      new Response(
        `{"total_count":1,"pos":0,"rows":[{ id:1,userdata:{TAEventId:"guid"}, data:["","","","Bruno Mars","Falcon Stadium","09/26/26 Sat","07:00 PM","1","0","0","0","0","160227629","0","","160227629","2224"]}]}`,
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    'inventory-search-mt': async (u, init) => {
      requests.push(JSON.parse(init.body));
      const cells = new Array(55).fill('');
      cells[13] = 'L-1'; cells[19] = '2'; cells[20] = 'U 9'; cells[21] = 'N'; cells[22] = '1-2'; cells[23] = '$207.00'; cells[24] = '$230.00'; cells[27] = '$150.00'; cells[39] = 'SH-1';
      const xml = `<rows><row id="1"><userdata name="TAInventoryId"><![CDATA[ta-1]]></userdata>${cells.map((c) => `<cell><![CDATA[${c}]]></cell>`).join('')}</row></rows>`;
      return jsonRes([xml, '', '0', '0', '0', '1', '5', '0']);
    },
    'get-shdata': async (u, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      const rows = body.SectionNames?.length
        ? `<rows><row><cell>2</cell><cell>u 9</cell><cell>n</cell><cell><![CDATA[$<font color="white">207.00</font>]]></cell></row><row><cell>2</cell><cell>u 9</cell><cell>n</cell><cell><![CDATA[$<font color="white">230.00</font>]]></cell></row></rows>`
        : `<rows><row><cell>2</cell><cell>floor a</cell><cell>1</cell><cell><![CDATA[$<font color="white">900.00</font>]]></cell></row></rows>`;
      return jsonRes(['', rows, [], '', '', [{ SectionId: 0, Section: 'u 9', SellerOwnInd: true }, { SectionId: 0, Section: 'floor a', SellerOwnInd: false }], 693]);
    },
    'change-list-price': async (u, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      return jsonRes({ success: true, Items: [{ Listing_ID: 'L-1', Item_Price: Number(body.Item_Price), Item_Price_Original: 230 }], PayoutPercentage: 0.9 });
    },
  });
  const client = new TicketAttendantClient({ baseUrl: 'https://ta.test', cookie: '.ASPXAUTH=x', fetch });
  const mp = new TicketAttendantMarketplace(client, { maxMarketPages: 1 });

  const events = await mp.listEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].shEventId, '160227629');
  assert.equal(events[0].name, 'Bruno Mars');

  const event = { external_event_id: '160227629', sh_event_id: '160227629', venue_id: '2224', venue: 'Falcon Stadium' };
  const mine = await mp.getMyListings(event);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].listingId, 'L-1');
  assert.equal(mine[0].taInventoryId, 'ta-1');
  assert.equal(mine[0].shListingId, 'SH-1');
  assert.equal(mine[0].section, 'U 9');
  assert.equal(mine[0].price, 230);
  assert.equal(mine[0].cost, 150);

  const market = await mp.getMarketListings(event, { sections: ['U 9'], myListings: mine });
  assert.deepEqual(market.map((m) => m.price), [207, 230]);
  const sectionCall = requests.find((r) => r.SectionNames?.length);
  assert.deepEqual(sectionCall.SectionNames, ['u 9']);
  assert.deepEqual(sectionCall.SHListingIDs, ['SH-1']);

  const upd = await mp.updateListingPrice({ listing_id: 'L-1', ta_inventory_id: 'ta-1', sh_listing_id: 'SH-1', current_price: 230 }, 206);
  assert.equal(upd.price, 206);
  const priceCall = requests.find((r) => r.Item_Price);
  assert.equal(priceCall.Item_Price, '206.00');
  assert.equal(priceCall.Item_Price_Old, '230.00');
  assert.equal(priceCall.ListingIds, 'L-1');
  assert.equal(priceCall.SHListingIds, 'SH-1');
  assert.equal(priceCall.PriceOption, 0);
});

test('reads the broadcast flag from the grid and calls share-save the way the TA popup does', async () => {
  const requests = [];
  const { fetch } = fakeFetchFactory({
    'inventory-search-mt': async () => {
      const mk = (id, img) => {
        const cells = new Array(55).fill('');
        cells[8] = `<a href="#"><img src="Content/img/${img}" width="12"></a>`;
        cells[13] = id; cells[19] = '2'; cells[20] = '112'; cells[21] = 'A'; cells[24] = '$0.00'; cells[27] = '$80.00';
        return `<row id="${id}"><userdata name="TAInventoryId"><![CDATA[ta-${id}]]></userdata>${cells.map((c) => `<cell><![CDATA[${c}]]></cell>`).join('')}</row>`;
      };
      return jsonRes([`<rows>${mk('L-1', 'unbroadcast.png?20250903')}${mk('L-2', 'broadcast.png')}</rows>`, '', '0', '0', '0', '1', '5', '0']);
    },
    'share-save': async (u, init) => {
      requests.push(JSON.parse(init.body));
      return jsonRes({ success: true });
    },
  });
  const mp = new TicketAttendantMarketplace(new TicketAttendantClient({ baseUrl: 'https://ta.test', cookie: '.ASPXAUTH=x', fetch }));
  const mine = await mp.getMyListings({ external_event_id: '1', sh_event_id: '1' });
  assert.equal(mine[0].broadcast, false);
  assert.equal(mine[1].broadcast, true);
  assert.equal(mine[0].price, 0);
  await mp.broadcastListings([{ listing_id: 'L-1', ta_inventory_id: 'ta-L-1' }], { splits: '-1' });
  assert.deepEqual(requests[0], { taInventoryIds: ['ta-L-1'], listingIDs: 'L-1', splits_SH: '-1', splits_TN: 0, hide_SH: false, hide_TN: false });
});
