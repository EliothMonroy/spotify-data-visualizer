// ECharts option builders that follow one visual system (thin marks, hairline grid,
// fixed categorical order, single-hue sequential ramp) and read colors from CSS tokens.
import { esc, int, compact, duration } from './format.js';

/* global echarts */

export function tokens() {
  const s = getComputedStyle(document.documentElement);
  const v = (name) => s.getPropertyValue(name).trim();
  return {
    surface: v('--surface'),
    text1: v('--text-1'),
    text2: v('--text-2'),
    muted: v('--muted'),
    grid: v('--grid'),
    axis: v('--axis'),
    border: v('--border'),
    font: v('--font'),
    series: Array.from({ length: 8 }, (_, i) => v(`--series-${i + 1}`)),
    seq: [100, 200, 300, 400, 500, 600, 700].map((n) => v(`--seq-${n}`)),
    seqEmpty: v('--seq-empty'),
  };
}

// ---- stable categorical colors: an entity keeps its slot while it stays on screen ----
const slotMemory = new Map();
export function assignSlots(scope, keys) {
  let mem = slotMemory.get(scope);
  if (!mem) slotMemory.set(scope, (mem = new Map()));
  const taken = new Set();
  const out = new Map();
  for (const k of keys) {
    const s = mem.get(k);
    if (s !== undefined && !taken.has(s)) { out.set(k, s); taken.add(s); }
  }
  for (const k of keys) {
    if (out.has(k)) continue;
    let s = 0;
    while (taken.has(s)) s++;
    out.set(k, s);
    taken.add(s);
    mem.set(k, s);
  }
  return out;
}

// ---- mounting ----
const observed = new WeakSet();
const resizer = new ResizeObserver((entries) => {
  for (const e of entries) echarts.getInstanceByDom(e.target)?.resize();
});

export function mount(el, option) {
  const chart = echarts.getInstanceByDom(el) ?? echarts.init(el, null, { renderer: 'canvas' });
  chart.setOption(option, true);
  if (!observed.has(el)) { resizer.observe(el); observed.add(el); }
  return chart;
}

export function disposeIn(root) {
  root.querySelectorAll('.chart').forEach((el) => {
    resizer.unobserve(el);
    observed.delete(el);
    echarts.getInstanceByDom(el)?.dispose();
  });
}

// ---- shared pieces ----
function base(T) {
  return {
    backgroundColor: 'transparent',
    textStyle: { fontFamily: T.font, color: T.text2 },
    animationDuration: 350,
    animationDurationUpdate: 250,
    grid: { left: 4, right: 16, top: 16, bottom: 4, containLabel: true },
    tooltip: {
      confine: true,
      backgroundColor: T.surface,
      borderColor: T.border,
      borderWidth: 1,
      padding: [8, 10],
      textStyle: { color: T.text1, fontSize: 12, fontFamily: T.font },
      extraCssText: 'border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.14);',
    },
  };
}

function valueAxis(T, fmt) {
  return {
    type: 'value',
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: T.muted, formatter: fmt ?? compact },
    splitLine: { lineStyle: { color: T.grid, width: 1, type: 'solid' } },
  };
}

function categoryAxis(T, labels, extra = {}) {
  return {
    type: 'category',
    data: labels,
    axisLine: { lineStyle: { color: T.axis } },
    axisTick: { show: false },
    axisLabel: { color: T.muted, hideOverlap: true },
    ...extra,
  };
}

const lineKey = (color) => `<span style="display:inline-block;width:12px;height:2px;border-radius:1px;background:${color};vertical-align:middle;margin-right:6px"></span>`;
const row = (color, value, label) =>
  `<div style="display:flex;align-items:center;gap:8px;justify-content:space-between;min-width:140px">` +
  `<span style="color:inherit;opacity:.75">${color ? lineKey(color) : ''}${esc(label)}</span><b>${esc(value)}</b></div>`;

/** Format hours for axes and tooltips. */
export const hoursFmt = (h) => (h >= 100 ? `${compact(h)} h` : `${Math.round(h * 10) / 10} h`);

