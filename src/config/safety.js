// Host denylist. Hard safety rule: a denylisted host receives no HTTP request except an explicit
// `fetch-spec`. The denylist is the union of a built-in default and `safety.yaml` next to the main
// config file. There is deliberately no CLI flag or config key that can remove an entry.
import fs from 'node:fs';
import path from 'node:path';
import { yamlLoad } from '../util/yaml.js';

export const BUILTIN_DENYLIST = Object.freeze(['seffaflik.epias.com.tr']);
export const SAFETY_FILE_NAME = 'safety.yaml';

/** Raised when anything tries to send a request to a denylisted host. */
export class DeniedHostError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DeniedHostError';
  }
}

export function hostOf(value) {
  if (!value) return '';
  value = String(value).trim();
  let host;
  if (value.includes('://')) {
    try {
      host = new URL(value).hostname;
    } catch {
      host = value.split('://')[1].split('/')[0].split('@').pop().split(':')[0];
    }
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  } else {
    host = value.split('/')[0].split(':')[0];
  }
  return host.toLowerCase().replace(/\.+$/, '');
}

export class Denylist {
  constructor(hosts = BUILTIN_DENYLIST, reasons = {}) {
    this.hosts = Object.freeze([...hosts]);
    this.reasons = reasons;
    Object.freeze(this);
  }

  isDenied(hostOrUrl) {
    const host = hostOf(hostOrUrl);
    if (!host) return false;
    return this.hosts.some((h) => host === h || host.endsWith('.' + h));
  }

  reason(hostOrUrl) {
    const host = hostOf(hostOrUrl);
    for (const h of this.hosts) {
      if (host === h || host.endsWith('.' + h)) return this.reasons[h] || 'denylisted host';
    }
    return '';
  }

  check(url, what = 'request') {
    if (this.isDenied(url)) {
      throw new DeniedHostError(
        `${what} to denylisted host '${hostOf(url)}' blocked (${this.reason(url)}). ` +
          'Denylisted hosts allow only `apitest fetch-spec`, `analyze` and `generate --dry-run`.',
      );
    }
  }
}

export function loadDenylist(configDir) {
  const hosts = [...BUILTIN_DENYLIST];
  const reasons = Object.fromEntries(BUILTIN_DENYLIST.map((h) => [h, 'built-in default (EPİAŞ production, structural reference only)']));
  if (configDir) {
    const file = path.join(configDir, SAFETY_FILE_NAME);
    if (fs.existsSync(file)) {
      const data = yamlLoad(fs.readFileSync(file, 'utf8')) || {};
      for (const entry of data.denylist || []) {
        let host;
        let reason;
        if (typeof entry === 'string') {
          host = entry;
          reason = 'safety.yaml';
        } else {
          host = String(entry.host ?? '');
          reason = String(entry.reason ?? 'safety.yaml');
        }
        host = hostOf(host);
        if (host && !hosts.includes(host)) hosts.push(host);
        if (host && !(host in reasons)) reasons[host] = reason;
      }
    }
  }
  return new Denylist(hosts, reasons);
}
