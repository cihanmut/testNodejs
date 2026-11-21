// Python urllib.parse.quote / urlencode equivalents (safe='' by default: everything except
// A-Z a-z 0-9 _ . - ~ is percent-encoded, as UTF-8 bytes).
const UNRESERVED = /[A-Za-z0-9_.\-~]/;

export function quote(text, safe = '') {
  let out = '';
  for (const byte of Buffer.from(String(text), 'utf8')) {
    const ch = String.fromCharCode(byte);
    if (byte < 128 && (UNRESERVED.test(ch) || safe.includes(ch))) out += ch;
    else out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** urlencode(pairs, quote_via=quote): "k=v&k2=v2" */
export function urlencode(pairs) {
  return pairs.map(([k, v]) => quote(k) + '=' + quote(v)).join('&');
}

/** parse_qsl for application/x-www-form-urlencoded bodies */
export function parseQsl(text) {
  if (!text) return [];
  return text.split('&').filter(Boolean).map((part) => {
    const i = part.indexOf('=');
    const k = i < 0 ? part : part.slice(0, i);
    const v = i < 0 ? '' : part.slice(i + 1);
    const dec = (s) => decodeURIComponent(s.replace(/\+/g, ' '));
    return [dec(k), dec(v)];
  });
}
