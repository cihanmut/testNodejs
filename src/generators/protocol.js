// E: protocol-level negatives.
//
// Per operation with a JSON body (standard):
//   malformed JSON, empty body (if required), body sent as an array, wrong Content-Type
//   (text/plain, application/xml with a JSON body), unknown extra field (config: reject|accept|ignore)
// Per path (standard): an undocumented method must give 405. Safety on shared servers: GET is always
//   allowed; a state-changing method only on paths whose IDs are all bound to resources this run
//   created (sent with purpose 'consume', i.e. a throw-away instance). Collections never get one.
// Per target (standard): an unknown path must give 404.
// Per bound path ID on GET/DELETE (standard): an ID guaranteed not to exist must give 404.
// Strings without enum/format (full): special characters, unicode, very long -> no 5xx.
// SQL/script injection strings are not generated here (injection.js, flag-gated, never on public servers).
import { FieldRef, FileValue, NO_BODY } from '../data/request.js';
import { isPlainObject } from '../util/json.js';
import { deepCopy } from '../util/py.js';
import { Expectation, Generator, Mutation, iterFields } from './base.js';

export const METHOD_CANDIDATES = Object.freeze(['GET', 'PATCH', 'PUT', 'DELETE', 'POST']);
export const SPECIAL = '<>"\'%;()&+\\{}[]|`$';
export const UNICODE = 'Çğİış ÖÜ 漢字 🙂 ‮';
export const UNKNOWN_PATH = '/apitest-unknown-path-404';
const STRING_SKIP_FORMATS = new Set(['date-time', 'date', 'email', 'uuid', 'uri', 'url', 'byte', 'binary']);

export class ProtocolGenerator extends Generator {
  static technique = 'E-protocol';

  generate(ctx) {
    const out = [];
    const { op, baseline: base } = ctx;
    const rej = this.reject(ctx);
    if (op.body !== null && base.encoding === 'binary' && base.body !== NO_BODY) {
      out.push(this.make(ctx, {
        rule_id: 'E-EMPTY-UPLOAD', title: 'empty file upload must be rejected', mutation: new Mutation('raw_body', null, ''),
        expectation: op.body.required ? rej : new Expectation('no_5xx'), level: 'standard',
      }));
      out.push(this.make(ctx, {
        rule_id: 'E-UPLOAD-NOT-AN-IMAGE', title: 'upload of a non-image file must not cause a server error',
        mutation: new Mutation('set', new FieldRef('body', []), new FileValue('apitest.txt', 'text/plain', Buffer.from('not an image'))),
        expectation: new Expectation('no_5xx'), level: 'full', field_label: 'body',
      }));
    }
    if (op.body !== null && base.encoding === 'json' && base.body !== NO_BODY) {
      out.push(this.make(ctx, { rule_id: 'E-MALFORMED-JSON', title: 'malformed JSON body must be rejected', mutation: new Mutation('raw_body', null, '{"apitest": '), expectation: rej, level: 'standard' }));
      if (op.body.required) {
        out.push(this.make(ctx, { rule_id: 'E-EMPTY-BODY', title: 'empty body must be rejected', mutation: new Mutation('raw_body', null, ''), expectation: rej, level: 'standard' }));
      }
      if (isPlainObject(base.body)) {
        out.push(this.make(ctx, {
          rule_id: 'E-BODY-AS-ARRAY', title: 'body wrapped in an array must be rejected', mutation: new Mutation('set', new FieldRef('body', []), [deepCopy(base.body)]),
          expectation: rej, level: 'standard', field_label: 'body',
        }));
        const unknown = { reject: rej, accept: new Expectation('accept'), ignore: new Expectation('no_5xx') }[ctx.target.unknown_fields];
        out.push(this.make(ctx, {
          rule_id: 'E-UNKNOWN-FIELD', title: `unknown extra body field (${ctx.target.unknown_fields})`,
          mutation: new Mutation('set', new FieldRef('body', ['apitestUnknownField']), 'apitest'), expectation: unknown, level: 'standard',
          field_label: 'body.apitestUnknownField',
        }));
      }
      out.push(this.make(ctx, { rule_id: 'E-CONTENT-TYPE-TEXT', title: 'JSON body sent as text/plain must be rejected', mutation: new Mutation('content_type', null, 'text/plain'), expectation: rej, level: 'standard' }));
      out.push(this.make(ctx, { rule_id: 'E-CONTENT-TYPE-XML', title: 'JSON body labelled application/xml must be rejected', mutation: new Mutation('content_type', null, 'application/xml'), expectation: rej, level: 'standard' }));
    }

    if (ctx.first_on_path) out.push(this.methodNotAllowed(ctx));
    if (ctx.first_op) {
      out.push(this.make(ctx, {
        rule_id: 'E-UNKNOWN-PATH', title: `unknown path ${UNKNOWN_PATH} must give 404`, mutation: new Mutation('path', null, UNKNOWN_PATH),
        expectation: new Expectation('reject', [404]), level: 'standard',
      }));
    }
    if (op.method === 'GET' || op.method === 'DELETE') {
      for (const b of ctx.bindings) {
        if (b.location === 'path') {
          out.push(this.make(ctx, {
            rule_id: 'E-NOT-FOUND', title: `${b.path[0]} that does not exist must give 404`, mutation: new Mutation('tombstone', new FieldRef('path', b.path), b.kind),
            expectation: new Expectation('reject', [404]), level: 'standard', field_label: `path.${b.path[0]}`,
          }));
        }
      }
    }
    for (const f of iterFields(op, base, ctx.target)) {
      const s = f.schema;
      if (s.effective_type !== 'string' || (s.enum && s.enum.length) || STRING_SKIP_FORMATS.has(s.format || '')) continue;
      for (const [rule, value] of [['E-SPECIAL-CHARS', SPECIAL], ['E-UNICODE', UNICODE], ['E-VERY-LONG', 'a'.repeat(10000)]]) {
        out.push(this.make(ctx, {
          rule_id: rule, title: `${f.ref.label} with ${rule.slice(2).toLowerCase().replace(/-/g, ' ')} must not cause a server error`,
          mutation: new Mutation('set', f.ref, value), expectation: new Expectation('no_5xx'), level: 'full', field_label: f.ref.label,
        }));
      }
    }
    return out.filter(Boolean);
  }

  methodNotAllowed(ctx) {
    const pathParams = ctx.op.params('path');
    const bound = new Set(ctx.bindings.filter((b) => b.location === 'path').map((b) => b.path[0]));
    const allBound = pathParams.length > 0 && pathParams.every((p) => bound.has(p.name));
    for (const method of METHOD_CANDIDATES) {
      if (ctx.path_methods.has(method)) continue;
      if (method !== 'GET' && ctx.own_resources_only && !allBound) continue; // never send an undocumented write to a collection or someone else's item
      return this.make(ctx, {
        rule_id: 'E-METHOD-NOT-ALLOWED', title: `undocumented method ${method} on ${ctx.op.path} must give 405`,
        mutation: new Mutation('method', null, { method }), expectation: new Expectation('reject', [405]), level: 'standard',
      });
    }
    return null;
  }
}
