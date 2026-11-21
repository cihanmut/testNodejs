# Swagger-driven REST API Test Tool


# Role
You are a senior software test architect and an experienced Python engineer. We are in PLAN MODE: do NOT write or modify any code yet. First analyze the specs, then ask clarifying questions, then produce a detailed implementation plan for my approval.

# Context
I am a software test engineer. I test REST services documented with Swagger. I want a LOCAL command-line tool that takes a Swagger/OpenAPI link or file, analyzes every operation, generates test cases automatically, runs them, and produces a report I can attach to bug tickets. It must work with any Swagger 2.0 / OpenAPI 3.x spec.

# Targets: two different roles

## 1. Structural reference ONLY (never send API requests)
EPİAŞ Transparency electricity-service: https://seffaflik.epias.com.tr/electricity-service/technical/tr/swagger.json
(Editor link I was given: https://editor.swagger.io/?url=https://seffaflik.epias.com.tr/electricity-service/technical/tr/swagger.json)
- Use it only to shape the design: parsing, auth detection, test generation and dry-run. My real work services are built like this.
- Download the spec file ONCE, save it as `tests/fixtures/epias_electricity_swagger.json`, and work only from that file.
- Never call any EPİAŞ API endpoint: not from the tool, not from you during planning, not even one request "to check behaviour".
- The tool must enforce this with a host denylist in the config file (default: `seffaflik.epias.com.tr`). Denylisted hosts get no HTTP requests except an explicit "download spec" command; for their specs only `analyze` and `--dry-run` are allowed. No CLI flag can override it.

What I know about this spec (verify in Step 0):
- Swagger 2.0, about 300 operations, about 35 tags. Most operations are POST with a JSON body but are read-only queries; some are GET; `*-export-controller` operations return files (XLSX/CSV/PDF).
- Auth is NOT in securityDefinitions. It is a header parameter named `TGT` on the operations that need it; some operations have no TGT header.
- Dates use `yyyy-MM-dd'T'HH:mm:ssXXX`, e.g. `2023-11-14T17:30:00+03:00`. Some operations use a paging object (number, size, total) and a sort object (field, ASC/DESC).
- Documented responses are mostly only 200/400/500, without error body schemas.

## 2. Execution targets (all real test runs): public demo APIs
Use the public Swagger Petstore directly from its Swagger links. No Docker or local installation.
- Petstore v3 (OpenAPI 3.0), PRIMARY:
  - Spec: https://petstore3.swagger.io/api/v3/openapi.json
  - Editor: https://editor.swagger.io/?url=https://petstore3.swagger.io/api/v3/openapi.json
- Petstore v2 (Swagger 2.0, the same spec family as my work services):
  - Spec: https://petstore.swagger.io/v2/swagger.json
  - Editor: https://editor.swagger.io/?url=https://petstore.swagger.io/v2/swagger.json
- Optional extra target later: FakeRESTApi https://fakerestapi.azurewebsites.net/swagger/v1/swagger.json
- Targets are configuration only. Adding another demo API must only need a new entry with its Swagger link.

These are PUBLIC, SHARED demo servers, so the design must account for that:
- Other people change the data at the same time; never assume a resource exists unless the tool created it in this run.
- Rate limit 1–2 requests/second by default; PUT/DELETE only on resources the tool created in this run; clean up at the end.
- Health check: if many baselines fail with 5xx or timeouts, stop and report "target environment unhealthy" instead of reporting hundreds of defects.
- No SQL/script injection strings against public servers.

Petstore differs from EPİAŞ, and the design must handle both:
- Real CRUD (POST creates, PUT updates, DELETE deletes), so a resource lifecycle is needed (see below).
- Auth via security schemes: `api_key` (apiKey in header `api_key`; demo value `special-key`) and `petstore_auth` (OAuth2). Some operations also declare `api_key` as an explicit header parameter, like EPİAŞ's TGT.
- Body types beyond JSON: XML, `application/x-www-form-urlencoded`, `multipart/form-data`, `application/octet-stream` (image upload).
- enum query parameters (`status`), array query parameters (`tags`), int64 IDs, `date-time` fields (`shipDate`).
- It is a demo server with weak validation, so I expect many findings. That is fine: it proves the tool catches problems.

# My environment
- Preferred language: <<Python 3.11+ unless you have a strong reason>>
- OS: <<Windows / Linux / macOS>>


# Step 0: Analyze the specs before designing (read-only)
For EPİAŞ (from the saved file), Petstore v3 and Petstore v2, report:
- Spec version, operation count by tag and by HTTP method.
- How auth is declared (security schemes vs explicit header parameters), and which operations have it.
- How often each constraint keyword appears: required, enum, format, minimum/maximum, minLength/maxLength, pattern, example, default.
- Request content types, and fields that need values produced by other operations (IDs).
- Documented response codes and error/envelope models.
- Spec quality issues: unrendered `${...}` placeholders, duplicate summaries, missing descriptions or examples, rules written only in description text (e.g. "IDs above 1000 will generate errors").
Use these numbers to justify the design.

# Authentication: optional credential header (I supply it)
- I generate credentials (e.g. the CAS TGT) with my own script and pass them in only where needed. The tool NEVER generates, refreshes or stores credentials, and never logs in.
- The credential is OPTIONAL: `--credential` flag, an env var whose name is configurable per target (e.g. `TGT_TOKEN`, `PETSTORE_API_KEY`), or a local config file (never committed). The tool must run without it.
- The header name is configurable per target: `TGT` for my work services, `api_key` for Petstore.
- Decide per operation whether it needs the credential: (1) the spec declares a header parameter with that name (case-insensitive), or (2) the operation has a security requirement whose scheme is mapped to that header in config. Config overrides (`auth_required`, `auth_not_required`, ignored schemes such as `petstore_auth`) win over the spec.
- Behaviour matrix:

  | Operation needs credential? | Credential given? | What runs |
  |---|---|---|
  | yes | yes | full suite with the credential + auth negative tests |
  | yes | no | only "missing credential must be rejected"; all other tests SKIPPED (reason: no credential) |
  | no | either | full suite WITHOUT the header (never send it where it is not needed) |

- Auth negative tests (their own group): missing, empty, malformed, wrong prefix, expired (if I provide one). The expected "unauthenticated" response is configurable: 401/403 or a 3xx redirect to a login page. Do NOT follow redirects automatically.
- Finding: an operation that declares auth but returns 2xx without it → FAIL (auth gap). Petstore does not really enforce auth, so this will show up there; that is expected.
- The auth header is excluded from data-type, boundary and required-field mutations; only the auth group touches it.
- If auth failures start mid-run for operations whose baseline passed, assume the credential expired: stop those operations, report it clearly, and allow resuming with a new credential.
- Mask the credential everywhere (logs, console, HTML, curl commands): show only the last 4 characters; generated curl commands use the env var name.
- Put auth behind an `AuthProvider` interface (`NoAuth`, `StaticHeaderAuth`) so another provider (e.g. single-use CAS service tickets) can be added later without changing the rest of the code.

# Core test strategy: "valid baseline + single mutation"
1. For each operation, build ONE valid request and send it. If it does not return 2xx with a valid body, mark the operation BASELINE_FAILED and skip its other tests (they would be meaningless).
2. Every other test changes exactly ONE thing compared to the baseline, so each failure points to one field and one rule.
3. This applies to path/query/header parameters (except the auth header), form fields and body fields, including nested objects and arrays.

Baseline data, in priority order:
1. My overrides file (YAML, per operationId).
2. Spec `example` / `default` / first `enum` value.
3. Smart defaults by field name and format: dates → a recent valid date in the required format; page → number 1, size 10; sort direction → ASC.
4. Values produced by other operations (see Resource lifecycle).
Generation is deterministic (seeded) so runs are repeatable and comparable.

# Resource lifecycle (needed for Petstore CRUD)
- Setup: create the resources a test needs (e.g. POST /pet, then use the returned id for GET/PUT/DELETE /pet/{petId}). Dependencies are declared in config (producer operation + JSON path of the ID) and inferred from the spec where possible.
- Use unique, recognisable test data (e.g. name prefix `apitest-<runId>`, random large IDs) so runs don't collide with other users of the shared server.
- Teardown: delete everything the tool created, even when tests fail, and report anything that could not be cleaned up.
- PUT/DELETE tests act only on resources created in the current run.
- "Not found" tests use IDs that are guaranteed not to exist.

# Test techniques
## A. Data type validation
- Wrong type per field: string ↔ integer/number, boolean, array, object, null.
- `format` violations: date-time, date, email, int32/int64 overflow.
- `enum`: value outside the enum, wrong letter case.
- `pattern` violations, where a pattern exists.

## B. Required fields
- For each required field, one at a time: omit it, send `null`, `""`, whitespace only.
- Required path/query/header parameters missing (except the auth header).
- Positive check: only the required fields sent → must succeed.

## C. Boundary values (from spec constraints)
- minimum/maximum (and exclusive variants): min-1, min, min+1, max-1, max, max+1; `multipleOf`.
- minLength/maxLength: len-1, len, len+1; empty; very long.
- minItems/maxItems; uniqueItems duplicates.
- No constraint in the spec → test generic limits (0, -1, int32/int64 max+1, very long string) and report "constraint missing in spec" as a DOCUMENTATION finding, not a failure.

## D. Domain rules file (rules the spec does not express)
YAML rules matched by field name or regex, with the expected result (reject 4xx / accept 2xx) configurable per rule. Ship defaults for:
- Date format: missing offset, date only, `Z` vs `+03:00`, other offsets, slashes, epoch millis, invalid calendar dates (2023-02-30), leap days.
- Date ranges: start == end, start > end, future dates, very old dates, range longer than the allowed maximum.
- Paging: page 0, -1, very large; size 0, -1, very large. Sort: direction outside ASC/DESC, unknown sort field.
- Rules found only in description text (e.g. Petstore's ID limits) can be added as rules.
Verify these rules by dry-run against the EPİAŞ fixture, and execute whatever applies on Petstore (e.g. `shipDate`).

## E. Negative tests (protocol level)
- Malformed JSON/XML, empty body, body sent as an array, wrong Content-Type.
- Unsupported HTTP method on an existing path → expect 405.
- Unknown extra fields in the body.
- Unknown path → 404.
- Special characters, unicode, very long strings in string fields.
- Basic SQL/script strings: OFF by default, only with an explicit flag, and never against public demo servers (only against my own test environments later).

## F. Response validation (on every test)
- Status code, Content-Type, response time (threshold configurable).
- Body matches the documented schema (JSON and XML).
- An error envelope inside a 200 response → FAIL (JSON path configurable).
- File responses: Content-Type + file signature + non-empty body, no JSON schema check (opt-in `--include-exports`).

# Oracle (pass/fail rules)
- 5xx for any input → FAIL, even if 500 is documented in the spec.
- 2xx for invalid input → FAIL (validation gap).
- 4xx for valid input → FAIL.
- Undocumented status code → WARNING; the same undocumented code across many operations is reported once as a documentation finding.
- Expected codes are configurable globally, per tag and per operation.
- Known-issues file: accepted findings (e.g. Petstore's known weak validation) are reported as KNOWN, so new defects stand out.

# Safety and volume
- Host denylist (EPİAŞ by default): a hard block from the config file, never overridable from the CLI.
- Environment profiles: `public-demo` (default for Petstore: 1–2 requests/second, own resources only, no injection strings) and later my company's test environment.
- `--dry-run`: list all generated test cases with counts per operation and technique; send nothing. Must handle the ~300-operation EPİAŞ fixture in seconds.
- Levels: `smoke` (baseline + auth) / `standard` / `full`. Filters: tag, path, method, operationId.
- Timeouts, retries only on network errors (never on 4xx/5xx), concurrency limit, checkpoint/resume.

# Outputs
- HTML report: summary by tag, operation and technique (pass/fail/warn/skipped/known), with drill-down per case: technique, field, rule, masked request, expected vs actual, duration, copy-paste curl command.
- Report sections: Defects, Auth findings, Documentation findings, Cleanup problems, Environment health.
- JUnit XML, Excel/CSV of test cases and results, non-zero exit code on failures.
- A spec snapshot per run. Later phase: diff two spec versions and test only the changed operations.

# Non-functional requirements
- CLI (Typer or Click) with commands such as `analyze`, `generate --dry-run`, `run`, `report`. Config via YAML + env vars + CLI flags.
- Modules: spec loader (URL / file / editor link, `$ref`, Swagger 2.0 + OpenAPI 3.x) → endpoint model → test generators (pluggable, one per technique) → auth provider → resource manager (setup/teardown) → executor → oracle → reporters.
- Proxy support, custom CA bundle.
- Unit tests for the tool using saved spec fixtures (EPİAŞ + Petstore v2/v3), so they run offline; separate integration tests against the public Petstore, marked so they can be skipped when offline.
- Evaluate libraries (prance / openapi-spec-validator / openapi-core, jsonschema, httpx, schemathesis, hypothesis) and justify build vs reuse for each part. I want deterministic, explainable test cases mapped to test design techniques, not only random fuzzing.

# What I want from you in plan mode
1. The Step 0 analysis summary (with numbers) for the three specs.
2. At most 8 clarifying questions, only where my answer changes the design. Wait for my answers.
3. Then the plan:
   - Architecture (text diagram), folder structure, key classes and interfaces.
   - Libraries with a one-line justification each.
   - Test generation rules table: technique | trigger (spec keyword or domain rule) | generated values | expected result.
   - Auth decision table with real examples: an EPİAŞ operation with the TGT header, one without, and a Petstore operation with `api_key`.
   - Resource lifecycle design with Petstore pet / order / user examples.
   - Example config (targets, profiles, denylist), overrides file, domain rules file, known-issues file, CLI commands.
   - Estimated test-case counts per level: EPİAŞ (dry-run only) and Petstore, plus run time at the default rate limit.
   - Report layout.
   - Phased roadmap:
     - Phase 1 (MVP): spec loading, `analyze`, denylist, auth detection, baseline + required-field + data-type tests, pet lifecycle, HTML report. Run on the public Petstore v3 `pet` tag; dry-run only on the EPİAŞ fixture.
     - Phase 2: boundary values, domain rules, negative tests, response validation, Petstore v2, `store`/`user` tags, JUnit/Excel export.
     - Phase 3: form/multipart/file bodies, file responses, spec diff, CI, other auth providers, extra demo APIs.
   - Risks, assumptions and open questions.
4. Do not write any code until I approve the plan.