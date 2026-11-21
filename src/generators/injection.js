// E (injection): basic SQL / script / template injection strings in string fields.
//
// OFF by default. Generated only when BOTH the target's profile has allow_injection: true AND the run
// was started with --allow-injection. The public-demo profile is forced to allow_injection=false in
// code, so these strings can never reach a public demo server. Meant for your own test environments.
// Expectation: no server error. A response that echoes a script payload back unchanged is reported.
import { Expectation, Generator, Mutation, iterFields } from './base.js';

export const PAYLOADS = Object.freeze([
  ['INJ-SQL-QUOTE', "' OR '1'='1"],
  ['INJ-SQL-COMMENT', "apitest'--"],
  ['INJ-SQL-UNION', "' UNION SELECT NULL--"],
  ['INJ-SCRIPT-TAG', "<script>alert('apitest')</script>"],
  ['INJ-HTML-ATTR', "\"><img src=x onerror=alert('apitest')>"],
  ['INJ-TEMPLATE', '${7*7}{{7*7}}'],
]);
const SKIP_FORMATS = new Set(['date-time', 'date', 'email', 'uuid', 'uri', 'url', 'byte', 'binary']);

export class InjectionGenerator extends Generator {
  static technique = 'E-injection';

  generate(ctx) {
    if (!ctx.allow_injection) return [];
    const out = [];
    for (const f of iterFields(ctx.op, ctx.baseline, ctx.target)) {
      const s = f.schema;
      if (s.effective_type !== 'string' || (s.enum && s.enum.length) || SKIP_FORMATS.has(s.format || '')) continue;
      for (const [rule, payload] of PAYLOADS) {
        const c = this.make(ctx, {
          rule_id: rule, title: `${f.ref.label} with ${rule.slice(4).toLowerCase().replace(/-/g, ' ')} payload must not cause a server error`,
          mutation: new Mutation('set', f.ref, payload), expectation: new Expectation('no_5xx'), level: 'full', field_label: f.ref.label,
        });
        if (c) out.push(c);
      }
    }
    return out;
  }
}
