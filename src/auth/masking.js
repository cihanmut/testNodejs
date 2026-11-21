// Credential masking: only the last 4 characters are ever shown.
import { isPlainObject } from '../util/json.js';

export function mask(value) {
  if (!value) return '';
  return value.length > 8 ? '****' + value.slice(-4) : '****';
}

/** Replace every occurrence of any secret in text by its masked form (longest first). */
export function redact(text, secrets) {
  const list = [...new Set([...secrets].filter((s) => s && s.length >= 4))].sort((a, b) => b.length - a.length);
  for (const s of list) text = text.split(s).join(mask(s));
  return text;
}

export function redactObj(obj, secrets) {
  secrets = [...secrets];
  if (typeof obj === 'string') return redact(obj, secrets);
  if (Array.isArray(obj)) return obj.map((v) => redactObj(v, secrets));
  if (isPlainObject(obj)) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[redact(k, secrets)] = redactObj(v, secrets);
    return out;
  }
  return obj;
}
