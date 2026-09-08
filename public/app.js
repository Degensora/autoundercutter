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
  return el && (el.tagName === 'INPUT' || el.tagName === 'SELECT') && el.closest('#events, #settingsForm, #addEventForm');
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
  pillEngine.textContent = !auth ? 'Not logged in' : engine.cycleInProgress ? 'Checking…' : settings.autoRun ? 'Auto' : 'Paused';
  pillEngine.className = `pill ${!auth ? 'bad' : settings.autoRun ? 'on' : ''}`;
  const sum = engine.lastCycleSummary;
  $('#lastCycle').textContent = engine.lastCycleAt
    ? `Last check ${fmtAgo(engine.lastCycleAt)} · ${sum.listings} listings, ${sum.changed} changed${sum.errors ? `, ${sum.errors} errors` : ''}`
    : 'No check yet';

  if (mode !== 'mock' && !marketplace.hasSession && !marketplace.canLogin) {
    showAlert('Not logged in to Ticket Attendant. Set TA_USERNAME and TA_PASSWORD in .env and restart.');
  } else showAlert(null);

  if (!settingsDirty && !editingSomething()) {
    const f = $('#settingsForm');
    for (const [k, v] of Object.entries(settings)) {
      const el = f.elements[k];
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = Boolean(v);
      else el.value = v;
    }
    f.elements.defaultFloorPercent.disabled = settings.defaultFloorMode !== 'percent';
  }

  if (!editingSomething()) renderEvents(events, settings);
  renderLog(log);
}

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
      tbody.innerHTML = `<tr><td colspan="12" class="empty">${ev.external_event_id ? 'No open listings for this event in your inventory.' : 'Not matched to your inventory yet.'}</td></tr>`;
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
        <td><span class="st ${cls}">${esc(text)}</span></td>
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
