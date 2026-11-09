import { dayToDate } from './data.js';

const intFmt = new Intl.NumberFormat();
const compactFmt = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const pctFmt = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 });
const oneDec = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

export const int = (n) => intFmt.format(Math.round(n));
export const compact = (n) => (Math.abs(n) < 1000 ? int(n) : compactFmt.format(n));
export const pct = (x) => pctFmt.format(x || 0);
export const hours = (ms) => ms / 3600000;
export const minutes = (ms) => ms / 60000;

/** "1,234 h", "45 min", or "38 s" depending on size. */
export function duration(ms) {
  const h = ms / 3600000;
  if (h >= 10) return `${int(h)} h`;
  if (h >= 1) return `${oneDec.format(h)} h`;
  const m = ms / 60000;
  if (m >= 1) return `${int(m)} min`;
  return `${int(ms / 1000)} s`;
}

/** Track length style: 3:25 */
export function clock(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function date(day, opts = { year: 'numeric', month: 'short', day: 'numeric' }) {
  if (day === null || day === undefined || day < 0) return '—';
  return dayToDate(day).toLocaleDateString(undefined, { timeZone: 'UTC', ...opts });
}

export function dateTime(epochMs) {
  return new Date(epochMs).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export const REASON_LABELS = {
  trackdone: 'Track finished',
  clickrow: 'Picked a track',
  fwdbtn: 'Next button',
  backbtn: 'Back button',
  appload: 'App opened',
  playbtn: 'Play button',
  trackerror: 'Playback error',
  remote: 'Remote control',
  endplay: 'Stopped or switched',
  logout: 'Logged out / app closed',
  'unexpected-exit-while-paused': 'App closed while paused',
  'unexpected-exit': 'App closed unexpectedly',
  persisted: 'Resumed',
  popup: 'Pop-up',
  clickside: 'Side panel',
  'switched-to-video': 'Switched to video',
  unknown: 'Unknown',
  '': 'Unknown',
};

export const reasonLabel = (r) => REASON_LABELS[r] ?? r;

const COUNTRY_NAMES = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(undefined, { type: 'region' }) : null;
export function countryName(code) {
  if (!code || code === 'ZZ') return 'Unknown';
  try {
    return COUNTRY_NAMES?.of(code) ?? code;
  } catch {
    return code;
  }
}

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
