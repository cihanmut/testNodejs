// YAML via the vendored js-yaml (MIT, single file in vendor/: no npm install needed).
// CORE_SCHEMA = what PyYAML's safe_load gives for this project's files, except that unquoted dates stay
// strings (safer: the tool formats dates itself).
import fs from 'node:fs';
import { CORE_SCHEMA, dump, load } from '../../vendor/js-yaml.mjs';

export function yamlLoad(text) {
  const out = load(text, { schema: CORE_SCHEMA });
  return out === undefined ? null : out;
}

export function yamlDump(value) {
  return dump(value, { schema: CORE_SCHEMA });
}

/** yaml.safe_load of a file, or null if the path is empty / missing. */
export function loadYamlFile(path) {
  if (!path || !fs.existsSync(path)) return null;
  return yamlLoad(fs.readFileSync(path, 'utf8'));
}
