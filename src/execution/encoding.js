// Request body encodings: json | form (x-www-form-urlencoded) | multipart (form-data) | binary.
//
// Returns the bytes to send, the Content-Type header, a human-readable form for reports, and what curl
// needs to reproduce it (data text, -F parts, or a file for --data-binary).
import { FileValue, OMIT } from '../data/request.js';
import { dumps, isPlainObject } from '../util/json.js';
import { pyStr } from '../util/py.js';
import { urlencode } from '../util/url.js';

export const BOUNDARY = '----apitestBoundary7f3c9a1e';

export class EncodedBody {
  constructor(content, content_type, display, { data_text = null, form_parts = [], binary_file = null } = {}) {
    this.content = content;
    this.content_type = content_type;
    this.display = display; // text shown in reports (files summarised)
    this.data_text = data_text; // curl --data-raw (json/form)
    this.form_parts = form_parts; // curl -F (multipart): [name, value] pairs
    this.binary_file = binary_file; // curl --data-binary @file
  }
}

/** Value as text (form fields, query parameters, headers). */
export function textOf(v) {
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (v === null || v === undefined) return '';
  if (Array.isArray(v) || isPlainObject(v)) return dumps(v);
  if (v instanceof FileValue) return v.repr();
  return pyStr(v);
}

function pairs(body) {
  if (!isPlainObject(body)) return [['body', body]];
  const out = [];
  for (const [k, v] of Object.entries(body)) {
    if (v === OMIT) continue;
    if (Array.isArray(v)) for (const x of v) out.push([k, x]);
    else out.push([k, v]);
  }
  return out;
}

export function encodeBody(encoding, body, contentType) {
  if (encoding === 'form') {
    const text = urlencode(pairs(body).map(([k, v]) => [k, textOf(v)]));
    return new EncodedBody(Buffer.from(text, 'utf8'), contentType || 'application/x-www-form-urlencoded', text, { data_text: text });
  }
  if (encoding === 'multipart') {
    const chunks = [];
    const display = [];
    const parts = [];
    for (const [name, v] of pairs(body)) {
      const head = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"`;
      if (v instanceof FileValue) {
        chunks.push(Buffer.from(head + `; filename="${v.filename}"\r\nContent-Type: ${v.content_type}\r\n\r\n`, 'utf8'), v.data, Buffer.from('\r\n'));
        display.push(`${name}=${v.repr()}`);
      } else {
        chunks.push(Buffer.from(head + '\r\n\r\n' + textOf(v) + '\r\n', 'utf8'));
        display.push(`${name}=${textOf(v)}`);
      }
      parts.push([name, v]);
    }
    chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`, 'utf8'));
    return new EncodedBody(Buffer.concat(chunks), `multipart/form-data; boundary=${BOUNDARY}`, 'multipart/form-data\n' + display.join('\n'), { form_parts: parts });
  }
  if (encoding === 'binary') {
    if (body instanceof FileValue) return new EncodedBody(body.data, contentType || 'application/octet-stream', body.repr(), { binary_file: body });
    const data = Buffer.isBuffer(body) ? body : Buffer.from(textOf(body), 'utf8');
    const f = new FileValue('apitest-body.bin', contentType || 'application/octet-stream', data);
    return new EncodedBody(data, f.content_type, f.repr(), { binary_file: f });
  }
  const text = dumps(body);
  return new EncodedBody(Buffer.from(text, 'utf8'), contentType || 'application/json', text, { data_text: text });
}