// ---- builders ----

/** Single or multi-series line over time. series: [{ name, data, color? }] */
export function lineChart({ labels, series, valueFmt = hoursFmt, area = series.length === 1, scope }) {
  const T = tokens();
  const slots = scope ? assignSlots(scope, series.map((s) => s.key ?? s.name)) : null;
  const colorOf = (s, n) => s.color ?? T.series[slots ? slots.get(s.key ?? s.name) : n];
  return {
    ...base(T),
    grid: { ...base(T).grid, right: 28, top: series.length > 1 ? 40 : 16 },
    legend: series.length > 1
      ? { top: 0, left: 0, icon: 'roundRect', itemWidth: 14, itemHeight: 3, textStyle: { color: T.text2 } }
      : undefined,
    tooltip: {
      ...base(T).tooltip,
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: T.axis, width: 1 } },
      formatter: (ps) => {
        const head = `<div style="margin-bottom:4px;opacity:.7">${esc(ps[0]?.axisValueLabel)}</div>`;
        const sorted = [...ps].sort((a, b) => b.value - a.value);
        return head + sorted.map((p) => row(p.color, valueFmt(p.value), p.seriesName)).join('');
      },
    },
    xAxis: categoryAxis(T, labels, { boundaryGap: false }),
    yAxis: valueAxis(T, valueFmt),
    series: series.map((s, n) => {
      const color = colorOf(s, n);
      return {
        name: s.name,
        type: 'line',
        data: s.data,
        showSymbol: false,
        symbolSize: 8,
        smooth: false,
        lineStyle: { width: 2, color, cap: 'round', join: 'round' },
        itemStyle: { color, borderColor: T.surface, borderWidth: 2 },
        areaStyle: area ? { color, opacity: 0.1 } : undefined,
        emphasis: { focus: series.length > 1 ? 'series' : 'none' },
      };
    }),
  };
}

/** Vertical columns. */
export function columnChart({ labels, data, valueFmt = hoursFmt, name = '', color, highlight = -1, labelTop = false }) {
  const T = tokens();
  const c = color ?? T.series[0];
  return {
    ...base(T),
    grid: { ...base(T).grid, top: labelTop ? 24 : 16 },
    tooltip: {
      ...base(T).tooltip,
      trigger: 'item',
      formatter: (p) => `<div style="margin-bottom:4px;opacity:.7">${esc(p.name)}</div>${row(null, valueFmt(p.value), name)}`,
    },
    xAxis: categoryAxis(T, labels),
    yAxis: valueAxis(T, valueFmt),
    series: [{
      type: 'bar',
      name,
      data: data.map((v, i) => ({ value: v, itemStyle: { opacity: highlight < 0 || highlight === i ? 1 : 0.35 } })),
      barMaxWidth: 24,
      barCategoryGap: '30%',
      itemStyle: { color: c, borderRadius: [4, 4, 0, 0] },
      emphasis: { itemStyle: { color: c, opacity: 0.85 } },
      label: labelTop ? { show: true, position: 'top', color: T.text2, fontSize: 11, formatter: (p) => valueFmt(p.value) } : undefined,
      labelLayout: { hideOverlap: true },
    }],
  };
}

/** Horizontal ranked bars with the value at each bar tip. rows: [{ name, sub, value }] */
export function rankChart({ rows, valueFmt = int, metricName = '' }) {
  const T = tokens();
  return {
    ...base(T),
    // Fixed label column: auto-fitting clipped long names at the left edge.
    grid: { left: 184, right: 56, top: 4, bottom: 4, outerBoundsMode: 'none' },
    tooltip: {
      ...base(T).tooltip,
      trigger: 'item',
      formatter: (p) => {
        const r = rows[p.dataIndex];
        const sub = r.sub ? `<div style="opacity:.7;margin-bottom:4px">${esc(r.sub)}</div>` : '';
        return `<div style="font-weight:600">${esc(r.name)}</div>${sub}${row(null, valueFmt(r.value), metricName)}`;
      },
    },
    xAxis: { ...valueAxis(T, valueFmt), axisLabel: { show: false }, splitLine: { show: false } },
    yAxis: categoryAxis(T, rows.map((r) => r.name), {
      inverse: true,
      axisLine: { show: false },
      axisLabel: { color: T.text2, width: 172, overflow: 'truncate', ellipsis: '…', fontSize: 12 },
    }),
    series: [{
      type: 'bar',
      data: rows.map((r) => r.value),
      barMaxWidth: 16,
      barCategoryGap: '35%',
      itemStyle: { color: T.series[0], borderRadius: [0, 4, 4, 0] },
      emphasis: { itemStyle: { opacity: 0.85 } },
      label: { show: true, position: 'right', color: T.text2, fontSize: 11, formatter: (p) => valueFmt(p.value) },
    }],
  };
}

