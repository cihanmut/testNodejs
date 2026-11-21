> **Node.js version note (2026-11-18):** this plan was written for the Python version. The architecture,
> techniques, safety rules and config formats are unchanged in the Node.js port; only the libraries were
> replaced (see `docs/porting-notes.md`). Mentions of httpx, click, PyYAML, fastjsonschema, Jinja2, openpyxl,
> pytest and the wheelhouse install refer to the Python version.

# Implementation plan — Swagger-driven REST API Test Tool

Status: **approved and implemented** (Phases 1–3, 2026-11-14). Left out on the user's decision: the CAS service-ticket
auth provider and CI pipeline files. The primary live target was switched to the apichallenges.com Simple API at the user's request.
Inputs: `docs/requirements.md`, `docs/step0-analysis.md` (numbers), and the answers to the clarifying questions below.

## 0. Decisions from the clarifying questions

| # | Question | Answer | Design consequence |
|---|---|---|---|
| 1 | OS | macOS at home, **Windows at work** | Cross-platform from day 1: `pathlib` everywhere, UTF-8 file I/O, no shell-outs. curl commands in two flavours: bash and PowerShell (`curl.exe`, `$env:VAR`). CI matrix: macOS + Windows. |
| 2 | Do work services write data? | **Some write**, with DELETE endpoints | The resource lifecycle is a general, config-driven feature (not Petstore-only). Teardown goes through the API for every target. |
| 3 | Report language | **English** | One message catalogue. Spec text (Turkish summaries) is shown as-is. |
| 4 | Run history / comparison | **No**, single run | No result database. Each run is self-contained in `runs/<target>/<runId>/`. "New vs old" comes from the known-issues file only. Case IDs are still stable (useful for known-issues). |
| 5 | PyPI on Windows work PC | **Very restricted** | Small, mostly pure-Python dependency set (12 wheels, §3). No schemathesis/hypothesis/openapi-core/prance. Ship a wheelhouse script for offline install. |
| 6 | Cleanup on work services | **DELETE endpoints exist** | Same ResourceManager for Petstore and work services. Leftovers are reported and can be retried with `apitest cleanup`. |
| 7 | XML request bodies | **JSON only** | Requests use `application/json`, `Accept: application/json`. XML appears only as a protocol negative (wrong Content-Type). **Deviation from requirement F:** XML *response* schema validation is dropped, because we never ask for XML. |

## 1. Architecture

```
                         config/safety.yaml (denylist, fixed path, CLI cannot override)
                                        │
  CLI (click) ──► Config loader (YAML + env + flags) ──► TargetConfig / Profile / Level / Filters
       │
       ▼
  Spec loader ──► $ref resolver ──► Normalizer (v2 | v3) ──► Endpoint model (Operation, Param, Schema)
  (URL/file/editor-link)                                         │            │
                                                                 │            └──► analyze → spec report + snapshot
                                                                 ▼
                                  Auth detector (per op) ──► AuthDecision(needs, reason)
                                                                 │
                       Baseline builder (overrides → example/default/enum → smart defaults → produced values)
                                                                 │
                       Generator registry: baseline | auth | required | datatype | boundary | domain_rules | protocol
                                                                 │  (deterministic, seeded; each case = 1 mutation)
                                                                 ▼
                                                      TestCase list ──► dry-run table / CSV (no network)
                                                                 │
          ResourceManager (setup / acquire / tombstone / teardown) ◄──┤
                                                                 ▼
  AuthProvider (NoAuth | StaticHeaderAuth) ──► Executor ──► SafeHttpClient (httpx)
                                               │  rate limit, timeouts, network-only retries,
                                               │  no redirects, denylist hook, proxy, CA bundle
                                               │  checkpoint (results.jsonl), health monitor, credential monitor
                                               ▼
                                            Oracle (status rules, schema, envelope, timing, files, known issues)
                                               ▼
                                            RunResult ──► Reporters: HTML | JUnit XML | Excel | CSV | console
```

Rules for module boundaries:
- Only `execution/http.py` touches the network. Generators, the oracle and the reporters are pure functions over data, so they can be unit-tested offline.
- The endpoint model is version-independent. Nothing after the normalizer knows about Swagger 2.0 vs OAS 3.
- The denylist is enforced in the HTTP client: an httpx request event hook checks the host of every outgoing request. It is **also** checked up front: `run` refuses a denylisted target before any work starts.

## 2. Folder structure

