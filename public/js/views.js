// Each view returns { html, cards, after? }. Cards are mounted by app.js.
import {
  timeline, entityLabel, playsOf, longestStreaks, mostPlaysInADay, playCountDistribution,
  loyalArtists, weekHourMatrix, msByDay, msByMonthOfYear, discoveries, entityTimelines, timelinesBy,
  splitByYear, countBy, countRows, flagShares, groupStats, bucketLabel,
} from './aggregate.js';
import { lineChart, columnChart, rankChart, stackedColumns, weekHourHeatmap, calendarChart, renderTable, hoursFmt } from './charts.js';
import { int, pct, duration, hours, date, dateTime, clock, esc, reasonLabel, countryName, WEEKDAYS, MONTHS } from './format.js';
import { dayToISO, artistNames, artistsOf } from './data.js';
import { artHTML, artNode, entityArt, artistArt } from './art.js';

// ---- shared helpers ----

function words(kind) {
  if (kind === 'podcasts') return { artist: 'Show', artists: 'shows', track: 'Episode', tracks: 'episodes', album: 'Show', albums: 'shows' };
  return { artist: 'Artist', artists: 'artists', track: 'Track', tracks: 'tracks', album: 'Album', albums: 'albums' };
}

function card({ id, title, sub = '', span = 1, height = 300, chart = true, actions = '', scroll = false }) {
  return `<section class="card${span === 2 ? ' span-2' : ''}" id="${id}">
    <header class="card-head">
      <div><h3>${esc(title)}</h3>${sub ? `<p>${esc(sub)}</p>` : ''}</div>
      <div class="card-actions">${actions}${chart ? '<button type="button" class="ghost-btn" data-toggle-table aria-pressed="false">Table</button>' : ''}</div>
    </header>
    ${chart ? `<div class="chart" style="height:${height}px"></div>` : ''}
    <div class="table-wrap${scroll ? ' scroll' : ''}"${chart ? ' hidden' : ''}></div>
  </section>`;
}

function tile(label, value, sub = '', { text = false } = {}) {
  return `<div class="tile"><div class="tile-label">${esc(label)}</div>` +
    `<div class="tile-value${text ? ' text' : ''}" title="${esc(value)}">${esc(value)}</div>` +
    `${sub ? `<div class="tile-sub" title="${esc(sub)}">${esc(sub)}</div>` : ''}</div>`;
}

const minLabel = (minMs) => (minMs ? `Counting plays of ${minMs / 1000}s or more` : 'Counting every play');

function entityRows(D, by, stats) {
  return stats.map((s, n) => {
    const { name, sub } = entityLabel(D, by, s.id);
    return { ...s, rank: n + 1, name, sub, skipRate: s.rows ? s.skips / s.rows : 0 };
  });
}

function entityColumns(by, W, D, { art = true } = {}) {
  return [
    { key: 'rank', label: '#', num: true },
    {
      key: 'name', label: W[by], sub: by === 'artist' ? undefined : 'sub',
      art: art ? (r) => entityArt(D, by, r.id) : undefined, artRound: by === 'artist',
    },
    { key: 'plays', label: 'Plays', num: true, fmt: int },
    { key: 'ms', label: 'Time', num: true, fmt: duration },
    ...(by === 'track' ? [] : [{ key: 'tracks', label: W.tracks[0].toUpperCase() + W.tracks.slice(1), num: true, fmt: int }]),
    { key: 'days', label: 'Days played', num: true, fmt: int },
    { key: 'skipRate', label: 'Skipped', num: true, fmt: pct },
    { key: 'first', label: 'First played', num: true, fmt: (v) => date(v) },
    { key: 'last', label: 'Last played', num: true, fmt: (v) => date(v) },
  ];
}

const exploreHash = (by, id) => `#/explore/${by}/${id}`;

function rankCard(D, by, rows, { valueFmt = int, metricName = 'Plays', go, subFn }) {
  const data = rows.map((r) => {
    const l = entityLabel(D, by, r.id);
    return { id: r.id, name: l.name, sub: subFn ? subFn(r, l) : l.sub, value: r.value };
  });
  return {
    option: () => rankChart({ rows: data, valueFmt, metricName }),
    table: () => ({
      columns: [
        { key: 'name', label: 'Name', sub: 'sub' },
        { key: 'value', label: metricName, num: true, fmt: valueFmt },
      ],
      rows: data,
      onRowClick: (r) => go(exploreHash(by, r.id)),
    }),
    onClick: (p) => go(exploreHash(by, data[p.dataIndex].id)),
  };
}

/** A grid of images with names and values; each opens the item in Explore. */
function gallery(D, by, rows, valueFmt) {
  return `<div class="gallery">${rows.map((r, n) => {
    const { name, sub } = entityLabel(D, by, r.id);
    return `<button type="button" class="g-item" data-href="${exploreHash(by, r.id)}">
      ${artHTML(entityArt(D, by, r.id), { round: by === 'artist', label: name })}
      <span class="g-name" title="${esc(name)}"><span class="g-rank">${n + 1}</span>${esc(name)}</span>
      ${sub ? `<span class="g-sub" title="${esc(sub)}">${esc(sub)}</span>` : ''}
      <span class="g-value">${esc(valueFmt(r.value))}</span>
    </button>`;
  }).join('')}</div>`;
}

const galleryCard = (id, title, sub, inner) => `<section class="card span-2" id="${id}">
  <header class="card-head"><div><h3>${esc(title)}</h3>${sub ? `<p>${esc(sub)}</p>` : ''}</div></header>${inner}</section>`;

const rankHeight = (n) => Math.max(120, n * 28 + 8);

function timelineTable(t, label = 'Period') {
  return {
    columns: [
      { key: 'label', label },
      { key: 'ms', label: 'Time', num: true, fmt: duration },
      { key: 'plays', label: 'Plays', num: true, fmt: int },
    ],
    rows: t.labels.map((l, i) => ({ label: l, ms: t.ms[i], plays: t.plays[i], order: i })),
  };
}

