// F (files): export operations (e.g. EPİAŞ *-export-controller, only with --include-exports) are
// requested once per documented file type, so every format's file is checked (signature, Content-Type,
// non-empty), not just the baseline's first enum value.
import { FieldRef } from '../data/request.js';
import { isPlainObject } from '../util/json.js';
import { deepEqual, pyStr } from '../util/py.js';
import { Expectation, Generator, Mutation } from './base.js';

export class ExportTypeGenerator extends Generator {
  static technique = 'F-export';

  generate(ctx) {
    const field = ctx.target.exports.type_field;
    const body = ctx.baseline.body;
    if (!ctx.op.is_export || !field || !isPlainObject(body) || !(field in body)) return [];
    const schema = ctx.op.body ? ctx.op.body.chosen_schema : null;
    const prop = schema !== null ? schema.properties[field] ?? null : null;
    const values = prop !== null ? [...(prop.enum || [])] : [];
    const out = [];
    for (const v of values) {
      if (deepEqual(v, body[field])) continue;
      const c = this.make(ctx, {
        rule_id: `EXPORT-${pyStr(v).toUpperCase()}`, title: `${field}=${pyStr(v)} must return a valid ${pyStr(v)} file`,
        mutation: new Mutation('set', new FieldRef('body', [field]), v), expectation: new Expectation('accept'), level: 'standard', field_label: `body.${field}`,
      });
      if (c) out.push(c);
    }
    return out;
  }
}
