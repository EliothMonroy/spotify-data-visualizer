import { loadDataset, selectPlays, dayToISO, isoToDay, dayOfYMD, applyCreditMode } from './data.js';
import { groupStats, summarize, pickUnit } from './aggregate.js';
import { mount, disposeIn, renderTable } from './charts.js';
import { date, int, pct } from './format.js';
import { VIEWS } from './views.js';
import { artworkEnabled, setArtworkEnabled, hydrateArt } from './art.js';

const $ = (sel) => document.querySelector(sel);
const viewEl = $('#view');

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`sdv:${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(`sdv:${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

let D = null;
const filters = {
  period: store.get('period', 'all'),
  from: store.get('from', null),
  to: store.get('to', null),
  kind: store.get('kind', 'music'),
  minMs: store.get('minMs', 30000),
  credits: store.get('credits', 'all'),
};

// ---- theme ----
const THEMES = ['system', 'light', 'dark'];
function applyTheme(t) {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  $('#theme-toggle').title = `Theme: ${t}`;
}
applyTheme(store.get('theme', 'system'));
$('#theme-toggle').addEventListener('click', () => {
  const next = THEMES[(THEMES.indexOf(store.get('theme', 'system')) + 1) % THEMES.length];
  store.set('theme', next);
  applyTheme(next);
  render();
});
// ---- artwork toggle ----
function syncArtButton() {
  const on = artworkEnabled();
  $('#art-toggle').setAttribute('aria-pressed', String(on));
  $('#art-toggle').title = on ? 'Artwork on (looked up on Deezer, iTunes, TheAudioDB)' : 'Artwork off';
}
$('#art-toggle').addEventListener('click', () => {
  setArtworkEnabled(!artworkEnabled());
  syncArtButton();
  render();
});
syncArtButton();

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => render());

// ---- routing: #/view/param1/param2 ----
function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const view = VIEWS[parts[0]] ? parts[0] : 'overview';
  return { view, params: parts.slice(1) };
}
export function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}
window.addEventListener('hashchange', () => { render(); window.scrollTo({ top: 0 }); });

// ---- filters ----
function periodRange() {
  if (filters.period === 'all') return [D.minDay, D.maxDay];
  if (filters.period === 'last12') return [D.maxDay - 364, D.maxDay];
  if (filters.period === 'custom') {
    const from = filters.from ? isoToDay(filters.from) : D.minDay;
    const to = filters.to ? isoToDay(filters.to) : D.maxDay;
    return [Math.min(from, to), Math.max(from, to)];
  }
  const y = Number(filters.period);
  return [dayOfYMD(y, 0, 1), dayOfYMD(y, 11, 31)];
}

function setupFilters() {
  const years = [];
  for (let y = D.year[D.n - 1]; y >= D.year[0]; y--) years.push(y);
  const period = $('#f-period');
  const opts = [['all', 'All time'], ['last12', 'Last 12 months'], ...years.map((y) => [String(y), String(y)]), ['custom', 'Custom range…']];
  period.replaceChildren(...opts.map(([v, l]) => new Option(l, v)));
  if (!opts.some(([v]) => v === filters.period)) filters.period = 'all';
  period.value = filters.period;
  $('#f-kind').value = filters.kind;
  $('#f-min').value = String(filters.minMs);
  if (!['all', 'first'].includes(filters.credits)) filters.credits = 'all';
  $('#f-credits').value = filters.credits;
  if (D.creditMode !== filters.credits) applyCreditMode(D, filters.credits);
  $('#f-from').min = $('#f-to').min = dayToISO(D.minDay);
  $('#f-from').max = $('#f-to').max = dayToISO(D.maxDay);
  $('#f-from').value = filters.from ?? dayToISO(D.minDay);
  $('#f-to').value = filters.to ?? dayToISO(D.maxDay);
  $('#custom-range').hidden = filters.period !== 'custom';

  const update = () => {
    filters.period = period.value;
    filters.kind = $('#f-kind').value;
    filters.minMs = Number($('#f-min').value);
    if ($('#f-credits').value !== filters.credits) {
      filters.credits = $('#f-credits').value;
      applyCreditMode(D, filters.credits);
    }
    filters.from = $('#f-from').value || null;
    filters.to = $('#f-to').value || null;
    $('#custom-range').hidden = filters.period !== 'custom';
    for (const k of Object.keys(filters)) store.set(k, filters[k]);
    selection = null;
    viewEl.classList.add('is-busy');
    requestAnimationFrame(() => setTimeout(render, 0));
  };
  $('#filters').addEventListener('change', update);
}