function bindButtons(root, go) {
  root.querySelectorAll('[data-href]').forEach((b) => b.addEventListener('click', () => go(b.dataset.href)));
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
function overview({ D, sel, go }) {
  const s = sel.summary;
  const W = words(sel.kind);
  const span = s.lastDay - s.firstDay + 1;
  const tl = timeline(D, sel.idx, sel.minMs, sel.unit);
  const years = timeline(D, sel.idx, sel.minMs, 'year');
  const artists = sel.group('artist');
  const tracks = sel.group('track');
  const topArtists = [...artists].sort((a, b) => b.ms - a.ms).slice(0, 10).map((r) => ({ id: r.id, value: hours(r.ms) }));
  const topTracks = tracks.slice(0, 10).map((r) => ({ id: r.id, value: r.plays }));

  // Year by year
  const yearRows = splitByYear(D, sel.idx).map(([y, idx]) => {
    const a = groupStats(D, idx, sel.minMs, 'artist').sort((p, q) => q.ms - p.ms)[0];
    const t = groupStats(D, idx, sel.minMs, 'track')[0];
    let ms = 0, plays = 0;
    for (const i of idx) { ms += D.ms[i]; if (D.ms[i] >= sel.minMs) plays++; }
    return {
      year: y, ms, plays,
      artist: a ? D.creators[a.id] : '—', artistId: a?.id,
      track: t ? D.items.name[t.id] : '—', trackSub: t ? `${artistNames(D, t.id)} · ${int(t.plays)} plays` : '',
    };
  });

  const html = `
    <div class="hero">
      <div class="hero-main">
        <div class="hero-label">Total listening time</div>
        <div class="hero-value">${int(hours(s.ms))}<small>hours</small></div>
        <div class="hero-sub">About ${int(s.ms / 86400000)} full days of non-stop audio over ${int(span)} days of history.</div>
      </div>
      <div class="tiles">
        ${tile('Plays', int(s.plays), minLabel(sel.minMs))}
        ${tile(`Different ${W.tracks}`, int(s.tracks), `${(s.plays / Math.max(1, s.tracks)).toFixed(1)} plays per ${W.track.toLowerCase()}`)}
        ${tile(`Different ${W.artists}`, int(s.artists))}
        ${tile('Days you listened', int(s.activeDays), `${pct(s.activeDays / span)} of all days`)}
        ${tile('Per listening day', duration(s.ms / Math.max(1, s.activeDays)), 'On days you listened')}
        ${tile('Skipped', pct(s.skips / Math.max(1, s.rows)), 'Ended with next or back')}
      </div>
    </div>
    ${galleryCard('c-gallery', `Your top ${W.artists}`, 'By listening time', gallery(D, 'artist', topArtists.slice(0, 8), (v) => `${hoursFmt(v)} listened`))}
    ${card({ id: 'c-timeline', title: 'Listening over time', sub: `Hours per ${sel.unit}`, span: 2, height: 300 })}
    ${card({ id: 'c-years', title: 'Hours per year', height: 280 })}
    ${card({ id: 'c-year-table', title: 'Year by year', sub: `Your top ${W.artist.toLowerCase()} and most played ${W.track.toLowerCase()}`, chart: false })}
    ${card({ id: 'c-top-artists', title: `Top ${W.artists}`, sub: 'By listening time', height: rankHeight(10) })}
    ${card({ id: 'c-top-tracks', title: `Top ${W.tracks}`, sub: 'By number of plays', height: rankHeight(10) })}
  `;

  return {
    html,
    after: (root) => bindButtons(root, go),
    cards: [
      {
        id: 'c-timeline',
        option: () => lineChart({ labels: tl.labels, series: [{ name: 'Listening', data: tl.ms.map(hours) }] }),
        table: () => timelineTable(tl),
      },
      {
        id: 'c-years',
        option: () => columnChart({ labels: years.labels, data: years.ms.map(hours), name: 'Listening', labelTop: years.labels.length <= 16 }),
        table: () => timelineTable(years, 'Year'),
      },
      {
        id: 'c-year-table',
        table: () => ({
          columns: [
            { key: 'year', label: 'Year' },
            { key: 'ms', label: 'Time', num: true, fmt: duration },
            { key: 'plays', label: 'Plays', num: true, fmt: int },
            { key: 'artist', label: `Top ${W.artist.toLowerCase()}`, art: (r) => (r.artistId === undefined ? null : artistArt(D, r.artistId)), artRound: true },
            { key: 'track', label: `Top ${W.track.toLowerCase()}`, sub: 'trackSub' },
          ],
          rows: yearRows.reverse(),
          onRowClick: (r) => r.artistId !== undefined && go(exploreHash('artist', r.artistId)),
        }),
      },
      { id: 'c-top-artists', ...rankCard(D, 'artist', topArtists, { valueFmt: hoursFmt, metricName: 'Listening', go }) },
      { id: 'c-top-tracks', ...rankCard(D, 'track', topTracks, { metricName: 'Plays', go }) },
    ],
  };
}

// ---------------------------------------------------------------------------
// Top charts
// ---------------------------------------------------------------------------
function top({ D, sel, params, go }) {
  const by = ['artist', 'track', 'album'].includes(params[0]) ? params[0] : 'artist';
  const metric = params[1] === 'time' ? 'time' : 'plays';
  const W = words(sel.kind);
  const stats = [...sel.group(by)];
  if (metric === 'time') stats.sort((a, b) => b.ms - a.ms);
  const rows = entityRows(D, by, stats);
  const N = 25;
  const chartRows = rows.slice(0, N).map((r) => ({ id: r.id, value: metric === 'time' ? hours(r.ms) : r.plays }));

  const seg = (items, current, href) => `<div class="segmented" role="group">${items
    .map(([v, l]) => `<button type="button" data-href="${href(v)}" aria-pressed="${v === current}">${esc(l)}</button>`).join('')}</div>`;

  const html = `
    <div class="toolbar">
      ${seg([['artist', `${W.artist}s`], ['track', `${W.track}s`], ['album', `${W.album}s`]], by, (v) => `#/top/${v}/${metric}`)}
      <span class="label">Rank by</span>
      ${seg([['plays', 'Plays'], ['time', 'Listening time']], metric, (v) => `#/top/${by}/${v}`)}
    </div>
    ${galleryCard('c-gallery', `Top ${W[`${by}s`]}`, metric === 'time' ? 'By listening time' : 'By plays', gallery(D, by, chartRows.slice(0, 8), metric === 'time' ? (v) => `${hoursFmt(v)} listened` : (v) => `${int(v)} plays`))}
    ${card({ id: 'c-rank', title: `Top ${N} ${W[`${by}s`]}`, sub: metric === 'time' ? 'By listening time' : `By plays · ${minLabel(sel.minMs).toLowerCase()}`, span: 2, height: rankHeight(Math.min(N, rows.length)) })}
    ${card({
      id: 'c-all', title: `All ${W[`${by}s`]}`, sub: `${int(rows.length)} in this period · click a row for details`, span: 2, chart: false, scroll: true,
      actions: `<input type="search" class="search-input" id="top-filter" placeholder="Filter by name" style="min-height:30px;padding:4px 10px;font-size:13px;width:200px">`,
    })}
  `;

  return {
    html,
    cards: [{
      id: 'c-rank',
      ...rankCard(D, by, chartRows, { valueFmt: metric === 'time' ? hoursFmt : int, metricName: metric === 'time' ? 'Listening' : 'Plays', go }),
    }],
    after(root) {
      bindButtons(root, go);
      const wrap = root.querySelector('#c-all .table-wrap');
      const columns = entityColumns(by, W, D);
      const draw = (q) => {
        const needle = q.trim().toLowerCase();
        const shown = needle ? rows.filter((r) => r.name.toLowerCase().includes(needle) || (r.sub ?? '').toLowerCase().includes(needle)) : rows;
        renderTable(wrap, { columns, rows: shown, onRowClick: (r) => go(exploreHash(by, r.id)), limit: 500 });
      };
      draw('');
      root.querySelector('#top-filter').addEventListener('input', (e) => draw(e.target.value));
    },
  };
}

// ---------------------------------------------------------------------------
// On repeat
// ---------------------------------------------------------------------------
function repeat({ D, sel, go }) {
  const W = words(sel.kind);
  const tracks = sel.group('track').filter((t) => t.plays > 0);
  const once = tracks.filter((t) => t.plays === 1).length;
  const tenPlus = tracks.filter((t) => t.plays >= 10).length;
  const hundredPlus = tracks.filter((t) => t.plays >= 100).length;
  const topTrack = tracks[0];
  const totalPlays = tracks.reduce((a, t) => a + t.plays, 0);
  const topShare = tracks.slice(0, Math.max(1, Math.round(tracks.length * 0.1))).reduce((a, t) => a + t.plays, 0) / Math.max(1, totalPlays);

  const dist = playCountDistribution(tracks);
  const streaks = longestStreaks(D, sel.idx, sel.minMs, 15);
  const daily = mostPlaysInADay(D, sel.idx, sel.minMs, 15);
  const loyal = loyalArtists(D, sel.idx, sel.minMs, 25);
  const albums = sel.group('album').filter((a) => a.plays > 0);
  const topAlbums = albums.slice(0, 10).map((a) => ({ id: a.id, value: a.plays }));
  const artistReplays = sel.group('artist').filter((a) => a.tracks >= 5).map((a) => ({ id: a.id, value: a.plays / a.tracks, tracks: a.tracks }))
    .sort((a, b) => b.value - a.value).slice(0, 10);

  const html = `
    <div class="tiles span-2">
      ${tile(`${W.tracks[0].toUpperCase()}${W.tracks.slice(1)} played once`, int(once), `${pct(once / Math.max(1, tracks.length))} of ${int(tracks.length)} ${W.tracks}`)}
      ${tile('Played 10+ times', int(tenPlus), `${int(hundredPlus)} played 100+ times`)}
      ${tile(`Most played ${W.track.toLowerCase()}`, topTrack ? `${int(topTrack.plays)} plays` : '—', topTrack ? `${D.items.name[topTrack.id]} · ${artistNames(D, topTrack.id)}` : '')}
      ${tile(`Top 10% of ${W.tracks}`, pct(topShare), 'Share of all your plays')}
      ${tile('Longest back-to-back run', streaks[0] ? `${streaks[0].len}× in a row` : '—', streaks[0] ? D.items.name[streaks[0].id] : '')}
    </div>
    ${card({ id: 'c-dist', title: `How many times you played each ${W.track.toLowerCase()}`, sub: `Number of ${W.tracks} by play count`, span: 2, height: 260 })}
    ${card({ id: 'c-streaks', title: 'On repeat', sub: 'Longest runs of the same track back to back', height: rankHeight(streaks.length) })}
    ${card({ id: 'c-daily', title: 'Most plays in a single day', sub: `One ${W.track.toLowerCase()}, one day`, height: rankHeight(daily.length) })}
    ${card({ id: 'c-albums', title: `Most played ${W.albums}`, sub: 'By plays', height: rankHeight(topAlbums.length) })}
    ${card({ id: 'c-depth', title: `${W.artists[0].toUpperCase()}${W.artists.slice(1)} you replay the most`, sub: `Average plays per ${W.track.toLowerCase()} (${W.artists} with 5+ ${W.tracks})`, height: rankHeight(artistReplays.length) })}
    ${card({ id: 'c-loyal', title: `${W.artists[0].toUpperCase()}${W.artists.slice(1)} you keep coming back to`, sub: 'Played in the most different years', span: 2, chart: false, scroll: true })}
  `;

  return {
    html,
    cards: [
      {
        id: 'c-dist',
        option: () => columnChart({ labels: dist.map((d) => `${d.label} ${d.label === '1' ? 'play' : 'plays'}`), data: dist.map((d) => d.count), valueFmt: int, name: W.tracks, labelTop: true }),
        table: () => ({ columns: [{ key: 'label', label: 'Plays' }, { key: 'count', label: W.tracks, num: true, fmt: int }], rows: dist }),
      },
      {
        id: 'c-streaks',
        ...rankCard(D, 'track', streaks.map((s) => ({ ...s, value: s.len })), {
          valueFmt: (v) => `${v}×`, metricName: 'In a row', go, subFn: (r, l) => `${l.sub} · ${date(r.day)}`,
        }),
      },
      {
        id: 'c-daily',
        ...rankCard(D, 'track', daily.map((s) => ({ ...s, value: s.count })), {
          valueFmt: (v) => `${v}×`, metricName: 'Plays that day', go, subFn: (r, l) => `${l.sub} · ${date(r.day)}`,
        }),
      },
      { id: 'c-albums', ...rankCard(D, 'album', topAlbums, { metricName: 'Plays', go }) },
      {
        id: 'c-depth',
        ...rankCard(D, 'artist', artistReplays, {
          valueFmt: (v) => v.toFixed(1), metricName: `Plays per ${W.track.toLowerCase()}`, go, subFn: (r) => `${int(r.tracks)} ${W.tracks}`,
        }),
      },
      {
        id: 'c-loyal',
        table: () => ({
          columns: [
            { key: 'name', label: W.artist, art: (r) => artistArt(D, r.id), artRound: true },
            { key: 'years', label: 'Years played', num: true, fmt: int },
            { key: 'spanLabel', label: 'From – to', num: true },
            { key: 'plays', label: 'Plays', num: true, fmt: int },
          ],
          rows: loyal.map((l) => ({ ...l, name: D.creators[l.id], spanLabel: `${l.span[0]} – ${l.span[1]}` })),
          onRowClick: (r) => go(exploreHash('artist', r.id)),
        }),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Habits
// ---------------------------------------------------------------------------
function weekdayCounts(fromDay, toDay) {
  const c = new Array(7).fill(0);
  for (let d = fromDay; d <= toDay; d++) c[(d + 3) % 7]++; // 1970-01-01 was a Thursday
  return c;
}

function habits({ D, sel }) {
  const s = sel.summary;
  const m = weekHourMatrix(D, sel.idx);
  const byHour = Array.from({ length: 24 }, (_, h) => m.reduce((a, r) => a + r[h], 0));
  const totalMs = byHour.reduce((a, b) => a + b, 0) || 1;
  const wdTotals = m.map((r) => r.reduce((a, b) => a + b, 0));
  const wdDays = weekdayCounts(s.firstDay, s.lastDay);
  const wdAvg = wdTotals.map((t, i) => t / Math.max(1, wdDays[i]));
  const moy = msByMonthOfYear(D, sel.idx);
  const days = msByDay(D, sel.idx);

  const peakHour = byHour.indexOf(Math.max(...byHour));
  const bestWd = wdAvg.indexOf(Math.max(...wdAvg));
  const night = byHour.slice(0, 6).reduce((a, b) => a + b, 0) / totalMs;
  let bigDay = null;
  for (const [d, v] of days) if (!bigDay || v > bigDay[1]) bigDay = [d, v];
  // Longest run of consecutive listening days
  const sortedDays = [...days.keys()].sort((a, b) => a - b);
  let run = 0, bestRun = 0, bestEnd = 0;
  for (let k = 0; k < sortedDays.length; k++) {
    run = k > 0 && sortedDays[k] === sortedDays[k - 1] + 1 ? run + 1 : 1;
    if (run > bestRun) { bestRun = run; bestEnd = sortedDays[k]; }
  }

  // Calendar data (minutes per day) with the scale capped at the 95th percentile
  const calData = [...days.entries()].map(([d, v]) => [dayToISO(d), Math.round(v / 60000)]);
  const vals = calData.map((d) => d[1]).sort((a, b) => a - b);
  const p95 = vals[Math.floor(vals.length * 0.95)] || 1;
  const years = [...new Set(sortedDays.map((d) => Number(dayToISO(d).slice(0, 4))))].sort((a, b) => b - a);

  const hourLabel = (h) => `${String(h).padStart(2, '0')}:00`;
  const html = `
    <div class="tiles span-2">
      ${tile('Peak hour', `${hourLabel(peakHour)}–${hourLabel((peakHour + 1) % 24)}`, `${pct(byHour[peakHour] / totalMs)} of your listening`)}
      ${tile('Favorite day', ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][bestWd], `${duration(wdAvg[bestWd])} on an average ${WEEKDAYS[bestWd]}`)}
      ${tile('Late night share', pct(night), 'Listening between midnight and 6 am')}
      ${tile('Biggest day', bigDay ? duration(bigDay[1]) : '—', bigDay ? date(bigDay[0], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) : '')}
      ${tile('Longest daily streak', `${int(bestRun)} days`, bestRun ? `Ended ${date(bestEnd)}` : '')}
    </div>
    ${card({ id: 'c-heat', title: 'When you listen', sub: 'Hours of listening by weekday and hour of day', span: 2, height: 300 })}
    ${card({ id: 'c-hour', title: 'By hour of day', sub: 'Share of total listening', height: 260 })}
    ${card({ id: 'c-wd', title: 'By day of week', sub: 'Average listening per day', height: 260 })}
    ${card({ id: 'c-moy', title: 'By month of year', sub: `Average hours per month, across ${moy.years} ${moy.years === 1 ? 'year' : 'years'}`, span: 2, height: 260 })}
    ${card({ id: 'c-cal', title: 'Every day you listened', sub: 'Minutes per day', span: 2, height: 200 })}
  `;

  return {
    html,
    cards: [
      {
        id: 'c-heat',
        option: () => weekHourHeatmap({ matrix: m.map((r) => Array.from(r, hours)), weekdays: WEEKDAYS }),
        table: () => ({
          columns: [{ key: 'day', label: 'Day' }, ...Array.from({ length: 24 }, (_, h) => ({ key: `h${h}`, label: String(h).padStart(2, '0'), num: true, fmt: (v) => (v >= 1 ? int(v) : v ? v.toFixed(1) : '') }))],
          rows: m.map((r, d) => Object.fromEntries([['day', WEEKDAYS[d]], ...Array.from(r, (v, h) => [`h${h}`, hours(v)])])),
          caption: 'Hours',
        }),
      },
      {
        id: 'c-hour',
        option: () => columnChart({ labels: byHour.map((_, h) => String(h).padStart(2, '0')), data: byHour.map((v) => v / totalMs), valueFmt: pct, name: 'Share', highlight: peakHour }),
        table: () => ({ columns: [{ key: 'h', label: 'Hour' }, { key: 'ms', label: 'Time', num: true, fmt: duration }, { key: 'share', label: 'Share', num: true, fmt: pct }], rows: byHour.map((v, h) => ({ h: hourLabel(h), ms: v, share: v / totalMs })) }),
      },
      {
        id: 'c-wd',
        option: () => columnChart({ labels: WEEKDAYS, data: wdAvg.map((v) => v / 60000), valueFmt: (v) => `${int(v)} min`, name: 'Average', highlight: bestWd }),
        table: () => ({ columns: [{ key: 'd', label: 'Day' }, { key: 'avg', label: 'Average per day', num: true, fmt: duration }, { key: 'total', label: 'Total', num: true, fmt: duration }], rows: WEEKDAYS.map((d, i) => ({ d, avg: wdAvg[i], total: wdTotals[i] })) }),
      },
      {
        id: 'c-moy',
        option: () => columnChart({ labels: MONTHS, data: moy.ms.map((v) => hours(v) / Math.max(1, moy.years)), name: 'Average', labelTop: true }),
        table: () => ({ columns: [{ key: 'm', label: 'Month' }, { key: 'avg', label: 'Average hours', num: true, fmt: (v) => v.toFixed(1) }], rows: MONTHS.map((m2, i) => ({ m: m2, avg: hours(moy.ms[i]) / Math.max(1, moy.years) })) }),
      },
      {
        id: 'c-cal',
        option: () => calendarChart({ years, data: calData, max: p95 }),
        table: () => ({
          columns: [{ key: 'date', label: 'Date' }, { key: 'min', label: 'Minutes', num: true, fmt: int }],
          rows: [...calData].reverse().map(([d, v]) => ({ date: d, min: v })),
        }),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------
function discovery({ D, sel, go }) {
  const W = words(sel.kind);
  const s = sel.summary;
  const unit = sel.unit;
  const disc = discoveries(D, sel.idx, unit);
  const newArtists = disc.artists.reduce((a, b) => a + b, 0);
  const newTracks = disc.tracks.reduce((a, b) => a + b, 0);

  // Artists first heard inside this period, and how much of the period they account for
  const isNew = new Uint8Array(D.creators.length);
  for (let c = 0; c < D.creators.length; c++) {
    const f = D.creatorFirst[c];
    if (f >= 0 && D.day[f] >= sel.fromDay && D.day[f] <= sel.toDay) isNew[c] = 1;
  }
  let newMs = 0;
  for (const i of sel.idx) {
    if (D.item[i] >= 0 && artistsOf(D, D.item[i]).some((c) => isNew[c])) newMs += D.ms[i];
  }
  const artists = sel.group('artist');
  const finds = artists.filter((a) => isNew[a.id] && a.plays > 0).slice(0, 10).map((a) => ({ id: a.id, value: a.plays, first: D.day[D.creatorFirst[a.id]] }));

  // Top artists over time
  const trendUnit = s.lastDay - s.firstDay > 3 * 365 ? 'year' : unit;
  const topIds = [...artists].sort((a, b) => b.ms - a.ms).slice(0, 5).map((a) => a.id);
  const trend = entityTimelines(D, sel.idx, 'artist', topIds, trendUnit);

  // #1 per year
  const yearly = splitByYear(D, sel.idx).map(([y, idx]) => {
    const g = groupStats(D, idx, sel.minMs, 'artist').sort((a, b) => b.ms - a.ms);
    let total = 0;
    for (const i of idx) total += D.ms[i];
    const fresh = idx.length ? discoveries(D, idx, 'year').artists[0] : 0;
    return { year: y, id: g[0]?.id, name: g[0] ? D.creators[g[0].id] : '—', ms: g[0]?.ms ?? 0, share: (g[0]?.ms ?? 0) / Math.max(1, total), second: g[1] ? D.creators[g[1].id] : '', fresh };
  }).reverse();

  const wholeHistory = sel.fromDay <= D.minDay && sel.toDay >= D.maxDay;
  const fullYears = yearly.filter((r) => r.year > D.year[0] && r.year < D.year[D.n - 1]);
  const bestYear = [...yearly].sort((a, b) => b.fresh - a.fresh)[0];
  const extraTiles = wholeHistory
    ? `${tile(`New ${W.artists} per year`, int(fullYears.reduce((a, r) => a + r.fresh, 0) / Math.max(1, fullYears.length)), 'Average over full calendar years')}
       ${tile('Biggest discovery year', bestYear ? String(bestYear.year) : '—', bestYear ? `${int(bestYear.fresh)} new ${W.artists}` : '')}`
    : `${tile(`Time on new ${W.artists}`, pct(newMs / Math.max(1, s.ms)), `Listening to ${W.artists} you found in this period`)}
       ${tile('Best new find', finds[0] ? D.creators[finds[0].id] : '—', finds[0] ? `${int(finds[0].value)} plays since ${date(finds[0].first)}` : '', { text: true })}`;

  const html = `
    <div class="tiles span-2">
      ${tile(`New ${W.artists}`, int(newArtists), 'First played in this period')}
      ${tile(`New ${W.tracks}`, int(newTracks), 'First played in this period')}
      ${extraTiles}
    </div>
    ${card({ id: 'c-new-artists', title: `New ${W.artists} per ${unit}`, sub: `${W.artists[0].toUpperCase()}${W.artists.slice(1)} you played for the first time`, height: 260 })}
    ${card({ id: 'c-new-tracks', title: `New ${W.tracks} per ${unit}`, sub: `${W.tracks[0].toUpperCase()}${W.tracks.slice(1)} you played for the first time`, height: 260 })}
    ${card({ id: 'c-trend', title: `Your top 5 ${W.artists} over time`, sub: `Hours per ${trendUnit}`, span: 2, height: 320 })}
    ${card({ id: 'c-finds', title: 'Best new finds', sub: `${W.artists[0].toUpperCase()}${W.artists.slice(1)} first played in this period, by plays`, height: rankHeight(finds.length) })}
    ${card({ id: 'c-yearly', title: `Your #1 ${W.artist.toLowerCase()} each year`, sub: 'By listening time', chart: false })}
  `;

  return {
    html,
    cards: [
      {
        id: 'c-new-artists',
        option: () => columnChart({ labels: disc.labels, data: disc.artists, valueFmt: int, name: `New ${W.artists}` }),
        table: () => ({ columns: [{ key: 'l', label: 'Period' }, { key: 'v', label: `New ${W.artists}`, num: true, fmt: int }], rows: disc.labels.map((l, i) => ({ l, v: disc.artists[i] })) }),
      },
      {
        id: 'c-new-tracks',
        option: () => columnChart({ labels: disc.labels, data: disc.tracks, valueFmt: int, name: `New ${W.tracks}`, color: getComputedStyle(document.documentElement).getPropertyValue('--series-2').trim() }),
        table: () => ({ columns: [{ key: 'l', label: 'Period' }, { key: 'v', label: `New ${W.tracks}`, num: true, fmt: int }], rows: disc.labels.map((l, i) => ({ l, v: disc.tracks[i] })) }),
      },
      {
        id: 'c-trend',
        option: () => lineChart({ labels: trend.labels, series: topIds.map((id, n) => ({ key: id, name: D.creators[id], data: trend.series[n].map(hours) })), area: false, scope: 'top-artists' }),
        table: () => ({
          columns: [{ key: 'l', label: 'Period' }, ...topIds.map((id) => ({ key: `a${id}`, label: D.creators[id], num: true, fmt: (v) => hoursFmt(v) }))],
          rows: trend.labels.map((l, i) => Object.fromEntries([['l', l], ...topIds.map((id, n) => [`a${id}`, hours(trend.series[n][i])])])),
        }),
      },
      { id: 'c-finds', ...rankCard(D, 'artist', finds, { metricName: 'Plays', go, subFn: (r) => `First played ${date(r.first)}` }) },
      {
        id: 'c-yearly',
        table: () => ({
          columns: [
            { key: 'year', label: 'Year' },
            { key: 'name', label: `#1 ${W.artist.toLowerCase()}`, sub: 'secondLabel', art: (r) => (r.id === undefined ? null : artistArt(D, r.id)), artRound: true },
            { key: 'ms', label: 'Time', num: true, fmt: duration },
            { key: 'share', label: 'Share of year', num: true, fmt: pct },
            { key: 'fresh', label: `New ${W.artists}`, num: true, fmt: int },
          ],
          rows: yearly.map((r) => ({ ...r, secondLabel: r.second ? `Then ${r.second}` : '' })),
          onRowClick: (r) => r.id !== undefined && go(exploreHash('artist', r.id)),
        }),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Devices & behaviour
