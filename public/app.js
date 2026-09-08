/* global document, fetch */
const $ = (sel, root = document) => root.querySelector(sel);
const money = (n) => (n == null || n === '' || Number.isNaN(Number(n)) ? '—' : `$${Number(n).toFixed(2)}`);
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const fmtAgo = (iso) => {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

let state = null;
let settingsDirty = false;

async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function editingSomething() {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'SELECT') && el.closest('#events, #settingsForm, #addEventForm, #authCard');
}

async function refresh() {
  try {
    state = await api('GET', '/state');
    render();
  } catch (err) {
    showAlert(`Cannot reach the AutoUndercutter server: ${err.message}`);
  }
}

function showAlert(msg) {
  const card = $('#alertCard');
  if (!msg) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $('#alertText').textContent = msg;
}

function render() {
  const { settings, engine, marketplace, mode, events, log } = state;

  $('#marketplaceLabel').textContent = `${marketplace.label}${marketplace.username ? ` · ${marketplace.username}` : ''}`;
  const pillMode = $('#pillMode');
  pillMode.textContent = mode === 'mock' ? 'Simulated market' : 'Live · Ticket Attendant';
  pillMode.className = `pill ${mode === 'mock' ? 'warn' : 'on'}`;
  const pillDry = $('#pillDry');
  pillDry.textContent = settings.dryRun ? 'Dry run' : 'Changing prices';
  pillDry.className = `pill ${settings.dryRun ? 'warn' : 'on'}`;
  const pillEngine = $('#pillEngine');
  const auth = marketplace.hasSession || mode === 'mock';
  const needsHuman = mode !== 'mock' && (marketplace.authState === 'needs_code' || !auth);
  pillEngine.textContent = needsHuman ? (marketplace.authState === 'needs_code' ? 'Needs auth code' : 'Not logged in') : engine.cycleInProgress ? 'Checking…' : settings.autoRun ? 'Auto' : 'Paused';
  pillEngine.className = `pill ${needsHuman ? 'bad' : settings.autoRun ? 'on' : ''}`;
  const sum = engine.lastCycleSummary;
  $('#lastCycle').textContent = engine.lastCycleAt
    ? `Last check ${fmtAgo(engine.lastCycleAt)} · ${sum.listings} listings, ${sum.changed} changed${sum.errors ? `, ${sum.errors} errors` : ''}`
    : 'No check yet';

  showAlert(null);
  renderAuth(marketplace, mode, engine);

  if (!settingsDirty && !editingSomething()) {
    const f = $('#settingsForm');
    for (const [k, v] of Object.entries(settings)) {
      const el = f.elements[k];
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = Boolean(v);
      else el.value = v;
    }
    f.elements.repriceCooldownMin.value = Math.round((settings.repriceCooldownSec || 0) / 60);
    f.elements.defaultFloorPercent.disabled = settings.defaultFloorMode !== 'percent';
  }

  if (!editingSomething()) renderEvents(events, settings);
  renderLog(log);
}

function renderAuth(mp, mode, engine) {
  const card = $('#authCard');
  if (mode === 'mock') {
    card.hidden = true;
    return;
  }
  const state = mp.authState || (mp.hasSession ? 'ok' : 'needs_credentials');
  const loggedIn = state === 'ok' && mp.hasSession;
  card.hidden = loggedIn && !authCardPinned;
  card.classList.toggle('ok', loggedIn);
  $('#loginForm').hidden = !(state === 'needs_credentials' || state === 'needs_login' || state === 'error' || (loggedIn && authCardPinned));
  $('#codeForm').hidden = state !== 'needs_code';
  const hint = $('#authHint');
  if (loggedIn) hint.textContent = `Logged in${mp.username ? ` as ${mp.username}` : ''}${mp.lastLoginAt ? ` (since ${fmtTime(mp.lastLoginAt)})` : ''}. The "keep me signed in" session lasts about two weeks; you will be asked for a new authenticator code when it expires.`;
  else if (state === 'needs_code') hint.textContent = `${mp.codePrompt || 'Ticket Attendant is asking for your authenticator code.'} Open your authenticator app and enter the current code.${engine.authBlocked ? ' Repricing is paused until you do.' : ''}`;
  else if (state === 'needs_login') hint.textContent = 'Session expired. Click "Log in" to sign in again with the saved username and password; you will then be asked for an authenticator code.';
  else if (state === 'error') hint.textContent = mp.authMessage || 'Login failed.';
  else hint.textContent = 'Not logged in to Ticket Attendant. Enter your login (or set TA_USERNAME / TA_PASSWORD in .env). Repricing is paused until you do.';
  if (mp.username && !$('#loginUser').value) $('#loginUser').value = mp.username;
  if (mp.canLogin) $('#loginPass').placeholder = 'Password (saved in .env — leave blank to use it)';
  if (mp.authMessage && state === 'needs_code') $('#authError').textContent = mp.authMessage.startsWith('Ticket Attendant is asking') ? '' : mp.authMessage;
}
let authCardPinned = false;