// ---- selection cache ----
let selection = null;
function currentSelection() {
  if (selection) return selection;
  const [fromDay, toDay] = periodRange();
  const idx = selectPlays(D, { fromDay, toDay, kind: filters.kind });
  const groups = {};
  selection = {
    fromDay, toDay, idx,
    kind: filters.kind,
    minMs: filters.minMs,
    unit: pickUnit(fromDay, toDay),
    summary: summarize(D, idx, filters.minMs),
    group: (by) => (groups[by] ??= groupStats(D, idx, filters.minMs, by)),
    memo: {},
  };
  return selection;
}

// ---- rendering ----
function mountCard(card) {
  const el = document.getElementById(card.id);
  if (!el) return;
  const chartEl = el.querySelector('.chart');
  const tableEl = el.querySelector('.table-wrap');
  if (chartEl && card.option) {
    const option = card.option();
    if (option._height) chartEl.style.height = `${option._height}px`;
    delete option._height;
    mount(chartEl, option);
    if (card.onClick) echarts.getInstanceByDom(chartEl).on('click', card.onClick);
  }
  if (tableEl && card.table && !chartEl) renderTable(tableEl, card.table());
  const toggle = el.querySelector('[data-toggle-table]');
  if (toggle && chartEl) {
    toggle.addEventListener('click', () => {
      const showTable = tableEl.hidden;
      tableEl.hidden = !showTable;
      chartEl.hidden = showTable;
      toggle.textContent = showTable ? 'Chart' : 'Table';
      toggle.setAttribute('aria-pressed', String(showTable));
      if (showTable) renderTable(tableEl, card.table());
      else echarts.getInstanceByDom(chartEl)?.resize();
    });
  }
}

function render() {
  if (!D) return;
  const { view, params } = route();
  document.querySelectorAll('.tabs a').forEach((a) => {
    if (a.dataset.view === view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const sel = currentSelection();
  $('#range-label').textContent = sel.idx.length
    ? `${date(sel.summary.firstDay)} – ${date(sel.summary.lastDay)}`
    : 'No plays in this period';

  disposeIn(viewEl);
  viewEl.classList.remove('is-busy');
  if (!sel.idx.length) {
    viewEl.innerHTML = '<div class="state-msg">No plays match these filters. Try a different period or content type.</div>';
    return;
  }
  const out = VIEWS[view]({ D, sel, params, go });
  viewEl.innerHTML = out.html;
  out.cards.forEach(mountCard);
  out.after?.(viewEl);
  hydrateArt(viewEl);
  syncArtButton();
}

async function start() {
  try {
    D = await loadDataset();
  } catch (err) {
    viewEl.innerHTML = err.message === 'missing-data'
      ? `<div class="state-msg"><p><b>Your dataset hasn't been built yet.</b></p>
         <p>Put your export in <code>Spotify Extended Streaming History/</code>, then run <code>npm run import</code> and reload.</p></div>`
      : `<div class="state-msg">Something went wrong loading your data: ${String(err.message).replace(/</g, '&lt;')}</div>`;
    $('#range-label').textContent = '';
    return;
  }
  setupFilters();
  showCreditsStatus();
  render();
}

function showCreditsStatus() {
  const c = D.creditsInfo;
  const el = $('#credits-status');
  if (!c || !c.checked) return;
  el.textContent = `Artist credits checked on Deezer for ${int(c.checked)} of ${int(c.total)} tracks (${pct(c.playsCovered / Math.max(1, c.playsTotal))} of plays).`;
  el.hidden = false;
}

start();
