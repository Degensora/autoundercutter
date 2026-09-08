import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStubHubUrl } from '../src/stubhub/url.js';

test('parses a full StubHub event link', () => {
  const p = parseStubHubUrl('https://www.stubhub.com/bruno-mars-colorado-springs-tickets-9-26-2026/event/160227629/?quantity=2');
  assert.equal(p.eventId, '160227629');
  assert.equal(p.name, 'Bruno Mars Colorado Springs');
  assert.equal(p.dateText, '9/26/2026');
  assert.equal(p.quantity, 2);
  assert.equal(p.url, 'https://www.stubhub.com/bruno-mars-colorado-springs-tickets-9-26-2026/event/160227629/');
});

test('parses short links, other country sites and bare ids', () => {
  assert.equal(parseStubHubUrl('stubhub.com/event/160227629').eventId, '160227629');
  assert.equal(parseStubHubUrl('https://www.stubhub.ca/some-show-tickets-1-2-2027/event/123456789/').eventId, '123456789');
  assert.equal(parseStubHubUrl('160227629').eventId, '160227629');
  assert.equal(parseStubHubUrl('https://www.stubhub.com/checkout?eventId=160227629').eventId, '160227629');
});

test('rejects non-StubHub links and links without an event id', () => {
  assert.throws(() => parseStubHubUrl('https://www.vividseats.com/event/123'), /not a StubHub link/);
  assert.throws(() => parseStubHubUrl('https://www.stubhub.com/'), /Could not find an event id/);
  assert.throws(() => parseStubHubUrl(''), /Paste a StubHub/);
});
