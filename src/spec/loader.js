// Load a spec from a file, a URL or an editor.swagger.io link. URLs go through SafeHttpClient, so a
// denylisted host is blocked here too (only `fetch-spec` gets a one-time exception).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { parseJson } from '../util/json.js';
import { yamlLoad } from '../util/yaml.js';

export class SpecLoadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SpecLoadError';
  }
}

export class LoadedSpec {
  constructor(raw, text, source, url, sha256) {
    Object.assign(this, { raw, text, source, url, sha256 });
  }
}

/** https://editor.swagger.io/?url=<spec> -> <spec>. Other inputs are returned unchanged. */
export function resolveEditorLink(source) {
  if (!source.includes('://')) return source;
  let parts;
  try {
    parts = new URL(source);
  } catch {
    return source;
  }
  if (parts.hostname && parts.hostname.startsWith('editor') && parts.hostname.includes('swagger.io')) {
    const url = parts.searchParams.get('url');
    if (url) return url;
    throw new SpecLoadError(`editor link has no ?url= parameter: ${source}`);
  }
  return source;
}

export function parseSpecText(text, where) {
  let data;
  try {
    data = parseJson(text);
  } catch {
    try {
      data = yamlLoad(text);
    } catch (exc) {
      throw new SpecLoadError(`${where}: neither valid JSON nor YAML: ${exc.message}`);
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !('swagger' in data || 'openapi' in data)) {
    throw new SpecLoadError(`${where}: not a Swagger 2.0 / OpenAPI 3.x document`);
  }
  return data;
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function decodeUtf8Sig(buf) {
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

export async function loadSpecSource(source, http = null) {
  const resolved = resolveEditorLink(source);
  if (resolved.includes('://')) {
    if (!http) throw new SpecLoadError(`spec is a URL but no HTTP client is available: ${resolved}`);
    const resp = await http.get(resolved, { Accept: 'application/json, application/yaml, */*' });
    if (resp.error) throw new SpecLoadError(`could not download spec ${resolved}: ${resp.error}`);
    if (resp.status === null || !(resp.status >= 200 && resp.status < 300)) throw new SpecLoadError(`could not download spec ${resolved}: HTTP ${resp.status}`);
    const text = decodeUtf8Sig(resp.body);
    return new LoadedSpec(parseSpecText(text, resolved), text, source, resolved, sha(resp.body));
  }
  if (!fs.existsSync(resolved)) throw new SpecLoadError(`spec file not found: ${resolved}`);
  const data = fs.readFileSync(resolved);
  const text = decodeUtf8Sig(data);
  return new LoadedSpec(parseSpecText(text, resolved), text, source, null, sha(data));
}