```
pyproject.toml                  # src layout, entry point `apitest`
README.md
CLAUDE.md
config/
  apitest.yaml                  # targets, profiles, defaults            (committed)
  safety.yaml                   # host denylist, fixed location          (committed)
  credentials.local.yaml        # optional credentials                   (.gitignore)
  overrides/epias.yaml          # baseline overrides per operationId
  overrides/petstore_v3.yaml
  rules/domain_rules.yaml       # default domain rules (dates, ranges, paging, sort)
  resources/petstore.yaml       # resource lifecycle definitions (pet, order, user)
  known_issues/petstore_v3.yaml
src/apitest/
  cli.py
  config/      models.py loader.py safety.py
  spec/        loader.py refs.py normalize_v2.py normalize_v3.py model.py analyze.py snapshot.py
  auth/        provider.py detect.py masking.py
  data/        baseline.py smart_defaults.py overrides.py values.py (seeded RNG, value catalogue)
  generators/  base.py registry.py baseline.py auth.py required.py datatype.py boundary.py domain_rules.py protocol.py
  resources/   inference.py manager.py registry.py
  execution/   http.py ratelimit.py executor.py checkpoint.py health.py
  oracle/      oracle.py expectations.py schema_convert.py schema_validate.py files.py known_issues.py
  report/      model.py html.py junit.py excel.py csv_export.py curl.py templates/report.html.j2
tests/
  fixtures/    epias_electricity_swagger.json petstore_v3_openapi.json petstore_v2_swagger.json (+ small hand-written specs)
  unit/        one test module per source module
  integration/ marked @pytest.mark.integration (public Petstore; skipped offline / by default)
scripts/
  make_wheelhouse.sh            # on macOS: download win_amd64 + macOS wheels for offline install
  install_offline.ps1           # on Windows: pip install --no-index --find-links wheelhouse
runs/                           # output, .gitignore
```

## 3. Libraries: build vs reuse

Constraint: a very restricted Windows PC. Everything below is pure Python or ships ready-made Windows wheels with a pure-Python fallback.

| Part | Choice | Justification |
|---|---|---|
| HTTP | **httpx** (+httpcore, h11, anyio, sniffio, idna, certifi) | Pure Python. Doesn't follow redirects by default. Proxy, custom CA (`verify=`), fine-grained timeouts, event hooks for the denylist. `MockTransport` gives offline tests with no extra dependency. |
| CLI | **click** (+colorama on Windows) | Pure Python and small. Typer would add rich, shellingham and typing-extensions for no gain. |
| YAML | **PyYAML** | Standard. Win/mac wheels exist and it has a pure-Python fallback. Use `safe_load` only. |
| Spec loading, `$ref` | **build** (stdlib `json` + PyYAML) | prance pulls requests, chardet and ruamel. Local `#/` refs (all three specs) plus relative-file refs are about 150 lines. Cycle-safe lazy resolution is needed for 629 EPİAŞ schemas. |
| Spec validation | **build** (light structural checks in `analyze`) | openapi-spec-validator pulls jsonschema + rpds-py (Rust). We report spec problems as documentation findings anyway. |
| Response schema validation | **fastjsonschema** + own Swagger/OAS → JSON Schema converter | Zero dependencies, pure Python, fast (compiled validators, cached per schema). jsonschema ≥4.18 needs rpds-py (Rust). The converter handles `nullable`, `x-` keys, `readOnly`/`writeOnly` and `discriminator`. |
| Request-side validation | openapi-core: **no** | Heavy dependency tree. The tool doesn't need to validate its own requests: it builds them on purpose, including invalid ones. |
| Test generation | **build** (schemathesis / hypothesis: **no**) | You need deterministic, explainable, technique-mapped single mutations. Hypothesis does random/shrinking search, which isn't repeatable per case or explainable as "rule X on field Y". Both are also heavy and would bypass our denylist/rate-limit layer. |
| HTML report | **Jinja2** (+MarkupSafe) | Autoescaping (spec text and response bodies are untrusted). One self-contained file: inline CSS/JS, no CDN, works offline at work. |
| Excel | **openpyxl** (+et-xmlfile) | Pure Python. CSV and JUnit use the stdlib (`csv`, `xml.etree`). |
| Tests | **pytest** (dev only) | `-m "not integration"` by default. httpx `MockTransport` for executor tests. |

Total runtime wheels: about 12. `scripts/make_wheelhouse.sh` runs `pip download --only-binary=:all: --platform win_amd64 --python-version 3.11 -r requirements.lock -d wheelhouse/` on the Mac. Then you copy the folder and run `install_offline.ps1`.

## 4. Key classes and interfaces (signatures only)