/** Stacked columns over time. series: [{ name, key, data }] */
export function stackedColumns({ labels, series, valueFmt = hoursFmt, scope }) {
  const T = tokens();
  const slots = assignSlots(scope ?? 'stack', series.map((s) => s.key ?? s.name));
  return {
    ...base(T),
    grid: { ...base(T).grid, top: 40 },
    legend: { top: 0, left: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 10, textStyle: { color: T.text2 } },
    tooltip: {
      ...base(T).tooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: T.grid, opacity: 0.4 } },
      formatter: (ps) => {
        const head = `<div style="margin-bottom:4px;opacity:.7">${esc(ps[0]?.axisValueLabel)}</div>`;
        return head + ps.filter((p) => p.value > 0).sort((a, b) => b.value - a.value)
          .map((p) => row(p.color, valueFmt(p.value), p.seriesName)).join('');
      },
    },
    xAxis: categoryAxis(T, labels),
    yAxis: valueAxis(T, valueFmt),
    series: series.map((s, n) => ({
      name: s.name,
      type: 'bar',
      stack: 'total',
      data: s.data,
      barMaxWidth: 24,
      itemStyle: {
        color: T.series[slots.get(s.key ?? s.name)],
        borderColor: T.surface,
        borderWidth: 1,
        borderRadius: n === series.length - 1 ? [4, 4, 0, 0] : 0,
      },
    })),
  };
}

function seqVisualMap(T, max, fmt, extra = {}) {
  return {
    type: 'continuous',
    min: 0,
    max: max || 1,
    calculable: false,
    orient: 'horizontal',
    left: 0,
    bottom: 0,
    itemWidth: 10,
    itemHeight: 160,
    text: [fmt(max), '0'],
    textStyle: { color: T.muted, fontSize: 11 },
    inRange: { color: T.seq },
    ...extra,
  };
}