// ---------------------------------------------------------------------------
function devices({ D, sel }) {
  const flags = flagShares(D, sel.idx);
  const s = sel.summary;
  const unit = s.lastDay - s.firstDay > 2 * 365 ? 'year' : 'month';

  const fam = countBy(D, sel.idx, 'family', sel.minMs);
  const topFam = fam.slice(0, 5).map((f) => f.id);
  const OTHER = -1;
  const showOther = fam.length > 5;
  const famKey = (i) => (topFam.includes(D.family[i]) ? D.family[i] : OTHER);
  const famIds = showOther ? [...topFam, OTHER] : topFam;
  const famTl = timelinesBy(D, sel.idx, famKey, famIds, unit);

  // Devices with first / last use
  const devMap = new Map();
  for (const i of sel.idx) {
    const d = D.device[i];
    let r = devMap.get(d);
    if (!r) devMap.set(d, (r = { id: d, family: D.families[D.family[i]], ms: 0, plays: 0, first: D.day[i], last: D.day[i] }));
    r.ms += D.ms[i];
    if (D.ms[i] >= sel.minMs) r.plays++;
    r.last = D.day[i];
  }
  const devRows = [...devMap.values()].map((r) => ({ ...r, name: D.devices[r.id] })).sort((a, b) => b.ms - a.ms);

  const total = sel.idx.length || 1;
  const starts = countRows(D, sel.idx, 'rs').slice(0, 8).map((r) => ({ name: reasonLabel(D.reasonsStart[r.id]), value: r.rows / total, rows: r.rows }));
  const ends = countRows(D, sel.idx, 're').slice(0, 8).map((r) => ({ name: reasonLabel(D.reasonsEnd[r.id]), value: r.rows / total, rows: r.rows }));
  const countries = countBy(D, sel.idx, 'country', sel.minMs).map((c) => ({ ...c, name: countryName(D.countries[c.id]) }));

  const reasonCard = (rows, metricName) => ({
    option: () => rankChart({ rows, valueFmt: pct, metricName }),
    table: () => ({ columns: [{ key: 'name', label: 'Reason' }, { key: 'rows', label: 'Plays', num: true, fmt: int }, { key: 'value', label: 'Share', num: true, fmt: pct }], rows }),
  });

  const html = `
    <div class="tiles span-2">
      ${tile('Main device', devRows[0]?.name ?? '—', devRows[0] ? `${pct(devRows[0].ms / Math.max(1, s.ms))} of listening time` : '', { text: true })}
      ${tile('Shuffle on', pct(flags.shuffle), 'Share of plays')}
      ${tile('Offline', pct(flags.offline), 'Played from downloads')}
      ${tile('Private session', pct(flags.incognito), 'Share of plays')}
      ${tile('Countries', int(countries.filter((c) => c.name !== 'Unknown').length), countries[0] ? `Mostly ${countries[0].name}` : '')}
    </div>
    ${card({ id: 'c-family', title: 'Where you listen', sub: `Hours per ${unit} by device type`, span: 2, height: 320 })}
    ${card({ id: 'c-start', title: 'How plays start', sub: 'Share of all plays', height: rankHeight(starts.length) })}
    ${card({ id: 'c-end', title: 'How plays end', sub: 'Share of all plays', height: rankHeight(ends.length) })}
    ${card({ id: 'c-devices', title: 'Devices', sub: 'Every device in your history', chart: false, scroll: true })}
    ${card({ id: 'c-countries', title: 'Countries', sub: 'Where you connected from', chart: false, scroll: true })}
  `;

  return {
    html,
    cards: [
      {
        id: 'c-family',
        option: () => stackedColumns({
          labels: famTl.labels,
          series: famIds.map((id, n) => ({ key: id === OTHER ? 'Other' : D.families[id], name: id === OTHER ? 'Other' : D.families[id], data: famTl.series[n].map(hours) })),
          scope: 'families',
        }),
        table: () => ({
          columns: [{ key: 'l', label: 'Period' }, ...famIds.map((id) => ({ key: `f${id}`, label: id === OTHER ? 'Other' : D.families[id], num: true, fmt: (v) => hoursFmt(v) }))],
          rows: famTl.labels.map((l, i) => Object.fromEntries([['l', l], ...famIds.map((id, n) => [`f${id}`, hours(famTl.series[n][i])])])),
        }),
      },
      { id: 'c-start', ...reasonCard(starts, 'Share') },
      { id: 'c-end', ...reasonCard(ends, 'Share') },
      {
        id: 'c-devices',
        table: () => ({
          columns: [
            { key: 'name', label: 'Device', sub: 'family' },
            { key: 'ms', label: 'Time', num: true, fmt: duration },
            { key: 'plays', label: 'Plays', num: true, fmt: int },
            { key: 'first', label: 'First used', num: true, fmt: (v) => date(v) },
            { key: 'last', label: 'Last used', num: true, fmt: (v) => date(v) },
          ],
          rows: devRows,
        }),
      },
      {
        id: 'c-countries',
        table: () => ({
          columns: [{ key: 'name', label: 'Country' }, { key: 'ms', label: 'Time', num: true, fmt: duration }, { key: 'plays', label: 'Plays', num: true, fmt: int }],
          rows: countries,
        }),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Explore one artist, track or album
// ---------------------------------------------------------------------------
let searchIndex = null;
function buildSearchIndex(D) {
  if (searchIndex) return searchIndex;
  const out = [];
  D.creators.forEach((name, id) => out.push({ by: 'artist', id, name, sub: D.creatorKind[id] === 0 ? 'Artist' : 'Show', total: D.creatorTotal[id] }));
  for (let id = 0; id < D.items.count; id++) {
    out.push({ by: 'track', id, name: D.items.name[id], sub: `${D.items.kind[id] === 0 ? 'Track' : 'Episode'} · ${artistNames(D, id)}`, total: D.itemTotal[id] });
  }
  D.albums.forEach((a, id) => {
    if (D.creatorKind[a.creator] === 0) out.push({ by: 'album', id, name: a.name, sub: `Album · ${D.creators[a.creator]}`, total: D.albumTotal[id] });
  });
  out.sort((a, b) => b.total - a.total);
  for (const e of out) e.lower = `${e.name} ${e.sub}`.toLowerCase();
  searchIndex = out;
  return out;
}

function explore({ D, sel, params, go }) {
  const by = ['artist', 'track', 'album'].includes(params[0]) ? params[0] : null;
  const id = by ? Number(params[1]) : NaN;
  const valid = by && Number.isInteger(id) && id >= 0 && id < (by === 'track' ? D.items.count : by === 'artist' ? D.creators.length : D.albums.length);

  const searchHtml = `
    <div class="search-box">
      <input type="search" class="search-input" id="explore-q" placeholder="Search for an artist, track, album or podcast" autocomplete="off" aria-label="Search">
      <div class="search-results" id="explore-results" hidden></div>
    </div>`;

  const after = (root) => {
    bindButtons(root, go);
    const input = root.querySelector('#explore-q');
    const results = root.querySelector('#explore-results');
    const index = buildSearchIndex(D);
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      if (!q) { results.hidden = true; return; }
      const terms = q.split(/\s+/);
      const hits = [];
      for (const e of index) {
        if (terms.every((t) => e.lower.includes(t))) hits.push(e);
        if (hits.length >= 30) break;
      }
      results.replaceChildren(...(hits.length ? hits.map((h) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'result';
        const left = document.createElement('span');
        left.className = 'result-main';
        const label = document.createElement('span');
        label.textContent = h.name;
        left.append(artNode(entityArt(D, h.by, h.id), { size: 32, round: h.by === 'artist', label: h.name }), label);
        const right = document.createElement('span');
        right.className = 'kind';
        right.textContent = `${h.sub} · ${int(h.total)} plays`;
        b.append(left, right);
        b.addEventListener('click', () => go(exploreHash(h.by, h.id)));
        return b;
      }) : [Object.assign(document.createElement('div'), { className: 'muted', style: 'padding:10px', textContent: 'No matches' })]));
      results.hidden = false;
    };
    input.addEventListener('input', draw);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') results.querySelector('.result')?.click();
      if (e.key === 'Escape') { input.value = ''; results.hidden = true; }
    });
    root.querySelector('.search-box').addEventListener('focusout', (e) => {
      if (!e.currentTarget.contains(e.relatedTarget)) results.hidden = true;
    });
    if (!valid) input.focus();
  };

  if (!valid) {
    const W = words(sel.kind);
    const artists = [...sel.group('artist')].sort((a, b) => b.ms - a.ms).slice(0, 12);
    const tracks = sel.group('track').slice(0, 12);
    const chip = (b, i, label) => `<button type="button" class="chip" data-href="${exploreHash(b, i)}">${artHTML(entityArt(D, b, i), { round: b === 'artist', label })}${esc(label)}</button>`;
    return {
      html: `${searchHtml}
        <section class="card span-2"><header class="card-head"><div><h3>Start with your top ${W.artists}</h3><p>Or search above for anything you've played</p></div></header>
          <div class="chips">${artists.map((a) => chip('artist', a.id, D.creators[a.id])).join('')}</div></section>
        <section class="card span-2"><header class="card-head"><div><h3>…or your top ${W.tracks}</h3></div></header>
          <div class="chips">${tracks.map((t) => chip('track', t.id, `${D.items.name[t.id]} · ${artistNames(D, t.id)}`)).join('')}</div></section>`,
      cards: [],
      after,
    };
  }

  const sub = playsOf(D, sel.idx, by, id);
  const label = entityLabel(D, by, id);
  const creatorId = by === 'artist' ? id : by === 'track' ? D.items.creator[id] : D.albums[id].creator;
  const isPodcast = D.creatorKind[creatorId] !== 0;
  const typeName = by === 'artist' ? (isPodcast ? 'Show' : 'Artist') : by === 'track' ? (isPodcast ? 'Episode' : 'Track') : 'Album';

  let meta = '';
  if (by !== 'artist') {
    const credited = by === 'track' ? [D.items.creator[id], ...D.extra[id].filter((c) => c !== D.items.creator[id])] : [creatorId];
    meta = `by ${credited.map((c) => `<button type="button" data-href="${exploreHash('artist', c)}">${esc(D.creators[c])}</button>`).join(', ')}`;
    if (by === 'track' && !isPodcast) {
      const albumId = D.items.album[id];
      meta += ` · <button type="button" data-href="${exploreHash('album', albumId)}">${esc(D.albums[albumId].name)}</button>`;
    }
  }
  const head = `<div class="entity-head">
    ${artHTML(entityArt(D, by, id), { round: by === 'artist', label: label.name })}
    <div class="entity-text">
      <div class="row"><span class="pill">${typeName}</span><h2>${esc(label.name)}</h2></div>
      ${meta ? `<span class="meta">${meta}</span>` : ''}
    </div>
  </div>`;

  if (!sub.length) {
    return {
      html: `${searchHtml}${head}<div class="state-msg">No plays of this ${typeName.toLowerCase()} in the selected period and content type.</div>`,
      cards: [],
      after,
    };
  }

  let ms = 0, plays = 0, skips = 0;
  const daySet = new Set();
  for (const i of sub) { ms += D.ms[i]; if (D.ms[i] >= sel.minMs) plays++; if (D.skip[i]) skips++; daySet.add(D.day[i]); }
  const first = D.day[sub[0]];
  const last = D.day[sub[sub.length - 1]];
  const unit = last - first > 120 ? 'month' : 'day';
  const tl = timeline(D, sub, sel.minMs, unit);
  const hourMs = new Array(24).fill(0);
  const wdMs = new Array(7).fill(0);
  for (const i of sub) { hourMs[D.hour[i]] += D.ms[i]; wdMs[D.weekday[i]] += D.ms[i]; }

  // Rank among everything in the period
  const allStats = sel.group(by);
  const rank = allStats.findIndex((r) => r.id === id) + 1;

  const trackStats = by === 'track' ? null : entityRows(D, 'track', groupStats(D, sub, sel.minMs, 'track'));
  const albumStats = by === 'artist' && !isPodcast ? entityRows(D, 'album', groupStats(D, sub, sel.minMs, 'album')) : null;

  const tiles = [
    tile('Plays', int(plays), rank ? `#${int(rank)} in this period` : ''),
    tile('Listening time', duration(ms)),
    tile('Days played', int(daySet.size)),
    tile('First played', date(first), '', { text: true }),
    tile('Last played', date(last), '', { text: true }),
    tile('Skipped', pct(skips / sub.length), 'Ended with next or back'),
  ];
  if (trackStats) tiles.splice(2, 0, tile(isPodcast ? 'Episodes' : 'Different tracks', int(trackStats.filter((t) => t.rows).length)));

  const W = words(isPodcast ? 'podcasts' : 'music');
  const html = `${searchHtml}${head}
    <div class="tiles span-2">${tiles.join('')}</div>
    ${card({ id: 'c-ent-tl', title: 'Plays over time', sub: `Plays per ${unit}`, span: 2, height: 260 })}
    ${card({ id: 'c-ent-hour', title: 'Time of day', sub: 'Share of listening by hour', height: 240 })}
    ${card({ id: 'c-ent-wd', title: 'Day of week', sub: 'Share of listening by weekday', height: 240 })}
    ${by === 'track'
      ? card({ id: 'c-ent-log', title: 'Every play', sub: `${int(sub.length)} plays, newest first`, span: 2, chart: false, scroll: true })
      : card({ id: 'c-ent-tracks', title: by === 'artist' ? `Top ${W.tracks}` : 'Tracks on this album', sub: 'Click a row for details', span: 2, chart: false, scroll: true })}
    ${albumStats ? card({ id: 'c-ent-albums', title: 'Albums', sub: 'Click a row for details', span: 2, chart: false, scroll: true }) : ''}
  `;

  const cards = [
    {
      id: 'c-ent-tl',
      option: () => columnChart({ labels: tl.labels, data: tl.plays, valueFmt: int, name: 'Plays' }),
      table: () => timelineTable(tl),
    },
    {
      id: 'c-ent-hour',
      option: () => columnChart({ labels: hourMs.map((_, h) => String(h).padStart(2, '0')), data: hourMs.map((v) => v / Math.max(1, ms)), valueFmt: pct, name: 'Share' }),
      table: () => ({ columns: [{ key: 'h', label: 'Hour' }, { key: 'v', label: 'Time', num: true, fmt: duration }], rows: hourMs.map((v, h) => ({ h: `${String(h).padStart(2, '0')}:00`, v })) }),
    },
  ];

  cards.push({
    id: 'c-ent-wd',
    option: () => columnChart({ labels: WEEKDAYS, data: wdMs.map((v) => v / Math.max(1, ms)), valueFmt: pct, name: 'Share' }),
    table: () => ({ columns: [{ key: 'd', label: 'Day' }, { key: 'v', label: 'Time', num: true, fmt: duration }], rows: WEEKDAYS.map((d, i) => ({ d, v: wdMs[i] })) }),
  });

  if (by === 'track') {
    cards.push({
      id: 'c-ent-log',
      table: () => ({
        columns: [
          { key: 'when', label: 'When', sortValue: (r) => r.t },
          { key: 'played', label: 'Played', num: true, sortValue: (r) => r.ms },
          { key: 'device', label: 'Device' },
          { key: 'how', label: 'How it ended' },
        ],
        rows: Array.from(sub).reverse().map((i) => ({
          t: D.start[i], when: dateTime(D.start[i]), ms: D.ms[i], played: clock(D.ms[i]),
          device: D.devices[D.device[i]], how: reasonLabel(D.reasonsEnd[D.re[i]]),
        })),
        limit: 1000,
      }),
    });
  } else {
    cards.push({
      id: 'c-ent-tracks',
      table: () => ({
        columns: entityColumns('track', W, D, { art: by === 'artist' }),
        rows: trackStats.map((t) => (by === 'artist' ? { ...t, sub: D.albums[D.items.album[t.id]].name } : t)),
        onRowClick: (r) => go(exploreHash('track', r.id)),
      }),
    });
  }
  if (albumStats) {
    cards.push({
      id: 'c-ent-albums',
      table: () => ({
        columns: entityColumns('album', W, D).map((c) => (c.key === 'name' ? { ...c, sub: undefined } : c)),
        rows: albumStats,
        onRowClick: (r) => go(exploreHash('album', r.id)),
      }),
    });
  }

  return { html, cards, after };
}

export const VIEWS = { overview, top, repeat, habits, discovery, devices, explore };
export { bucketLabel };