```python
# spec/model.py — version-independent endpoint model
@dataclass(frozen=True)
class Schema:          type: str|None; format: str|None; enum: tuple|None; properties: dict[str,"Schema"]
                       required: frozenset[str]; items: "Schema|None"; nullable: bool; read_only: bool
                       constraints: dict      # minimum, maximum, exclusive*, multipleOf, minLength, maxLength, pattern, minItems, maxItems, uniqueItems
                       example: Any; default: Any; description: str|None; ref_name: str|None
@dataclass(frozen=True)
class Parameter:       name: str; location: Literal["path","query","header","cookie","formData"]; required: bool; schema: Schema
@dataclass(frozen=True)
class RequestBody:     required: bool; content_types: tuple[str,...]; schema: Schema|None
@dataclass(frozen=True)
class Operation:       operation_id: str; method: str; path: str; tags: tuple[str,...]; summary: str
                       parameters: tuple[Parameter,...]; body: RequestBody|None
                       responses: dict[str, ResponseSpec]; security: tuple[frozenset[str],...]; is_export: bool
@dataclass(frozen=True)
class FieldRef:        location: str; pointer: str      # e.g. ("body", "page.sort.direction"), ("query", "status")

# auth/provider.py
class AuthProvider(Protocol):
    name: str
    def headers_for(self, op: Operation) -> dict[str,str]          # [] for NoAuth
    def negative_variants(self) -> list[AuthVariant]               # missing, empty, malformed, wrong prefix, expired?
    def masked(self) -> str                                        # "****abcd"
class NoAuth: ...
class StaticHeaderAuth:  header_name: str; value: str; prefix: str = ""; expired_value: str|None = None
def detect_auth(op: Operation, target: TargetConfig) -> AuthDecision   # needs: bool, reason: str (shown in report)

# generators/base.py
class Generator(Protocol):
    technique: str                                     # "A-datatype", "B-required", ...
    levels: frozenset[Level]                           # smoke/standard/full
    def generate(self, op: Operation, ctx: GenContext) -> Iterator[TestCase]
@register                                              # registry decorator; new technique = new module
class RequiredFieldGenerator: ...

@dataclass(frozen=True)
class TestCase:  id: str              # "TC-" + sha1(target, opId, technique, field, rule, repr(value))[:10] → stable across runs
                 operation_id: str; technique: str; group: str; field: FieldRef|None; rule_id: str
                 title: str; mutation: Mutation; expectation: Expectation; level: Level
                 needs_auth: bool; needs_resources: tuple[ResourceNeed,...]
@dataclass(frozen=True)
class Mutation:  kind: Literal["none","set","remove","raw_body","content_type","header","method","path"]; target: FieldRef|None; value: Any
@dataclass(frozen=True)
class Expectation: kind: Literal["accept","reject","auth_reject","not_found","method_not_allowed","no_5xx"]; codes: tuple[int,...]

# resources/manager.py
class ResourceManager:
    def setup(self, needs) -> None
    def acquire(self, kind: str, purpose: Literal["read","mutate","consume"]) -> Resource
    def tombstone_id(self, kind: str) -> Any           # created + deleted + verified 404 → guaranteed "not found"
    def teardown(self) -> list[CleanupProblem]         # always runs (finally + SIGINT handler)

# execution
class SafeHttpClient:   # httpx.Client(follow_redirects=False, event_hooks={"request":[denylist_guard]}, proxy=, verify=)
class Executor:         def run(self, plan: RunPlan) -> RunResult   # baseline-first, checkpoint, health + credential monitors

# oracle/oracle.py
class Oracle:           def evaluate(self, case: TestCase, op: Operation, resp: ResponseRecord) -> CaseResult
                        # status ∈ PASS FAIL WARN SKIPPED KNOWN ERROR BASELINE_FAILED; findings: list[Finding]
class Reporter(Protocol): def write(self, run: RunResult, out_dir: Path) -> Path
```

## 5. Test generation rules

"Field" means a path/query/header/form parameter or a body leaf, including nested fields. The auth header is never a mutation target outside group AUTH. Every row is one test case per field × value, and each case changes exactly one thing compared to the baseline.