function statusFor(l, settings) {
  if (l.status === 'paused') return ['muted', 'Paused'];
  if (l.last_error) return ['bad', `Error: ${l.last_error}`];
  if (!l.last_checked_at) return ['muted', 'Waiting for first check'];
  const low = l.last_market_low;
  switch (l.last_reason) {
    case 'undercut':
      return ['good', `Lowest in section (next is ${money(low)})`];
    case 'floor':
      return low == null ? ['warn', 'Holding at floor'] : ['warn', `At floor — someone is at ${money(low)}, below what you allow`];
    case 'ceiling':
      return ['good', `At ceiling (next is ${money(low)})`];
    case 'no_competition':
      return ['good', 'No other listings in section'];
    case 'stagger':
      return ['good', `Staggered under my other listing${low != null ? ` (next competitor ${money(low)})` : ''}`];
    case 'cooldown': {
      const until = l.last_price_change_at ? new Date(new Date(l.last_price_change_at).getTime() + (settings.repriceCooldownSec || 0) * 1000) : null;
      return [l.is_lowest ? 'good' : 'warn', `Changed ${fmtAgo(l.last_price_change_at)} — wants ${money(l.pending_price)}${until ? `, allowed at ${fmtTime(until.toISOString())}` : ''}`];
    }
    case 'hold':
      return ['warn', `Holding — market rose to ${money(low)} but raising is off`];
    default:
      return ['muted', l.last_reason || ''];
  }
}

