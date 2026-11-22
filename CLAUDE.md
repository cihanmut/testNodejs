# CLAUDE.md — Swagger-driven REST API Test Tool (Node.js version)

Full spec: `docs/requirements.md` (source of truth; read it when details matter).
This is the **Node.js port** (2026-11-18) of the Python tool in `../API_Manuel_Test_Tool_with_Python`.
The reason for the port: the user's Windows 11 work laptop may not download or run Python, but Node.js is available.
The port keeps the **exact same working logic**: modules ported one-to-one, same config/run-folder/report formats.
How each Python library was replaced, how parity was verified, and the known small differences: `docs/porting-notes.md`.
User guide: `docs/how-to-run.md`. Step 0 analysis: `docs/step0-analysis.md`. Design: `docs/implementation-plan.md` (written for Python; the architecture is unchanged).
Status: Phases 1–3 implemented, same as the Python version. Two items were left out on the user's decision: the CAS service-ticket provider and CI files.

## Hard constraint of this port: ZERO install on the work PC
- Runtime = **Node.js ≥ 18 built-in modules only**. **Never add an npm dependency**: no `node_modules`, no `npm install`, no build step, no TypeScript, no bundler.
- The only third-party code is `vendor/js-yaml.mjs` (MIT, copied single file). If something else is needed, write it in `src/util/`.
- Don't use APIs newer than Node 18. Examples: `zlib.crc32` (Node 22), `Object.groupBy`, `Array.prototype.toSorted`, `Set.prototype.union`, `import.meta.dirname`, `fetch`-only features.
- Must run on Windows: use `node:path`, UTF-8 files, no shell-outs. Launchers: `apitest.cmd` (Windows) and `./apitest` (bash).

## Dev commands
- Tests (offline, 90): `npm test` (= `node tests/run.js`, uses `node:test`). No live/integration tests.
- CLI: `./apitest <cmd>` or `node src/cli.js <cmd>`. Dry-run example: `generate --target simpleapi_offline --dry-run` (offline). `epiasQA` loads its spec from the network, even for a dry run.
- Parity check against Python (only on the Mac): compare `generate --dry-run --level full --include-exports --csv` outputs of both tools; re-render a Python run folder with `./apitest report --run <path>`.

## Code map (mirrors the Python package)
- `util/`:
  - `json.js`: lossless JSON. Ints beyond 2^53 become BigInt; `dumps` uses Python's `json.dumps` separators; `RawNumber` for display.
  - `py.js`: `repr`/`str`, fnmatch, Python regexes with `(?i)`, deepCopy/deepEqual, Counter, half-even rounding.
  - `dates.js`, `url.js` (Python `quote`/`urlencode`), `yaml.js`, `binary.js` (crc32).
- `config/`: `models.js` (sections with unknown-key rejection), `loader.js`. A target's `filters:` block (tags/paths/methods/operations) is its default operation filter; any CLI filter flag replaces it.
- `spec/`: `loader.js`, `normalize.js` (v2/v3 → model; `$ref`s cached, so cycles are safe), `analyze.js`, `diff.js`.
- `auth/`: `detect.js`, `provider.js` (AuthProvider, NoAuth, StaticHeaderAuth), `masking.js`.
- `data/`: `request.js` (RequestTemplate, OMIT/NO_BODY, FileValue, ResourceRef), `values.js` (`Rng` = CPython Mersenne Twister, templates), `smartDefaults.js`, `baseline.js`.
- `generators/`:
  - `base.js`: TestCase, Mutation, iterFields, ownershipSafe, Generator.make.
  - one file per technique: `techniques.js`, `boundary.js`, `rules.js`, `protocol.js`, `exports.js`, `injection.js`.
  - `plan.js`: registers the generators in the Python import order, then filters, levels and skip reasons.
- `resources/`: `definitions.js`, `manager.js` (async; pools, dispose/retire, tombstones, verify with backoff, registry jsonl).
- `execution/`:
  - `http.js`: the ONLY network code. Rate limit, network-only retries, no redirects, proxy and CA bundle. The `transport` is injectable for tests.
  - `encoding.js`, `executor.js` (async; Ctrl+C → finish the current request, then teardown).