| Technique | Trigger | Generated values | Expected | Level |
|---|---|---|---|---|
| BASE baseline | every op | overrides → example/default/enum[0] → smart defaults → produced IDs | 2xx + valid body; otherwise op = BASELINE_FAILED and its other cases are SKIPPED | smoke |
| AUTH | op needs credential (§6) | header missing / `""` / malformed (`"x"`, random 10 chars) / wrong prefix (`Bearer <v>` or the prefix stripped) / expired (only if `expired_value` is given) | configured unauth codes (default 401, 403; optional 3xx with `Location` matching a login pattern); 2xx = **FAIL auth gap** | smoke |
| B required | `required` (body), `required: true` (param) | per field: omit; `null`; `""`; `"   "` (strings only); missing required path/query/header param | reject 4xx | standard |
| B positive | op has optional fields | only the required fields | accept 2xx | standard |
| A type | every field | standard: 2 wrong types (string↔integer, + object); full: all of string/integer/number/boolean/array/object | reject 4xx | std / full |
| A format | `format: int32/int64` | 2147483648 / 9223372036854775808 (overflow); full: also -overflow | reject 4xx | std |
| A format | `format: date-time/date` | handled by D date rules (to avoid duplicates); `email`: `"a@"`, `"plain"` | reject | std |
| A enum | `enum` | value outside the enum (`"APITEST_INVALID"`), wrong case (`"asc"` for `ASC`) | reject | std |
| A pattern | `pattern` | generated non-matching string (none of the 3 specs uses it; kept for work specs) | reject | std |
| C numeric | `minimum`/`maximum` (+exclusive) | min-1, min, min+1, max-1, max, max+1; `multipleOf`: k·m+1 | out-of-range: reject; edges: accept | full |
| C length | `minLength`/`maxLength` | len-1, len, len+1, `""`, 10 000 chars | as above | full |
| C items | `minItems`/`maxItems`/`uniqueItems` | n-1, n, n+1 items; duplicate elements | as above | full |
| C generic | **no constraint** (the norm in all 3 specs) | ints: 0, -1, 2³¹, 2⁶³; strings: `""`, 10 000 chars; arrays: `[]`, 1 001 items | **no_5xx**; plus one DOCUMENTATION finding "constraint missing in spec" per field (not a failure) | full |
| D date format | `format: date-time` or name matches `(?i)date|time` | missing offset; date only; `Z`; `+05:00`; slashes `2023/11/14`; epoch millis; `2023-02-30`; `2024-02-29` (accept); full: `2023-02-29`, `24:00:00`, month 13, `+3:00`, whitespace, ISO week | per rule (default reject; leap day + `Z`/other offsets configurable) | std / full |
| D date range | op has `startDate`+`endDate` (rule regex pair) | start == end (accept); start > end (reject); range > `max_range_days` (reject); full: future end, year 1900 | per rule | std / full |
| D paging | body has `page{number,size}` or query `page/size` | number 0, -1; size 0, -1, 100 000; full: number 2³¹, size not in allowed list (23) | reject | std / full |
| D sort | `sort.direction`, `sort.field` | direction `"ASCENDING"`; field `"apitest_unknown"` | reject | std |
| D description rules | rules file entries (e.g. Petstore order id > 1000; EPİAŞ id lists > 1000, duplicate ids) | as written in the rule | as written in the rule | std |
| E protocol | op has body | malformed JSON `{"a":`; empty body; body as `[]`; `Content-Type: text/plain`; `application/xml` with a JSON body; unknown extra field `"apitestExtra": 1` | reject 4xx (unknown extra field: accept or reject, configurable; default WARN) | std |
| E protocol | per path | undocumented method → 405; per target: unknown path `/apitest-unknown-<runId>` → 404 | 405 / 404 | std |
| E strings | string fields without enum/format | `"<>\"'%;()&+"`, unicode `"Çğİış 漢字 🙂"`, 10 000 chars | no_5xx; reject or accept both OK; echo check → WARN | full |
| E injection | **OFF**; only with `--allow-injection` **and** profile ≠ public-demo | basic SQL/script strings | reject / no_5xx | — |
| F response | every executed case | status, Content-Type, time ≤ threshold, JSON schema for 2xx, error envelope in 200, file signature for exports | see §7 oracle | all |

Determinism: every random value comes from `random.Random(seed ^ hash(case_key))`. The seed is in config (default 42). Unique names like `apitest-<runId>-<n>` are kept out of the case ID hash, so IDs stay stable across runs.

## 6. Auth decision table (real examples from the fixtures)

Detection, in order: (1) a config override (`auth_required` / `auth_not_required` lists of operationIds or glob paths), then (2) a header param whose name matches `auth.header` (case-insensitive), then (3) a security requirement containing a scheme mapped to that header, skipping `ignored_schemes`.

| Target / operation | Spec says | Decision (reason in report) | Credential given | Credential not given |
|---|---|---|---|---|
| EPİAŞ `POST /v1/consumption/data/consumer-quantity` | header param `TGT`, required | **needs** ("header param TGT declared") | dry-run only: BASE + full suite with `TGT` + AUTH group (4–5 cases) | dry-run only: 1 case "missing TGT must be rejected"; everything else SKIPPED (no credential) |
| EPİAŞ `POST /v1/consumption/data/demand-forecast` | no TGT, no security | **not needed** ("no auth declared") | full suite, `TGT` **never sent** | same |
| Petstore v3 `DELETE /pet/{petId}` | header param `api_key` (optional) + security `petstore_auth` | **needs** ("header param api_key declared"; petstore_auth ignored) | full suite with `api_key: special-key` + AUTH group | only "missing api_key must be rejected" (expected to **FAIL as an auth gap**: Petstore deletes anyway) |
| Petstore v3 `GET /pet/{petId}` | security includes `api_key` | **needs** ("scheme api_key → header api_key") | same as above | same as above |
| Petstore v3 `GET /store/inventory` | security `api_key` | **needs** | same | same |
| Petstore v3 `POST /pet` | security `petstore_auth` only | **not needed** ("scheme petstore_auth ignored by config") | full suite, no header | same |
| Petstore v3 `POST /store/order` | none | **not needed** | full suite, no header | same |

