// Smart defaults by field name and format (priority 3, after overrides and spec example/default/enum).

export const START_DATE = /^(start|begin|from|periodstart|versionstart)(date|time|datetime)?$/i;
export const END_DATE = /^(end|finish|to|until|periodend|versionend)(date|time|datetime)?$/i;
const PERIOD = /^period$/i;
const DATEISH = /(date|time)$/i;

export function smartValue(name, schema, ctx) {
  const t = schema.effective_type;
  const fmt = (schema.format || '').toLowerCase();
  const lname = name.toLowerCase();

  if (fmt === 'date-time' || (t === 'string' && DATEISH.test(name) && fmt !== 'date')) {
    if (START_DATE.test(name)) return ctx.midnight(-7);
    if (END_DATE.test(name)) return ctx.midnight(-1);
    if (PERIOD.test(name)) return ctx.firstOfPreviousMonth();
    return ctx.midnight(-1);
  }
  if (fmt === 'date') return ctx.day(START_DATE.test(name) ? -7 : -1).iso();

  if (t === 'integer' || t === 'number') {
    if (['page', 'pagenumber', 'number', 'pageno'].includes(lname)) return 1;
    if (['size', 'pagesize', 'limit', 'count'].includes(lname)) return 10;
    if (lname === 'year') return ctx.today.year - 1;
    if (['month', 'day', 'hour'].includes(lname)) return 1;
    let lo = schema.constraints.minimum;
    if (typeof lo === 'number' || typeof lo === 'bigint') {
      if (schema.constraints.exclusiveMinimum === true) lo = typeof lo === 'bigint' ? lo + 1n : lo + 1;
      return t === 'integer' ? (typeof lo === 'bigint' ? lo : Math.trunc(lo)) : lo;
    }
    return 1;
  }
  if (t === 'boolean') return true;
  if (t === 'string') {
    if (fmt === 'email' || lname.includes('email')) return `apitest+${ctx.run_id}@example.invalid`;
    if (fmt === 'uri' || fmt === 'url' || lname.endsWith('url')) return 'https://example.invalid/apitest';
    if (fmt === 'uuid') return '00000000-0000-4000-8000-000000000000';
    if (['direction', 'sortdirection', 'order'].includes(lname)) return 'ASC';
    if (['name', 'username', 'firstname', 'lastname', 'title'].includes(lname)) return `apitest-${ctx.run_id}`;
    const minLen = schema.constraints.minLength;
    let base = 'apitest';
    if (Number.isInteger(minLen) && minLen > base.length) base += 'x'.repeat(minLen - base.length);
    return base;
  }
  return 'apitest';
}
