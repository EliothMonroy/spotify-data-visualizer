// Artist photos and album covers. Links already saved in the database come with the dataset;
// anything else is looked up through the local server (/api/artwork).
// Images load only when scrolled into view; initials show until (or unless) one arrives.
import { esc } from './format.js';

const PREF_KEY = 'sdv:artwork';
const MAX_CONCURRENT = 4;

let enabled = readPref();
let available = true; // false when the server was started with ARTWORK=off
const results = new Map(); // lookup key -> Promise<{ thumb, full, source, link } | null>
let active = 0;
const waiting = [];

function readPref() {
  try {
    return localStorage.getItem(PREF_KEY) !== 'off';
  } catch {
    return true;
  }
}

function syncRootClass() {
  document.documentElement.classList.toggle('no-art', !artworkEnabled());
}

export const artworkEnabled = () => enabled && available;

export function setArtworkEnabled(on) {
  enabled = on;
  try { localStorage.setItem(PREF_KEY, on ? 'on' : 'off'); } catch { /* storage unavailable */ }
  syncRootClass();
}
syncRootClass();

function schedule(task) {
  return new Promise((resolve) => {
    waiting.push(() => task().then(resolve, () => resolve(null)).finally(() => { active--; pump(); }));
    pump();
  });
}
function pump() {
  while (active < MAX_CONCURRENT && waiting.length) {
    active++;
    waiting.shift()();
  }
}

// Ask the server once whether artwork is allowed (it is off with ARTWORK=off or without a database).
let statusCheck = null;
function serverAllowsArt() {
  statusCheck ??= fetch('api/artwork/status')
    .then((r) => (r.ok ? r.json() : { enabled: false }))
    .then((j) => { if (j?.enabled !== true) { available = false; syncRootClass(); } })
    .catch(() => {});
  return statusCheck;
}

export function fetchArt({ type, artist, name = '', hint = '' }) {
  const key = `${type}|${artist}|${name}`;
  if (!results.has(key)) {
    const qs = new URLSearchParams({ type, artist });
    if (name) qs.set('name', name);
    if (hint) qs.set('hint', hint);
    results.set(key, schedule(async () => {
      const res = await fetch(`api/artwork?${qs}`);
      if (res.status === 404) { available = false; syncRootClass(); return null; }
      if (!res.ok) { results.delete(key); return null; } // let a later view retry
      const json = await res.json();
      return json.thumb ? json : null;
    }));
  }
  return results.get(key);
}

// ---- what to look up for each entity (music only; podcasts are skipped) ----

const cleanTitle = (t) => String(t ?? '').replace(/\s*[([].*$/, '').replace(/\s+-\s+.*$/, '').trim();

const saved = (img) => (img ? { thumb: img[0], full: img[1], source: img[2], link: img[3] } : undefined);

export function artistArt(D, c) {
  if (c < 0 || D.creatorKind[c] !== 0) return null;
  const top = D.creatorTopItem[c];
  return { type: 'artist', artist: D.creators[c], hint: top >= 0 ? cleanTitle(D.items.name[top]) : '', direct: saved(D.creatorImages[c]) };
}

export function albumArt(D, a) {
  const al = D.albums[a];
  if (!al || D.creatorKind[al.creator] !== 0) return null;
  return { type: 'album', artist: D.creators[al.creator], name: al.name, direct: saved(D.albumImages[a]) };
}

export function entityArt(D, by, id) {
  if (by === 'artist') return artistArt(D, id);
  if (by === 'album') return albumArt(D, id);
  return D.items.kind[id] === 0 ? albumArt(D, D.items.album[id]) : null;
}

// ---- rendering ----

function initials(label) {
  const words = String(label ?? '').replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')).toUpperCase() || '♪';
}

const observer = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        observer.unobserve(e.target);
        load(e.target);
      }
    }, { rootMargin: '300px' })
  : null;

async function load(el) {
  if (!artworkEnabled() || !el.artSpec) return;
  await serverAllowsArt();
  if (!artworkEnabled()) return;
  const art = el.artSpec.direct ?? (await fetchArt(el.artSpec));
  if (!art || !el.isConnected) return;
  const img = new Image();
  img.alt = '';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  img.addEventListener('load', () => el.classList.add('loaded'));
  img.addEventListener('error', () => img.remove());
  img.src = el.clientWidth * (window.devicePixelRatio || 1) > 260 ? art.full : art.thumb;
  el.appendChild(img);
  el.title = `Image: ${art.source}`;
}

/** HTML for an image slot. Call hydrateArt(root) after inserting it. */
export function artHTML(spec, { size, round = false, label = '', className = '' } = {}) {
  const style = size ? ` style="--art-size:${size}px"` : '';
  const data = spec ? ` data-art="${esc(JSON.stringify(spec))}"` : '';
  return `<span class="art${round ? ' round' : ''}${className ? ` ${className}` : ''}"${style}${data} data-initials="${esc(initials(label))}" aria-hidden="true"></span>`;
}

/** DOM node version of artHTML, already observed. */
export function artNode(spec, opts = {}) {
  const tpl = document.createElement('template');
  tpl.innerHTML = artHTML(spec, opts);
  const el = tpl.content.firstElementChild;
  hydrateOne(el);
  return el;
}

function hydrateOne(el) {
  if (!el.dataset.art) return;
  el.artSpec = JSON.parse(el.dataset.art);
  el.removeAttribute('data-art');
  if (observer) observer.observe(el);
  else load(el);
}

export function hydrateArt(root) {
  root.querySelectorAll('.art[data-art]').forEach(hydrateOne);
}
