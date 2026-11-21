// Spec loading/normalization and the analyze numbers (Step 0 numbers pinned as regression tests).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuthConfig } from '../../src/config/models.js';
import { analyze } from '../../src/spec/analyze.js';
import { LoadedSpec, resolveEditorLink } from '../../src/spec/loader.js';
import { normalize } from '../../src/spec/normalize.js';
import { epiasApi, petv2Api, petv3Api } from '../helpers.js';

test('editor link is resolved', () => {
  const link = 'https://editor.swagger.io/?url=https://petstore3.swagger.io/api/v3/openapi.json';
  assert.equal(resolveEditorLink(link), 'https://petstore3.swagger.io/api/v3/openapi.json');
  assert.equal(resolveEditorLink('tests/fixtures/x.json'), 'tests/fixtures/x.json');
});

test('EPİAŞ numbers', async () => {
  const a = analyze(await epiasApi(), new AuthConfig({ header: 'TGT' }));
  assert.equal(a.spec_version, '2.0');
  assert.equal(a.operation_count, 301);
  assert.equal(a.path_count, 301);
  assert.deepEqual(a.by_method, { POST: 270, GET: 31 });
  assert.equal(Object.keys(a.by_tag).length, 35);
  assert.deepEqual(a.security_schemes, {});
  assert.equal(a.auth_needed, 208);
  assert.equal(a.auth_not_needed, 93);
  assert.equal(a.export_operations, 122);
  assert.deepEqual(a.response_codes, { 200: 301, 400: 208, 500: 208 });
  assert.equal(a.keyword_counts.minLength, 0);
  assert.equal(a.keyword_counts.pattern, 0);
  const kinds = a.findings.map((f) => f.kind);
  assert.equal(kinds.filter((k) => k === 'placeholder').length, 2);
  assert.equal(kinds.filter((k) => k === 'duplicate_summary').length, 4);
  assert.ok(kinds.includes('export_not_file') && kinds.includes('description_rule'));
});

test('Petstore v3 numbers', async () => {
  const a = analyze(await petv3Api(), new AuthConfig({ header: 'api_key', scheme_map: { api_key: 'api_key' }, ignored_schemes: ['petstore_auth'] }));
  assert.ok(a.spec_version.startsWith('3.0'));
  assert.equal(a.operation_count, 19);
  assert.deepEqual(a.by_tag, { pet: 8, user: 7, store: 4 });
  assert.equal(a.auth_needed, 3); // getPetById, deletePet, getInventory
  assert.deepEqual(new Set(Object.keys(a.security_schemes)), new Set(['petstore_auth', 'api_key']));
  assert.ok(a.findings.some((f) => f.kind === 'description_rule' && f.message.includes('1000')));
});

test('Petstore v2 numbers', async () => {
  const api = await petv2Api();
  const a = analyze(api);
  assert.equal(a.spec_version, '2.0');
  assert.equal(a.operation_count, 20);
  assert.equal(api.servers[0], 'https://petstore.swagger.io/v2');
  assert.equal(a.param_locations.formData, undefined); // form params are normalised into a request body
  const upload = api.operation('uploadFile');
  assert.ok(upload.body !== null && upload.body.content_types.includes('multipart/form-data'));
});

test('recursive schema and allOf', () => {
  const raw = {
    openapi: '3.0.0', info: { title: 't', version: '1' },
    paths: { '/n': { post: { operationId: 'make', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } }, responses: { 200: { description: 'ok' } } } } },
    components: { schemas: {
      Base: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      Node: { allOf: [{ $ref: '#/components/schemas/Base' }, { type: 'object', properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/components/schemas/Node' } } } }] },
    } },
  };
  const api = normalize(new LoadedSpec(raw, JSON.stringify(raw), 'inline', null, 'x'));
  const node = api.operation('make').body.json_schema;
  assert.deepEqual([...node.required], ['id']);
  assert.deepEqual(new Set(Object.keys(node.properties)), new Set(['id', 'name', 'children']));
  assert.equal(node.properties.children.items, node); // cycle, not infinite recursion
});

test('relative server is joined with spec URL', () => {
  const raw = { openapi: '3.0.0', info: { title: 't', version: '1' }, servers: [{ url: '/api/v3' }], paths: {} };
  const api = normalize(new LoadedSpec(raw, '{}', 'u', 'https://petstore3.swagger.io/api/v3/openapi.json', 'x'));
  assert.deepEqual(api.servers, ['https://petstore3.swagger.io/api/v3']);
});