Mid-run expiry: if ≥3 consecutive auth-required cases (non-AUTH group) return an unauth code on operations whose baseline passed, the run is marked CREDENTIAL_EXPIRED. Remaining auth-required cases are SKIPPED ("credential expired") and the checkpoint is written. Then `apitest run --resume <runId> --credential-env TGT_TOKEN` continues with a new credential.

Masking: `****` + the last 4 characters in logs, console, HTML, Excel and JUnit. The credential value is never written to `results.jsonl`. curl commands use `-H "TGT: $TGT_TOKEN"` (bash) or `-H "TGT: $env:TGT_TOKEN"` (PowerShell).

## 7. Oracle (pass/fail)

| Situation | Result |
|---|---|
| 5xx, any case | FAIL (even if 500 is documented: EPİAŞ documents 500 on 208 ops) |
| expectation reject/auth_reject + 2xx | FAIL (validation gap / auth gap) |
| expectation accept + 4xx | FAIL |
| expectation no_5xx + 2xx or 4xx | PASS (the generic-limit DOCUMENTATION finding is emitted separately) |
| status not in the documented responses (and no `default`) | WARN; the same undocumented code on ≥N ops → one DOCUMENTATION finding |
| 2xx body fails the schema / Content-Type mismatch / time > threshold | FAIL (schema), FAIL (content type), WARN (slow) |
| 200 with an error envelope (config JSON path, e.g. `$.resultCode != "0"`) | FAIL |
| export op (`--include-exports`) | expect Content-Type matching `exportType`, magic bytes (XLSX `PK\x03\x04`, PDF `%PDF`, CSV non-binary text), non-empty; ModelAndView schema not checked |
| matches a known-issues entry | KNOWN (counted separately, not a failure, shown greyed) |
| network error after retries | ERROR |

Expected codes can be set at three levels, most specific wins: `expectations.default` → `per_tag` → `per_operation`. For example: reject = [400, 422] globally, and Petstore v2 also allows 405 for invalid input.

Health: if ≥50% of the first 10 baselines (configurable) are 5xx or time out → abort with "target environment unhealthy". Also abort after 20 consecutive 5xx/timeouts during the run. Either way the report is still written, with the Environment health section filled in.

## 8. Resource lifecycle

Declared in config, with gaps filled in by inference. Inference: a path param `{xId}` maps to resource `x`. The producer is the POST on the collection path whose 2xx response schema has `id`, or the POST on the same tag whose body schema contains a field named like the param. The consumer delete is `DELETE` on the same item path.

```yaml
resources:
  pet:
    create:   { operation: addPet, id_from: response, id_path: "$.id" }
    body:     { id: "{unique_int}", name: "apitest-{runId}-{n}", status: available, photoUrls: ["https://example.invalid/apitest.png"] }
    delete:   { operation: deletePet, params: { petId: "{id}" } }
    verify_deleted: { operation: getPetById, expect: 404 }
  order:
    create:   { operation: placeOrder, id_from: response, id_path: "$.id" }
    body:     { id: "{unique_int:1..999}", petId: "{pet.id}", quantity: 1, status: placed, shipDate: "{now}" }
    requires: [pet]
    delete:   { operation: deleteOrder, params: { orderId: "{id}" } }
  user:
    create:   { operation: createUser, id_from: request, id_path: "$.username" }
    body:     { id: "{unique_int}", username: "apitest_{runId}_{n}", email: "apitest+{runId}@example.invalid", password: "apitest-pw" }
    delete:   { operation: deleteUser, params: { username: "{id}" } }
```

- **Pools by purpose:** each resource kind has
  - one `read` instance, used by GET/BASE/negative cases that don't change state;
  - one `mutate` instance, used by PUT cases (each PUT sends a full body, so no restore is needed);
  - `consume` instances, created lazily for DELETE-type cases and replaced only after one was actually deleted (2xx).
- **Unique data:** `{unique_int}` = random int64 in [9·10¹⁵, 9.2·10¹⁸) from the seeded RNG plus runId. The `apitest-<runId>` prefix lets anyone recognise our data on the shared server. Orders are the exception: Petstore documents "IDs > 1000 error", so order IDs must be 1–999, which has a high collision risk. The manager re-reads the order after creating it and checks `petId == our pet` before using it.
- **Ownership rule:** PUT/DELETE target only IDs in this run's registry. A generated case that would hit any other ID is dropped at generation time.
- **"Not found":** `tombstone_id(kind)` creates a resource, deletes it, and verifies GET returns 404. That ID is then guaranteed absent. No guessed IDs.
- **Teardown:** the registry is persisted to `created_resources.jsonl` *before* each create returns. Teardown runs in `finally` and on Ctrl+C. Order is reversed by dependency (orders → pets; users), each delete is checked with GET → 404, and failures go to **Cleanup problems** with the curl to delete manually. `apitest cleanup --run <runId>` retries from the file later (e.g. after a crash).
- **Work services:** the same mechanism. You add `resources:` entries for the write endpoints. Read-only "lookup" IDs (EPİAŞ `organizationId`, `provinceId`, …) are a separate, simpler `lookups:` config: call a list op once, take a JSON path, cache it per run. Dry-run uses overrides or examples instead.