- `oracle/`: `oracle.js`, `schemaValidate.js` (model → draft-07 → built-in validator).
- `report/`: `model.js`, `html.js`, `curl.js`, `exports.js` (JUnit/CSV/XLSX), `xlsx.js` (zip writer).
- `runner.js`: orchestration and exit codes; `testHooks.transport` lets CLI tests inject a fake transport.
- `cli.js`: argument parser and commands; `main(argv, {out, err})` returns the exit code.
- `tests/`: `fakes.js` (FakePetstore and the export fake as transports), `helpers.js` (`cfg()` = main config, `petCfg()` = test-only `tests/config/apitest.yaml`), `unit/*.test.js`.
- Petstore is **not a real target** any more (2026-11-21, user decision: the public demo is unreliable). Only `simpleapi` and `epiasQA` are targets. Petstore survives only as offline test data: `tests/config/` (petstore_v3_offline/petstore_v2_offline targets + their resources/overrides/rules) + fixtures + FakePetstore, because they cover auth, multipart/form and int64 IDs that Simple API cannot. Don't add Petstore back to `config/`.
- The old `epias` target was removed (2026-11-22, user decision). The electricity-service fixture survives only as the test target `epias_offline` in `tests/config/` (TGT auth, export controllers, `config/rules/epias.yaml`).

## JavaScript-specific invariants (don't break them)
- **int64 IDs:** parse every response and file with `parseJson`, never `JSON.parse`. Write JSON with `dumps`. `normInt` keeps safe integers as numbers, so `===` works. Petstore pet IDs are about 9e18, and losing precision would delete the wrong pet.
- **The RNG must stay CPython-compatible:** a seed must give the same values as Python's.
- **Python dict order:** rule replacement keeps the first position (`Map.set`), and generator registration order is fixed in `plan.js`.
- Everything that sends requests is `async`. Generation (plan, baseline, generators) is synchronous and pure.

## Invariants carried over from the Python tool (don't break them)
- A resource-bound ID field on a non-GET request is mutated only with values that can't hit someone else's resource (`ownershipSafe`). The same applies to IDs we choose in create bodies (`own_id_fields`). Regression: `addPet` with id 1.5 was coerced to 1 → the shared pet 1 was overwritten and then deleted.
- If a create returns a different ID than the one we sent (and the server normally keeps ours), that ID is never auto-deleted. It is logged as `foreign` and reported as a cleanup problem.
- Resources a test case creates are deleted right after the case. A mutate instance that accepted a change is retired.
- A "set" mutation equal to the baseline is dropped. String-keyed resources (usernames) get no mutations on write requests.
- 405 tests: GET, or a write only on item paths whose IDs are all bound to a `consume` instance. Never on collections.
- `probe` create ops get a freshly probed free ID before every request. `also_created_by` bulk IDs are registered and deleted.
- Example/default values of the wrong type are converted or ignored, and reported as `example_type_mismatch`.
- Credential expiry is assumed only after the credential worked earlier in the run. Those cases get `final=false`, so resume re-runs them.

## HARD SAFETY RULES (never break, not even "just to check")
1. The tool has **no host denylist** any more (2026-11-22, user decision; `safety.yaml`/`safety.js` and exit code 4 were removed). Don't add one back.
2. `epiasQA` (EPİAŞ reporting-service) points at the live host `seffaflik.epias.com.tr` until the user gives the QA link. Claude does not send requests there itself (no `run`/`generate`/`analyze` on `epiasQA`, curl, WebFetch or browser); the user runs it.
3. Claude's own real runs only against the public Simple API demo (apichallenges.com). They are shared servers:
   - ≤ 2 req/s;
   - PUT/DELETE only on resources this run created;
   - always clean up;
   - **no injection strings** (flag-gated, own test environments only).
4. Credentials: the tool **never** generates, refreshes, stores or logs in. Mask everywhere (last 4 characters); curl commands use the env var name.
5. Retries only on network errors, never on 4xx/5xx. Never follow redirects.

## Decisions (from the user)
- macOS at home, Windows work PC with strict policies: no Python, but Node.js/npm and Java are available.
- JSON request bodies wherever offered. Reports in English. No run history (each run is self-contained).
- Work services write data and have DELETE endpoints, so the resource lifecycle is config-driven.
- Skipped for now: the CAS service-ticket provider (only the AuthProvider interface exists) and CI files (`junit.xml` is enough).