/** Weekday x hour heatmap of listening time. matrix[weekday][hour] = hours */
export function weekHourHeatmap({ matrix, weekdays }) {
  const T = tokens();
  const data = [];
  let max = 0;
  matrix.forEach((hoursRow, d) => hoursRow.forEach((v, h) => { data.push([h, d, v]); if (v > max) max = v; }));
  return {
    ...base(T),
    grid: { left: 4, right: 8, top: 8, bottom: 48, containLabel: true },
    tooltip: {
      ...base(T).tooltip,
      trigger: 'item',
      formatter: (p) => `<div style="margin-bottom:4px;opacity:.7">${weekdays[p.value[1]]} · ${String(p.value[0]).padStart(2, '0')}:00</div>${row(null, hoursFmt(p.value[2]), 'Listening')}`,
    },
    xAxis: categoryAxis(T, Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}`), { axisLine: { show: false }, splitArea: { show: false } }),
    yAxis: categoryAxis(T, weekdays, { inverse: true, axisLine: { show: false } }),
    visualMap: seqVisualMap(T, max, hoursFmt),
    series: [{
      type: 'heatmap',
      data,
      itemStyle: { borderColor: T.surface, borderWidth: 2, borderRadius: 3 },
      emphasis: { itemStyle: { borderColor: T.text1, borderWidth: 1 } },
    }],
  };
}

/** One calendar row per year; value is minutes per day. */
export function calendarChart({ years, data, max }) {
  const T = tokens();
  const cellH = 13;
  const rowH = cellH * 7 + 34;
  const fmt = (m) => (m >= 60 ? `${Math.round((m / 60) * 10) / 10} h` : `${Math.round(m)} min`);
  return {
    ...base(T),
    tooltip: {
      ...base(T).tooltip,
      trigger: 'item',
      formatter: (p) => {
        const d = new Date(`${p.value[0]}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
        return `<div style="margin-bottom:4px;opacity:.7">${esc(d)}</div>${row(null, fmt(p.value[1]), 'Listening')}`;
      },
    },
    visualMap: seqVisualMap(T, max, fmt, { top: 0, bottom: undefined, left: undefined, right: 0, itemHeight: 120 }),
    calendar: years.map((y, n) => ({
      top: 56 + n * rowH,
      left: 44,
      right: 8,
      cellSize: ['auto', cellH],
      range: String(y),
      orient: 'horizontal',
      splitLine: { show: false },
      itemStyle: { color: T.seqEmpty, borderColor: T.surface, borderWidth: 2 },
      yearLabel: { show: true, position: 'left', color: T.text2, fontSize: 12, margin: 28 },
      monthLabel: { color: T.muted, fontSize: 10, nameMap: 'en' },
      dayLabel: { show: false },
    })),
    series: years.map((y, n) => ({
      type: 'heatmap',
      coordinateSystem: 'calendar',
      calendarIndex: n,
      data: data.filter((d) => d[0].startsWith(String(y))),
    })),
    _height: 56 + years.length * rowH,
  };
}

// ---- table twin ----

/**
 * Render a data table into a container.
 * columns: [{ key, label, num?, fmt?(value,row), sortValue?(row) }]
 */
export function renderTable(container, { columns, rows, onRowClick, sortKey, limit = 500, caption }) {
  let key = sortKey ?? null;
  let dir = -1;
  const draw = () => {
    const sorted = key
      ? [...rows].sort((a, b) => {
          const col = columns.find((c) => c.key === key);
          const av = col.sortValue ? col.sortValue(a) : a[key];
          const bv = col.sortValue ? col.sortValue(b) : b[key];
          if (typeof av === 'string') return dir * -av.localeCompare(bv);
          return dir * ((av ?? 0) - (bv ?? 0));
        })
      : rows;
    const table = document.createElement('table');
    table.className = 'data-table';
    if (caption) {
      const cap = table.createCaption();
      cap.textContent = caption;
    }
    const thead = table.createTHead().insertRow();
    for (const c of columns) {
      const th = document.createElement('th');
      th.scope = 'col';
      if (c.num) th.className = 'num';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = c.label + (key === c.key ? (dir < 0 ? ' ↓' : ' ↑') : '');
      btn.addEventListener('click', () => {
        if (key === c.key) dir = -dir;
        else { key = c.key; dir = c.num ? -1 : 1; }
        draw();
      });
      th.appendChild(btn);
      thead.appendChild(th);
    }
    const tbody = table.createTBody();
    for (const r of sorted.slice(0, limit)) {
      const tr = tbody.insertRow();
      if (onRowClick) {
        tr.tabIndex = 0;
        tr.className = 'clickable';
        tr.addEventListener('click', () => onRowClick(r));
        tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') onRowClick(r); });
      }
      for (const c of columns) {
        const td = tr.insertCell();
        if (c.num) td.className = 'num';
        const v = c.fmt ? c.fmt(r[c.key], r) : r[c.key];
        if (c.sub && r[c.sub]) {
          const main = document.createElement('div');
          main.textContent = v ?? '';
          const sub = document.createElement('div');
          sub.className = 'cell-sub';
          sub.textContent = r[c.sub];
          td.append(main, sub);
        } else {
          td.textContent = v ?? '';
        }
      }
    }
    container.replaceChildren(table);
    if (sorted.length > limit) {
      const more = document.createElement('p');
      more.className = 'muted small';
      more.textContent = `Showing ${int(limit)} of ${int(sorted.length)} rows.`;
      container.appendChild(more);
    }
  };
  draw();
}

export { duration };