## 9. Example configuration

`config/safety.yaml`: always loaded from this fixed path. `--config` cannot point elsewhere for it, and any `denylist` key in other files is rejected with an error.

```yaml
denylist:
  - host: seffaflik.epias.com.tr      # suffix match, also blocks sub-domains
    reason: "Production EPİAŞ — structural reference only"
```

`config/apitest.yaml`
```yaml
defaults:
  seed: 42
  level: standard
  timeout: { connect: 5, read: 30 }
  retries: { network_errors: 2, backoff_s: 2 }      # never on HTTP status
  response_time_warn_ms: 3000
  proxy: null                                        # or http://proxy.corp:8080 ; env HTTPS_PROXY also honoured
  ca_bundle: null                                    # path to corporate CA .pem
  include_exports: false

profiles:
  public-demo:
    rate_limit_rps: 1          # max 2 allowed for this profile
    concurrency: 1
    own_resources_only: true
    allow_injection: false     # hard false; flag ignored with a warning
  company-test:
    rate_limit_rps: 5
    concurrency: 2
    own_resources_only: true
    allow_injection: false     # may be enabled with --allow-injection

targets:
  petstore_v3:
    spec: https://petstore3.swagger.io/api/v3/openapi.json
    base_url: https://petstore3.swagger.io/api/v3   # spec has only a relative server
    profile: public-demo
    auth:
      header: api_key
      env: PETSTORE_API_KEY                          # demo value special-key
      scheme_map: { api_key: api_key }
      ignored_schemes: [petstore_auth]
      unauth_expect: [401, 403]
    expectations:
      reject: [400, 404, 405, 422]
    overrides: config/overrides/petstore_v3.yaml
    known_issues: config/known_issues/petstore_v3.yaml
    resources: config/resources/petstore.yaml          # file path; yaml.safe_load has no !include
  petstore_v2:
    spec: https://petstore.swagger.io/v2/swagger.json
    profile: public-demo
    auth: { header: api_key, env: PETSTORE_API_KEY, scheme_map: { api_key: api_key }, ignored_schemes: [petstore_auth] }
  epias:
    spec: tests/fixtures/epias_electricity_swagger.json   # denylisted host → analyze / dry-run only
    profile: company-test
    auth:
      header: TGT
      env: TGT_TOKEN
      unauth_expect: [401, 403, 302]
      login_redirect_pattern: "/cas/login"
    exports: { tag_pattern: "-export-controller$", type_field: exportType }
    envelope: null
    overrides: config/overrides/epias.yaml
```

`config/overrides/epias.yaml`
```yaml
"*":                                     # applies to every op of the target
  body: { page: { number: 1, size: 10, sort: { field: startDate, direction: ASC } } }
consumption-quantity:                    # operationId
  body: { startDate: "{date:-7d}", endDate: "{date:-1d}" }
uevcb-list:
  body: { organizationId: 195 }
```

`config/rules/domain_rules.yaml` (excerpt)
```yaml
date_format:
  match: { format: date-time, name_regex: "(?i)(date|time|period)$" }
  valid_template: "yyyy-MM-dd'T'HH:mm:ssXXX"
  cases:
    - { id: DATE-NO-OFFSET, value: "2023-11-14T17:30:00", expect: reject }
    - { id: DATE-ONLY,      value: "2023-11-14",          expect: reject }
    - { id: DATE-ZULU,      value: "2023-11-14T14:30:00Z", expect: accept }   # configurable per service
    - { id: DATE-SLASHES,   value: "2023/11/14 17:30:00", expect: reject }
    - { id: DATE-EPOCH,     value: 1699972200000,          expect: reject }
    - { id: DATE-FEB30,     value: "2023-02-30T00:00:00+03:00", expect: reject }
    - { id: DATE-LEAP-OK,   value: "2024-02-29T00:00:00+03:00", expect: accept }
date_range:
  match: { start_regex: "(?i)^(start|periodStart|versionStart)Date$", end_regex: "(?i)^(end|periodEnd|versionEnd)Date$" }
  max_range_days: 31                        # ASSUMPTION — set per service
  cases: [ START-EQ-END: accept, START-GT-END: reject, RANGE-TOO-LONG: reject ]
paging:
  match: { object: page, number: number, size: size }
  cases: [ PAGE-0: reject, PAGE-NEG: reject, SIZE-0: reject, SIZE-NEG: reject, SIZE-HUGE: reject ]
id_list_limit:                              # EPİAŞ description-only rule
  match: { name_regex: "(?i)(uevcbIds|powerPlantIds|organizationIds)$" }
  cases: [ { id: IDS-1001, value: "{list:1001}", expect: reject }, { id: IDS-DUP, value: "{list_dup}", expect: reject } ]
petstore_order_id:                          # Petstore description-only rule
  match: { operation: getOrderById, param: orderId }
  cases: [ { id: ORDER-ID-GT-1000, value: 1001, expect: reject } ]
```