function renderEvents(events, settings) {
  const root = $('#events');
  root.innerHTML = '';
  if (!events.length) {
    root.innerHTML = '<div class="card empty">No events yet. Paste a StubHub link above, or click "Refresh events" to import your Ticket Attendant events.</div>';
    return;
  }
  const tpl = $('#eventTpl');
  for (const ev of events) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.classList.toggle('disabled', !ev.enabled);
    $('.ev-name', node).textContent = ev.name || `Event ${ev.sh_event_id}`;
    $('.ev-meta', node).textContent = [ev.event_date, ev.event_time, ev.venue, ev.sh_event_id ? `StubHub #${ev.sh_event_id}` : null, ev.last_synced_at ? `checked ${fmtAgo(ev.last_synced_at)}` : null]
      .filter(Boolean)
      .join(' · ');
    const link = $('.ev-link', node);
    if (ev.stubhub_url) link.href = ev.stubhub_url;
    else link.remove();
    $('.ev-enabled', node).checked = Boolean(ev.enabled);
    $('.ev-enabled', node).addEventListener('change', async (e) => {
      try {
        await api('PATCH', `/events/${ev.id}`, { enabled: e.target.checked });
        refresh();
      } catch (err) {
        alert(err.message);
      }
    });
    $('.ev-run', node).addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        await api('POST', `/events/${ev.id}/run`);
      } catch (err) {
        alert(err.message);
      }
      refresh();
    });
    $('.ev-remove', node).addEventListener('click', async () => {
      if (!confirm(`Remove "${ev.name}" from AutoUndercutter? Your listings on the marketplace are not touched.`)) return;
      await api('DELETE', `/events/${ev.id}`);
      refresh();
    });
    $('.ev-error', node).textContent = ev.last_error || '';

    const tbody = $('tbody', $('.listings', node));
    if (!ev.listings.length) {
      tbody.innerHTML = `<tr><td colspan="13" class="empty">${ev.external_event_id ? 'No open listings for this event in your inventory.' : 'Not matched to your inventory yet.'}</td></tr>`;
    }
    for (const l of ev.listings) {
      const tr = document.createElement('tr');
      const [cls, text] = statusFor(l, settings);
      const inp = (name, val, step = '0.01') => `<input type="number" step="${step}" min="0" data-listing="${l.id}" data-field="${name}" value="${val ?? ''}" placeholder="${name === 'undercut_amount' ? `$${settings.undercutAmount}` : '—'}" />`;
      tr.innerHTML = `
        <td>${esc(l.section)}</td><td>${esc(l.row)}</td><td>${esc(l.seats)}</td><td>${l.quantity ?? ''}</td>
        <td class="num">${money(l.cost)}</td>
        <td class="num"><strong>${money(l.current_price)}</strong></td>
        <td class="num">${money(l.last_market_low)}${l.competitor_count != null ? `<span class="muted"> (${l.competitor_count})</span>` : ''}</td>
        <td>${inp('floor_price', l.floor_price)}</td>
        <td>${inp('ceiling_price', l.ceiling_price)}</td>
        <td>${inp('undercut_amount', l.undercut_amount)}</td>
        <td>${inp('sell_order', l.sell_order, '1')}</td>
        <td><span class="st ${cls}">${esc(text)}</span>${l.broadcast === 0 ? ' <span class="st warn" title="Not on the exchanges yet">Not broadcast</span>' : ''}</td>
        <td><button class="btn small" data-toggle="${l.id}" data-status="${l.status}">${l.status === 'paused' ? 'Resume' : 'Pause'}</button></td>`;
      tbody.appendChild(tr);
    }
    tbody.addEventListener('change', async (e) => {
      const el = e.target;
      if (!el.dataset.listing) return;
      try {
        await api('PATCH', `/listings/${el.dataset.listing}`, { [el.dataset.field]: el.value === '' ? null : Number(el.value) });
        el.style.borderColor = '';
      } catch (err) {
        el.style.borderColor = 'var(--bad)';
        alert(err.message);
      }
      refresh();
    });
    tbody.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-toggle]');
      if (!btn) return;
      await api('PATCH', `/listings/${btn.dataset.toggle}`, { status: btn.dataset.status === 'paused' ? 'active' : 'paused' });
      refresh();
    });

    const mk = ev.market;
    $('.mk-meta', node).textContent = mk ? `· ${mk.total} StubHub listings fetched ${fmtAgo(mk.fetchedAt)}` : '· no market data yet';
    const mkBody = $('tbody', $('.mk', node));
    for (const s of mk?.sections || []) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${esc(s.section)}</td><td>${s.count}</td><td class="num">${money(s.low)}</td><td class="num">${money(s.median)}</td><td>${s.mine || ''}</td>`;
      mkBody.appendChild(tr);
    }
    root.appendChild(node);
  }
}

function renderLog(log) {
  const el = $('#log');
  el.innerHTML = log
    .map((e) => `<div class="${e.level}"><time>${fmtTime(e.created_at)}</time>${esc(e.message)}</div>`)
    .join('');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---- login wiring ----
async function authCall(path, body) {
  $('#authError').textContent = '';
  try {
    const r = await api('POST', path, body);
    if (r.needsCode) $('#loginCode').focus();
    await refresh();
    return r;
  } catch (err) {
    $('#authError').textContent = err.message;
    await refresh();
  }
}
$('#loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const username = $('#loginUser').value.trim();
  const password = $('#loginPass').value;
  authCall('/auth/login', password ? { username, password } : {});
  $('#loginPass').value = '';
});
$('#codeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  authCall('/auth/code', { code: $('#loginCode').value.trim() });
  $('#loginCode').value = '';
});
$('#btnRestartLogin').addEventListener('click', () => authCall('/auth/login', {}));
$('#cookieForm').addEventListener('submit', (e) => {
  e.preventDefault();
  authCall('/auth/cookie', { cookie: $('#cookieValue').value.trim() });
  $('#cookieValue').value = '';
});
$('#marketplaceLabel').addEventListener('click', () => {
  authCardPinned = !authCardPinned;
  refresh();
});

// ---- wiring ----
$('#addEventForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('#eventUrl').value.trim();
  $('#addEventError').textContent = '';
  try {
    const r = await api('POST', '/events', { url });
    $('#eventUrl').value = '';
    if (!r.matched) $('#addEventError').textContent = 'Added, but no inventory for this event was found in your marketplace account yet.';
    refresh();
  } catch (err) {
    $('#addEventError').textContent = err.message;
  }
});

$('#btnSyncEvents').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try {
    const r = await api('POST', '/events/sync');
    $('#addEventError').textContent = `Imported ${r.total} events (${r.added} new). Turn on "Repricing" on the ones you want managed.`;
  } catch (err) {
    $('#addEventError').textContent = err.message;
  }
  e.target.disabled = false;
  refresh();
});

$('#btnRunNow').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try {
    await api('POST', '/run');
  } catch (err) {
    alert(err.message);
  }
  e.target.disabled = false;
  refresh();
});

const settingsForm = $('#settingsForm');
settingsForm.addEventListener('input', () => {
  settingsDirty = true;
  settingsForm.elements.defaultFloorPercent.disabled = settingsForm.elements.defaultFloorMode.value !== 'percent';
});
settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = settingsForm.elements;
  const body = {
    undercutAmount: Number(f.undercutAmount.value),
    pollIntervalSec: Number(f.pollIntervalSec.value),
    defaultFloorMode: f.defaultFloorMode.value,
    defaultFloorPercent: Number(f.defaultFloorPercent.value),
    autoRun: f.autoRun.checked,
    dryRun: f.dryRun.checked,
    raisePrices: f.raisePrices.checked,
    compareQuantity: f.compareQuantity.checked,
    wholeDollars: f.wholeDollars.checked,
    autoEnrollListings: f.autoEnrollListings.checked,
    staggerOwnListings: f.staggerOwnListings.checked,
    staggerAmount: Number(f.staggerAmount.value),
    repriceCooldownSec: Math.round(Number(f.repriceCooldownMin.value) * 60),
    autoBroadcast: f.autoBroadcast.checked,
    broadcastSplits: f.broadcastSplits.value,
    newListingMarkupPercent: Number(f.newListingMarkupPercent.value),
  };
  if (!body.dryRun && state?.settings.dryRun && state.mode !== 'mock') {
    if (!confirm('Turn OFF dry run? AutoUndercutter will start changing real prices in Ticket Attendant, which syncs to StubHub and your other exchanges.')) return;
  }
  try {
    await api('PUT', '/settings', body);
    settingsDirty = false;
    $('#settingsSaved').textContent = `Saved ${fmtTime(new Date().toISOString())}`;
    refresh();
  } catch (err) {
    alert(err.message);
  }
});

refresh();
setInterval(refresh, 5000);
