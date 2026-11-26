# Porting notes: Python → Node.js

**Why:** the work laptop (Windows 11) may not download or run Python. Node.js is available there, so
the tool was ported to Node.js on 2026-11-18. The Python version stays unchanged in
`API_Manuel_Test_Tool_with_Python`.

**Goal:** the exact same working logic. Every module was ported one-to-one, so you can still find
your way using the Python module names (`spec/normalize.py` → `src/spec/normalize.js`, and so on).

## Zero install: what replaced the Python libraries

| Python library | Node.js replacement | Where |
|---|---|---|
| httpx | `node:http` / `node:https`, no redirects. Adds the proxy (CONNECT tunnel and `HTTPS_PROXY`/`NO_PROXY`), the CA bundle, gzip/deflate decoding, and connect/read timeouts. | `src/execution/http.js` |
| click | small built-in argument parser with the same commands, options and exit codes | `src/cli.js` |
| PyYAML | js-yaml 4.1.0, copied as one file (MIT) | `vendor/js-yaml.mjs`, `src/util/yaml.js` |
| fastjsonschema | built-in draft-07 subset validator, with the same error message style | `src/oracle/schemaValidate.js` |
| Jinja2 | template literals with HTML escaping, producing the same report markup | `src/report/html.js` |
| openpyxl | built-in XLSX writer (zip + XML) | `src/report/xlsx.js` |
| `random.Random` | port of CPython's Mersenne Twister, same seeding and the same `randint` | `src/data/values.js` (`Rng`) |
| `json` | lossless JSON: integers beyond 2^53 become BigInt, and output uses Python's `json.dumps` format | `src/util/json.js` |
| `fnmatch`, `re` inline flags, `repr()`, `urllib.parse.quote` | small helpers | `src/util/py.js`, `src/util/url.js` |
| `datetime` with a fixed offset | small date helpers | `src/util/dates.js` |
| pytest + httpx.MockTransport | `node:test` plus an injectable transport function (the fake Petstore is a transport) | `tests/` |

## How it was verified to match the Python version

1. **Same analysis:** `apitest analyze` output is identical for all four targets (EPİAŞ, Petstore v2/v3, Simple API).
2. **Same plans:**
   - Case lists were compared with `generate --dry-run --level full --include-exports --csv` for all four targets.
   - 33,391 of the 33,395 EPİAŞ cases are identical, including case IDs and the random values.
   - Petstore v2/v3 and the Simple API are identical apart from the `{now}` timestamp.
   - The remaining few lines are the float display described below.
3. **Same reports:** four real Python run folders were re-rendered with the Node reporter.
   - `junit.xml`, `results.csv` and every cell of `results.xlsx` are identical.
   - `report.html` has the same content; only whitespace differs.
4. **Same live results:** `run --target simpleapi --level standard` against the real server gave
   FAIL 8, WARN 1, PASS 156, which is case-for-case the same as the Python run. 38 items were created and
   38 deleted. The Petstore v3 upload (7/7 PASS) and Petstore v2 form/multipart (1 FAIL, 6 WARN) runs
   also match the Python results.
5. **Tests:** all 86 Python unit tests were ported, plus 6 port-specific ones (92 in total).

## Known small differences (all harmless)

- **Floats.** JavaScript has one number type, so a JSON value written as `2021.0` is sent and shown as
  `2021`. The `1e15` generic-limit value appears as `1000000000000000` instead of
  `1000000000000000.0`, which gives 4 EPİAŞ case IDs that differ. It is the same JSON number. For
  integer fields the Node form is arguably more correct.
- **Response bodies in the HTML report** are pretty-printed with the numbers exactly as the server
  sent them: `0.0` stays `0.0`, and `1.50` stays `1.50`.
- **Ctrl+C:** the request in progress finishes, then teardown deletes everything. Python stopped the
  request immediately. A second Ctrl+C quits at once.
- **Proxy:** Python's httpx and this version both support plain or Basic-auth proxies. Neither
  supports NTLM/Kerberos proxies.
- **`tool_version`** in `run.json` is `0.3.0-node`.

## Node-only features (added after the port, not in the Python version)

- **`allow_null_in_responses`** (target option, 2026-11-26): when `true`, every field of a response body
  may be `null` without failing the schema check (EPİAŞ services return `null` when there is no data).
  Implemented in `src/oracle/schemaValidate.js` (`toJsonSchema(root, allowNull)`). Default `false`, so
  parity with Python holds for every target that doesn't set it.
