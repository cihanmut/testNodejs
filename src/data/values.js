// Seeded values and template rendering.
//
// Determinism: seeds are derived with sha256, so the same seed + key always gives the same values.
// Templates (overrides / resource bodies):
//   {runId} {n} {unique_int} {unique_int:1..999} {unique_digits:13} {date:-7d} {day:-1d} {now} {<kind>.<field>}
// A string that is exactly one placeholder becomes a typed value (int, ResourceRef, ...).
import crypto from 'node:crypto';
import { Day, ZonedDateTime, parseOffset } from '../util/dates.js';
import { normInt } from '../util/json.js';
import { pyStr } from '../util/py.js';
import { ResourceRef } from './request.js';

export const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)?)(?::([^{}]*))?\}/g;
const PLACEHOLDER_FULL = /^\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)?)(?::([^{}]*))?\}$/;
export const UNIQUE_LOW = 9n * 10n ** 15n;
export const UNIQUE_HIGH = 9200000000000000000n;

export function stableSeed(...parts) {
  const digest = crypto.createHash('sha256').update(parts.map(pyStr).join('|'), 'utf8').digest();
  return digest.readBigUInt64BE(0);
}

/** Python's random.Random: the same Mersenne Twister (MT19937), the same seeding (init_by_array with the
 *  seed's 32-bit words) and the same randint algorithm (getrandbits + rejection). So a given seed produces
 *  exactly the values the Python version produces. Integers beyond 2^53 are BigInt. */
export class Rng {
  constructor(seed) {
    this.mt = new Uint32Array(624);
    this.mti = 625;
    let s = BigInt(seed);
    if (s < 0n) s = -s;
    const key = [];
    while (s > 0n) {
      key.push(Number(s & 0xffffffffn));
      s >>= 32n;
    }
    this.initByArray(key.length ? key : [0]);
  }

  initGenrand(s) {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < 624; i++) mt[i] = (Math.imul(1812433253, mt[i - 1] ^ (mt[i - 1] >>> 30)) + i) >>> 0;
    this.mti = 624;
  }

  initByArray(key) {
    const mt = this.mt;
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    for (let k = Math.max(624, key.length); k; k--) {
      mt[i] = ((mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1664525)) + key[j] + j) >>> 0;
      i++;
      j++;
      if (i >= 624) { mt[0] = mt[623]; i = 1; }
      if (j >= key.length) j = 0;
    }
    for (let k = 623; k; k--) {
      mt[i] = ((mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1566083941)) - i) >>> 0;
      i++;
      if (i >= 624) { mt[0] = mt[623]; i = 1; }
    }
    mt[0] = 0x80000000;
  }

  uint32() {
    const mt = this.mt;
    if (this.mti >= 624) {
      let kk = 0;
      const mix = (a, b) => (a & 0x80000000) | (b & 0x7fffffff);
      for (; kk < 624 - 397; kk++) {
        const y = mix(mt[kk], mt[kk + 1]);
        mt[kk] = mt[kk + 397] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      for (; kk < 623; kk++) {
        const y = mix(mt[kk], mt[kk + 1]);
        mt[kk] = mt[kk + (397 - 624)] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      const y = mix(mt[623], mt[0]);
      mt[623] = mt[396] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      this.mti = 0;
    }
    let y = mt[this.mti++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** random.getrandbits(k) as BigInt */
  getrandbits(k) {
    if (k <= 32) return BigInt(this.uint32() >>> (32 - k));
    let out = 0n;
    let shift = 0n;
    for (let left = k; left > 0; left -= 32) {
      let r = this.uint32();
      if (left < 32) r >>>= 32 - left;
      out |= BigInt(r) << shift;
      shift += 32n;
    }
    return out;
  }

  /** inclusive, like random.randint */
  randint(lo, hi) {
    lo = BigInt(lo);
    hi = BigInt(hi);
    const n = hi - lo + 1n;
    if (n <= 0n) throw new RangeError(`empty range for randint(${lo}, ${hi})`);
    const k = n.toString(2).length;
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return normInt(lo + r);
  }
}

export function formatDatetime(dt) {
  return dt.format();
}

export class ValueContext {
  constructor(runId, seed = 42, tzOffset = '+03:00', today = null) {
    this.run_id = runId;
    this.seed = seed;
    this.offset = parseOffset(tzOffset);
    this.today = today || ZonedDateTime.now(this.offset).date();
    this._counter = 0;
    this._uniqueRng = new Rng(stableSeed(seed, runId, 'unique'));
  }

  rng(...key) {
    return new Rng(stableSeed(this.seed, ...key));
  }

  nextN() {
    this._counter += 1;
    return this._counter;
  }

  uniqueInt(low = UNIQUE_LOW, high = UNIQUE_HIGH) {
    return this._uniqueRng.randint(low, high);
  }

  day(deltaDays = 0) {
    return this.today.addDays(deltaDays);
  }

  midnight(deltaDays = 0) {
    const d = this.day(deltaDays);
    return new ZonedDateTime(d.year, d.month, d.day, 0, 0, 0, this.offset).format();
  }

  firstOfPreviousMonth() {
    const prev = new Day(this.today.year, this.today.month, 1).addDays(-1);
    return new ZonedDateTime(prev.year, prev.month, 1, 0, 0, 0, this.offset).format();
  }

  now() {
    return ZonedDateTime.now(this.offset).format();
  }
}

function days(arg) {
  if (!arg) return 0;
  const m = /^([+-]?\d+)d$/.exec(arg.trim());
  if (!m) throw new Error(`bad day offset '${arg}', expected like -7d`);
  return Number(m[1]);
}

function renderOne(name, arg, ctx, n) {
  if (name.includes('.')) {
    const i = name.indexOf('.');
    return new ResourceRef(name.slice(0, i), 'read', name.slice(i + 1));
  }
  switch (name) {
    case 'runId':
      return ctx.run_id;
    case 'n':
      return n;
    case 'unique_int':
      if (arg) {
        const [lo, hi] = arg.split('..').map((x) => BigInt(x.trim()));
        return ctx.uniqueInt(lo, hi);
      }
      return ctx.uniqueInt();
    case 'unique_digits': { // e.g. a unique ISBN-13 made of digits only
      const nDigits = Number(arg || 10);
      let out = '';
      for (let i = 0; i < nDigits; i++) out += String(ctx.uniqueInt(0, 9));
      return out;
    }
    case 'date':
      return ctx.midnight(days(arg));
    case 'day':
      return ctx.day(days(arg)).iso();
    case 'now':
      return ctx.now();
    default:
      throw new Error(`unknown template placeholder {${name}}`);
  }
}

/** Render placeholders recursively. {n} is the same number within one render call. */
export function renderTemplate(value, ctx, n = null) {
  if (n === null) n = ctx.nextN();
  if (Array.isArray(value)) return value.map((v) => renderTemplate(v, ctx, n));
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = renderTemplate(v, ctx, n);
    return out;
  }
  if (typeof value !== 'string' || !value.includes('{')) return value;
  const full = PLACEHOLDER_FULL.exec(value);
  if (full) return renderOne(full[1], full[2], ctx, n);
  return value.replace(PLACEHOLDER, (m, name, arg) => {
    const out = renderOne(name, arg, ctx, n);
    if (out instanceof ResourceRef) throw new Error(`resource reference ${m} must be the whole value, not part of a string`);
    return pyStr(out);
  });
}
