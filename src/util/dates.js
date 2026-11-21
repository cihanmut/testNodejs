// Minimal timezone-offset-aware dates (Python datetime with a fixed-offset tzinfo). Only what the tool
// needs: calendar days, "yyyy-MM-dd'T'HH:mm:ssXXX" formatting, ISO parsing, day arithmetic.

const p2 = (n) => String(n).padStart(2, '0');
const p4 = (n) => String(n).padStart(4, '0');

/** "+03:00" / "-0530" -> minutes; anything else -> 0 (UTC), like the Python version. */
export function parseOffset(offset) {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(String(offset || '').trim());
  if (!m) return 0;
  return (m[1] === '+' ? 1 : -1) * (Number(m[2]) * 60 + Number(m[3]));
}

export function formatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const a = Math.abs(minutes);
  return `${sign}${p2(Math.floor(a / 60))}:${p2(a % 60)}`;
}

/** A calendar date (Python datetime.date). */
export class Day {
  constructor(year, month, day) {
    this.year = year;
    this.month = month;
    this.day = day;
    Object.freeze(this);
  }

  static fromUTCms(ms) {
    const d = new Date(ms);
    return new Day(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }

  addDays(n) {
    const d = new Date(0);
    d.setUTCFullYear(this.year, this.month - 1, this.day + n);
    return Day.fromUTCms(d.getTime());
  }

  iso() {
    return `${p4(this.year)}-${p2(this.month)}-${p2(this.day)}`;
  }

  toString() {
    return this.iso();
  }
}

/** Wall-clock date-time with a fixed UTC offset (Python aware datetime). */
export class ZonedDateTime {
  constructor(year, month, day, hour, minute, second, offsetMinutes) {
    Object.assign(this, { year, month, day, hour, minute, second, offsetMinutes });
    Object.freeze(this);
  }

  /** Python datetime + timedelta(days=n): the wall clock moves, the offset stays. */
  addDays(n) {
    const d = new Date(0);
    d.setUTCFullYear(this.year, this.month - 1, this.day + n);
    d.setUTCHours(this.hour, this.minute, this.second, 0);
    return new ZonedDateTime(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), this.offsetMinutes);
  }

  /** Python datetime.replace(year=, month=, day=): raises if the date does not exist. */
  replace({ year = this.year, month = this.month, day = this.day } = {}) {
    if (!validDate(year, month, day)) throw new RangeError(`day is out of range for month: ${year}-${month}-${day}`);
    return new ZonedDateTime(year, month, day, this.hour, this.minute, this.second, this.offsetMinutes);
  }

  /** epoch milliseconds (for comparisons) */
  get epochMs() {
    const d = new Date(0);
    d.setUTCFullYear(this.year, this.month - 1, this.day);
    d.setUTCHours(this.hour, this.minute, this.second, 0);
    return d.getTime() - this.offsetMinutes * 60000;
  }

  date() {
    return new Day(this.year, this.month, this.day);
  }

  /** yyyy-MM-dd'T'HH:mm:ssXXX, e.g. 2023-11-14T17:30:00+03:00 (the EPİAŞ format). */
  format() {
    return `${p4(this.year)}-${p2(this.month)}-${p2(this.day)}T${p2(this.hour)}:${p2(this.minute)}:${p2(this.second)}${formatOffset(this.offsetMinutes)}`;
  }

  static now(offsetMinutes) {
    const d = new Date(Date.now() + offsetMinutes * 60000);
    return new ZonedDateTime(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), offsetMinutes);
  }
}

export function validDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1) return false;
  const days = new Date(Date.UTC(2000, m, 0)).getUTCDate();
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return d <= (m === 2 ? (leap ? 29 : 28) : days);
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d{1,6}))?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

/** Python datetime.fromisoformat(text.replace("Z", "+00:00")); null if invalid or without an offset. */
export function parseAwareDatetime(text) {
  const m = ISO_RE.exec(String(text).trim() === text ? text : '');
  if (!m || !m[8]) return null;
  const [y, mo, d, h, mi = '0', s = '0'] = m.slice(1, 7);
  const Y = Number(y);
  const M = Number(mo);
  const D = Number(d);
  const H = Number(h);
  const MI = Number(mi);
  const S = Number(s);
  if (!validDate(Y, M, D) || H > 23 || MI > 59 || S > 59) return null;
  let off = 0;
  if (m[8] !== 'Z') {
    const om = /^([+-])(\d{2}):?(\d{2})?$/.exec(m[8]);
    if (!om) return null;
    off = (om[1] === '+' ? 1 : -1) * (Number(om[2]) * 60 + Number(om[3] || 0));
  }
  return new ZonedDateTime(Y, M, D, H, MI, S, off);
}