`config/known_issues/petstore_v3.yaml`
```yaml
- id: KI-PET-001
  match: { operation: "*", technique: "A-datatype", field: "body.*" }
  reason: "Petstore demo accepts wrong types (weak validation)"
- id: KI-PET-002
  match: { operation: deletePet, rule: "AUTH-*" }
  reason: "Petstore does not enforce api_key"
```

### CLI

```
apitest fetch-spec <url|editor-link> --out tests/fixtures/x.json   # the only way to touch a denylisted host; refuses to overwrite
apitest analyze   --target epias                                  # Step-0 style report (console + analyze.html)
apitest generate  --target epias --dry-run [--level full] [--include-exports] [--tag ..] [--path ..] [--method ..] [--operation ..] [--csv out.csv]
apitest run       --target petstore_v3 --level standard --tag pet [--credential-env PETSTORE_API_KEY | --credential ****]
apitest run       --resume <runId> [--credential-env ...]
apitest report    --run <runId> [--format html,junit,xlsx,csv]      # re-render from results.jsonl
apitest cleanup   --run <runId>                                     # retry leftover deletions
```
Exit codes: 0 = no FAIL/ERROR; 1 = FAIL present; 2 = ERROR / aborted (unhealthy, credential expired); 3 = usage or config error; 4 = blocked by denylist.

## 10. Estimated test-case counts

Calculated from the fixtures by applying the rules in §5 (script: `estimate.py`, kept in the scratchpad). Smoke assumes a credential is given; without one, each auth-required op is 1 case.

| Target | smoke | standard | full |
|---|---|---|---|
| EPİAŞ (dry-run only), exports excluded (179 ops) | 831 | 6 858 | 10 364 |
| EPİAŞ, `--include-exports` (301 ops) | 1 133 | 13 434 | 20 419 |
| Petstore v3 — `pet` tag (Phase 1 scope, 8 ops) | 16 | 120 | 274 |
| Petstore v3 — all (19 ops) | 31 | 253 | 635 |
| Petstore v2 — all (20 ops) | 32 | 261 | 630 |

Most EPİAŞ cases come from technique D (date rules on startDate/endDate in 187 ops: 3 044 standard). That is expected: dates are where those services have rules the spec doesn't capture.

Run time at the public-demo rate. Requests ≈ cases + ~15% for setup, teardown and tombstones.

| Petstore run | requests | 1 req/s (default) | 2 req/s |
|---|---|---|---|
| v3 `pet`, standard | ~140 | ~2.5 min | ~1.2 min |
| v3 `pet`, full | ~315 | ~5.5 min | ~2.7 min |
| v3 all, standard | ~290 | ~5 min | ~2.5 min |
| v3 all, full | ~730 | ~12 min | ~6 min |
| v2 all, standard / full | ~300 / ~725 | ~5 / ~12 min | ~2.5 / ~6 min |

Dry-run target: EPİAŞ full + exports (~20k cases) generated in under 5 s. For comparison, an EPİAŞ-sized work service at `standard` would take ~1.9 h at 1 req/s or ~23 min at 5 req/s. That is why the company profile needs its own rate.

## 11. Report layout

One self-contained `report.html` (no external files, opens offline, safe to attach to a ticket). Each run folder `runs/<target>/<runId>/` also contains `junit.xml`, `results.xlsx` (sheets Cases / Results / Findings), `results.csv`, `spec_snapshot.json` (+ sha256), `cases.jsonl`, `results.jsonl` and `run.log` (masked).

