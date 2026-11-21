// Auth decision table (real examples from the fixtures), providers, masking, curl.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectAuth } from '../../src/auth/detect.js';
import { mask, redact } from '../../src/auth/masking.js';
import { NoAuth, StaticHeaderAuth } from '../../src/auth/provider.js';
import { AuthConfig } from '../../src/config/models.js';
import { curlBash, curlPowershell } from '../../src/report/curl.js';
import { epiasApi, petv3Api } from '../helpers.js';

const PET_AUTH = new AuthConfig({ header: 'api_key', scheme_map: { api_key: 'api_key' }, ignored_schemes: ['petstore_auth'] });

test('EPİAŞ with and without TGT', async () => {
  const api = await epiasApi();
  const tgt = new AuthConfig({ header: 'TGT' });
  const withTgt = detectAuth(api.operation('consumer-quantity'), tgt);
  assert.ok(withTgt.needs && withTgt.reason.includes('TGT'));
  const without = detectAuth(api.operation('demand-forecast'), tgt);
  assert.ok(!without.needs);
  assert.equal(without.reason, 'no auth declared');
  // header name matching is case-insensitive
  assert.ok(detectAuth(api.operation('consumer-quantity'), new AuthConfig({ header: 'tgt' })).needs);
});

test('Petstore decisions', async () => {
  const api = await petv3Api();
  const d = Object.fromEntries(['deletePet', 'getPetById', 'getInventory', 'addPet', 'placeOrder'].map((op) => [op, detectAuth(api.operation(op), PET_AUTH)]));
  assert.ok(d.deletePet.needs && d.deletePet.reason.includes('header param'));
  assert.ok(d.getPetById.needs && d.getPetById.reason.includes('scheme api_key'));
  assert.ok(d.getInventory.needs);
  assert.ok(!d.addPet.needs && d.addPet.reason.includes('ignored'));
  assert.ok(!d.placeOrder.needs);
});

test('config overrides win', async () => {
  const api = await petv3Api();
  const c = new AuthConfig({ header: 'api_key', scheme_map: { api_key: 'api_key' }, ignored_schemes: ['petstore_auth'], auth_required: ['addPet'], auth_not_required: ['DELETE /pet/*'] });
  assert.ok(detectAuth(api.operation('addPet'), c).needs);
  assert.ok(!detectAuth(api.operation('deletePet'), c).needs);
});

test('static header variants', () => {
  const p = new StaticHeaderAuth('TGT', 'TGT-123-abcdefghij-cas', '', null);
  assert.deepEqual(p.headers(), { TGT: 'TGT-123-abcdefghij-cas' });
  assert.equal(p.variant('AUTH-MISSING').headers, null);
  assert.deepEqual(p.variant('AUTH-EMPTY').headers, { TGT: '' });
  assert.deepEqual(p.variant('AUTH-WRONG-PREFIX').headers, { TGT: 'Bearer TGT-123-abcdefghij-cas' });
  assert.equal(p.variant('AUTH-EXPIRED'), null);
  assert.equal(new NoAuth().variant('AUTH-MISSING').headers, null);
  assert.equal(new StaticHeaderAuth('TGT', null).variant('AUTH-EMPTY'), null);
});

test('masking shows only last four', () => {
  assert.equal(mask('TGT-123-abcdefghij-cas'), '****-cas');
  assert.equal(mask('short'), '****');
  assert.equal(redact('x TGT-123-abcdefghij-cas y', ['TGT-123-abcdefghij-cas']), 'x ****-cas y');
});

test('curl uses env var, never the value', () => {
  const secret = 'TGT-123-abcdefghij-cas';
  const headers = { Accept: 'application/json', TGT: 'Bearer ' + secret };
  const bash = curlBash('POST', 'https://x/y', headers, '{"a": "it\'s"}', { [secret]: 'TGT_TOKEN' });
  const ps = curlPowershell('POST', 'https://x/y', headers, '{"a": 1}', { [secret]: 'TGT_TOKEN' });
  assert.ok(!bash.includes(secret) && !ps.includes(secret));
  assert.ok(bash.includes('"TGT: Bearer ${TGT_TOKEN}"'));
  assert.ok(ps.includes('$($env:TGT_TOKEN)') && ps.includes('curl.exe'));
});
