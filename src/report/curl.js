// Copy-paste curl commands for bash (macOS/Linux) and PowerShell (Windows).
//
// Credentials are never inlined: every occurrence of a secret inside a header value is replaced by a
// reference to the env var that holds it (bash: ${VAR}, PowerShell: $env:VAR). Built from the REAL
// request headers, so variants like "Bearer <credential>" stay reproducible.
import { FileValue } from '../data/request.js';
import { textOf } from '../execution/encoding.js';

/** bash single-quote */
const sq = (text) => "'" + text.split("'").join(`'"'"'`) + "'";

function withRefs(text, secrets, ref, escapeChars, escapeWith) {
  const ordered = Object.entries(secrets).sort((a, b) => b[0].length - a[0].length);
  let out = '';
  let i = 0;
  while (i < text.length) {
    const hit = ordered.find(([secret]) => secret && text.startsWith(secret, i));
    if (hit) {
      out += ref(hit[1]);
      i += hit[0].length;
    } else {
      const ch = text[i];
      out += escapeChars.includes(ch) ? escapeWith + ch : ch;
      i += 1;
    }
  }
  return '"' + out + '"';
}

/** bash double-quoted string; secrets become ${ENV}. */
const bashDq = (text, secrets) => withRefs(text, secrets, (env) => '${' + env + '}', '"\\$`', '\\');
/** PowerShell double-quoted string; secrets become $env:ENV. */
const psDq = (text, secrets) => withRefs(text, secrets, (env) => '$($env:' + env + ')', '`"$', '`');

const hasSecret = (text, secrets) => Object.keys(secrets).some((s) => s && text.includes(s));
// curl sets the multipart Content-Type itself (it needs its own boundary)
const skipHeader = (k, formParts) => Boolean(formParts && formParts.length) && k.toLowerCase() === 'content-type';

function fileNote(formParts, binaryFile) {
  const files = (formParts || []).filter(([, v]) => v instanceof FileValue).map(([, v]) => v.filename);
  if (binaryFile) files.push(binaryFile.filename);
  return files.length ? `# run in the run folder: ${[...new Set(files)].sort().join(', ')} is saved there` : null;
}

export function curlBash(method, url, headers, body, secrets = {}, formParts = null, binaryFile = null) {
  secrets = secrets || {};
  const parts = ['curl -sS -i', `-X ${method}`, sq(url)];
  for (const [k, v] of Object.entries(headers)) {
    if (skipHeader(k, formParts)) continue;
    const line = `${k}: ${v}`;
    parts.push('-H ' + (hasSecret(line, secrets) ? bashDq(line, secrets) : sq(line)));
  }
  if (formParts && formParts.length) {
    for (const [name, v] of formParts) {
      if (v instanceof FileValue) parts.push('-F ' + sq(`${name}=@${v.filename};type=${v.content_type}`));
      else parts.push('--form-string ' + sq(`${name}=${textOf(v)}`));
    }
  } else if (binaryFile) {
    parts.push('--data-binary ' + sq('@' + binaryFile.filename));
  } else if (body !== null && body !== undefined) {
    parts.push(`--data-raw ${sq(body)}`);
  }
  const cmd = parts.join(' \\\n  ');
  const note = fileNote(formParts, binaryFile);
  return note ? `${note}\n${cmd}` : cmd;
}

/** Uses curl.exe (in Windows PowerShell 5.1 'curl' is an alias of Invoke-WebRequest). The body goes through
 *  a here-string + stdin to avoid PowerShell's native-argument quoting bugs. */
export function curlPowershell(method, url, headers, body, secrets = {}, formParts = null, binaryFile = null) {
  secrets = secrets || {};
  const parts = ['curl.exe -sS -i', `-X ${method}`, psDq(url, {})];
  for (const [k, v] of Object.entries(headers)) {
    if (skipHeader(k, formParts)) continue;
    parts.push('-H ' + psDq(`${k}: ${v}`, secrets));
  }
  const note = fileNote(formParts, binaryFile);
  if ((formParts && formParts.length) || binaryFile) {
    if (formParts && formParts.length) {
      for (const [name, v] of formParts) {
        if (v instanceof FileValue) parts.push('-F ' + psDq(`${name}=@${v.filename};type=${v.content_type}`, {}));
        else parts.push('--form-string ' + psDq(`${name}=${textOf(v)}`, {}));
      }
    } else {
      parts.push('--data-binary ' + psDq('@' + binaryFile.filename, {}));
    }
    const cmd = parts.join(' `\n  ');
    return note ? `${note}\n${cmd}` : cmd;
  }
  if (body !== null && body !== undefined) {
    parts.push("--data-binary '@-'");
    return "$body = @'\n" + body + "\n'@\n$body | " + parts.join(' `\n  ');
  }
  return parts.join(' `\n  ');
}