```
┌ Header: target · spec title/version/sha256 · runId · start/end · level · profile · seed · credential: given (****1a2b) / not given
├ Environment health: baseline OK x/y · 5xx · timeouts · aborted? · credential expired?
├ Summary tiles: PASS · FAIL · WARN · KNOWN · SKIPPED · ERROR · BASELINE_FAILED
├ Matrix: tag × status, technique × status (click → filtered case list)
├ 1. Defects            (FAIL, grouped by operation → field → rule; "Copy for ticket" button)
├ 2. Auth findings      (auth gaps, AUTH group results, skipped-for-no-credential summary)
├ 3. Documentation      (constraint missing, undocumented codes, ${...} placeholders, export ModelAndView, duplicate summaries)
├ 4. Cleanup problems   (resources not deleted + manual curl)
├ 5. Environment health (details, timeline of 5xx/timeouts)
└ All cases table (filter by status / tag / op / technique / text) → drill-down per case:
     technique · field · rule id + description · expected vs actual (status, content type, time)
     masked request (method, URL, headers, body) · response (status, headers, body ≤ 8 KB)
     duration · curl [bash | PowerShell] tabs with copy button · known-issue id if KNOWN
```

The "Copy for ticket" button puts this on the clipboard: title (`[op] field: rule — expected 4xx, got 200`), steps (curl), expected, actual and the case ID.

## 12. Phased roadmap

**Phase 1 — MVP**
- pyproject, wheelhouse scripts, CI-less local test run on macOS + a Windows smoke check.
- `config/` loader, `safety.yaml` + denylist hook, and the `fetch-spec` command.
- Spec loader (URL/file/editor link) with `$ref`, normalizers v2 + v3, endpoint model, and the `analyze` command (reproduces the Step 0 numbers as unit-test assertions).
- Auth detection + `NoAuth`/`StaticHeaderAuth` + masking.
- Baseline builder; generators BASE, AUTH, B required, A datatype; `generate --dry-run` with filters and a counts table.
- Executor (rate limit, timeouts, network retries, no redirects, checkpoint/resume, health and credential monitors).
- ResourceManager with **pet** lifecycle + tombstone + cleanup command.
- Oracle: status rules + known issues + basic JSON schema.
- HTML report.
- Exit criteria:
  - unit tests are offline and green on macOS and Windows;
  - EPİAŞ dry-run completes in under 5 s;
  - a denylisted host can't be reached by any command except fetch-spec (tested);
  - a real `run` on Petstore v3 `pet` gives a report with zero cleanup leftovers.

**Phase 2**
- C boundary (incl. generic limits + doc findings), D domain rules file + defaults, E protocol negatives, full F response validation (envelope, timing, content type).
- Petstore v2; `store` + `user` lifecycles; work-service `lookups:`.
- JUnit, Excel and CSV exporters.
- Exit criteria: the full level runs on Petstore v3 and v2; all domain rules are verified via EPİAŞ dry-run.

**Phase 3**
- form-urlencoded / multipart / octet-stream bodies (Petstore `updatePetWithForm`, `uploadFile`).
- File responses (`--include-exports`, magic-byte checks).
- `spec diff` (old vs new snapshot → run only changed ops).
- CI pipeline (GitHub Actions or the company CI).
- New AuthProviders (e.g. single-use CAS service tickets).
- FakeRESTApi target.
- Optional: `--allow-injection` for the company-test profile.

## 13. Risks, assumptions, open questions

| Type | Item | Mitigation / default |
|---|---|---|
| Risk | The public Petstore is shared, flaky, or reset by others | Health abort; ownership checks; tombstones; integration tests tolerate an "unhealthy" abort as a skip |
| Risk | Petstore order IDs must be < 1000 → collisions with other users | Read-back ownership check; retry with a new ID (max 3); otherwise SKIPPED with a reason |
| Risk | Many FAILs on Petstore (weak validation) could hide tool bugs | The known-issues file for Petstore is curated in Phase 1; unit tests pin the expected oracle outcome per case type |
| Risk | Volume on EPİAŞ-like work services (~7k standard cases) | Filters, levels, company profile rate, resume |
| Risk | The installed Python on the Windows PC is older than 3.11 | **Assumption: 3.11+ available.** If not, tell me the version: the code avoids 3.12-only features, and 3.10 support costs little (no `tomllib`; replace `Self`) |
| Assumption | Export ops are recognisable by the tag suffix `-export-controller` + an `exportType` field (true for EPİAŞ) | Configurable `exports.tag_pattern` / `type_field` per target |
| Assumption | `max_range_days` default 31 | Placeholder; set per service in the rules file |
| Assumption | Date `Z` / other offsets are accepted by your services | Default `accept`, flip per rule if your services reject them |
| Assumption | XML response validation not needed (JSON only) | Deviation from requirement F, noted |
| Open | How your work services respond without a TGT: 401, 403 or a 302 to a CAS login? | Config `unauth_expect`; default [401, 403, 302] |
| Open | Exact TGT header value format (raw `TGT-…`, or with a prefix) | Config `auth.prefix`; drives the "wrong prefix" auth negative |
| Open | Is there an error envelope inside 200 in your work services (e.g. `resultCode`)? | Config `envelope.path` / `envelope.ok_values`; off by default |
| Open | Request rate allowed on the company test environment | Placeholder `company-test.rate_limit_rps: 5` |
