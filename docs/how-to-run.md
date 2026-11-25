# How to run the tool (Node.js version)

The tool has a few everyday commands. You always tell it **which API** to test with `--target`.
Targets are defined in `config/apitest.yaml`.

| Target name | What it is | Sends requests? |
|---|---|---|
| `simpleapi` | apichallenges.com Simple API (spec downloaded from the internet) | yes, at 1 request/second |
| `simpleapi_offline` | same API, spec read from `tests/fixtures/` | only `run` sends requests |
| `epiasQA` | EPİAŞ reporting-service (TGT auth). Points at the live host until the QA link is set | yes, at 5 requests/second (`company-test`) |

---

## On Windows (work PC): nothing to install

What you need is **Node.js 18 or newer**, which is already on the laptop. Check it in PowerShell
or cmd:
```powershell
node --version        # v18.x, v20.x, v22.x ... are all fine
```
You don't need `npm install`, Python, admin rights or any download. The project folder contains everything,
including the YAML parser, which is a single copied file in `vendor/`.

### One-time setup
1. Copy the whole project folder (`API_Manuel_Test_Tool_with_NodeJS`) to the laptop, for example
   to `C:\Users\<you>\apitest`. You can leave out `runs/`. Use whatever your company allows: a
   OneDrive/SharePoint folder, a zip by mail, or a USB stick.
2. Open PowerShell in that folder (in Explorer: Shift + right click → *Open PowerShell window here*).

### Everyday use
```powershell
.\apitest.cmd --help
.\apitest.cmd analyze  --target simpleapi_offline
.\apitest.cmd generate --target simpleapi_offline --dry-run
.\apitest.cmd run      --target simpleapi --level standard
start runs\simpleapi\<runId>\report.html
```
In **cmd.exe** you can leave out the `.\`, so `apitest.cmd run ...` or just `apitest run ...` works.
`node src\cli.js <command> ...` does exactly the same.

Your work services need your TGT. Set it for this window only; it is never written to disk:
```powershell
$env:TGT_TOKEN = "<your TGT>"
.\apitest.cmd run --target <your-target> --level smoke
```
In **cmd.exe** the syntax is different: no quotes and no spaces around `=`:
```cmd
set TGT_TOKEN=<your TGT>
apitest run --target <your-target> --level smoke
```
The variable exists only in that window. If you open a new window, or your TGT expires
(exit code 2), set it again. After it expires, continue with `run --resume <runId>`.
The curl commands in the report have a **PowerShell** tab that uses `curl.exe` and `$env:...`.

### Testing only part of a spec (one controller or one endpoint)
You can limit a run in two ways. Both select the same operations:
- **In the config**, as the target's default: the `filters:` block in `config/apitest.yaml`
  (explained in the Mac section, ["Testing only part of a spec"](#testing-only-part-of-a-spec-one-controller-or-one-endpoint-1);
  the YAML is the same on Windows).
- **On the command line**, for one run only, with these four flags:

| Flag | Selects operations by | Example value |
|---|---|---|
| `--tag` | Swagger tag (the controller name shown in Swagger UI) | `reportind-data-controller` |
| `--path` | path, **without** the service base path; `*` is a wildcard | `/v1/data/eligible-consumer-and-meter-increases` or `/v1/data/*` |
| `--method` | HTTP method | `GET`, `POST`, `PUT`, `DELETE` |
| `--operation` | operationId; `*` is a wildcard | `"get_*"` |

How the flags combine:
- **Any** of these flags **replaces the whole `filters:` block** of the target for that run. Flags you don't
  give are not taken from the config; they simply mean "no limit".
- Give a flag **several times** to allow several values (OR): `--method GET --method POST` = GET **or** POST.
- **Different** flags must **all** match (AND): `--path "/v1/data/*" --method POST` = POSTs under `/v1/data/`.

**Always look first with a dry-run.** It sends no tests (for `epiasQA` it only downloads the Swagger) and
prints which filter is active and which cases would run:
```powershell
.\apitest.cmd generate --target epiasQA --dry-run                                       # filter from the config
.\apitest.cmd generate --target epiasQA --dry-run --tag reportind-data-controller       # filter from the flag
```
If a tag or path matches nothing, you get a warning. For a tag, the warning lists every tag of the spec,
so a typo is easy to spot. `.\apitest.cmd analyze --target epiasQA` also lists all tags and operations.

**Examples in PowerShell** (set `$env:TGT_TOKEN` first, see above):
```powershell
# 1. The whole controller (every endpoint under one Swagger tag)
.\apitest.cmd run --target epiasQA --tag reportind-data-controller

# 2. Exactly one endpoint
.\apitest.cmd run --target epiasQA --path "/v1/data/eligible-consumer-and-meter-increases"

# 3. Every endpoint under /v1/data/, but only the POST ones
.\apitest.cmd run --target epiasQA --path "/v1/data/*" --method POST

# 4. Two endpoints in one run (repeat the flag)
.\apitest.cmd run --target epiasQA --path "/v1/data/eligible-consumer-and-meter-increases" --path "/v1/data/<other-endpoint>"

# 5. Two controllers in one run
.\apitest.cmd run --target epiasQA --tag reportind-data-controller --tag <other-controller>

# 6. Only operations whose operationId starts with "get"
.\apitest.cmd run --target simpleapi --operation "get*"

# 7. A quick check of one endpoint first, then the full set of tests for it
.\apitest.cmd run --target epiasQA --path "/v1/data/eligible-consumer-and-meter-increases" --level smoke
.\apitest.cmd run --target epiasQA --path "/v1/data/eligible-consumer-and-meter-increases" --level standard

# 8. No flag: the target's filters: block from config/apitest.yaml is used
.\apitest.cmd run --target epiasQA
```

**The same in cmd.exe:**
```cmd
set TGT_TOKEN=<your TGT>
apitest run --target epiasQA --tag reportind-data-controller
apitest run --target epiasQA --path "/v1/data/eligible-consumer-and-meter-increases"
apitest run --target epiasQA --path "/v1/data/*" --method POST
```

**Quoting on Windows** (the most common mistake):
- Use **double quotes** `"..."`. In cmd.exe, single quotes are *not* quotes: `'/v1/data/x'` reaches the
  tool with the `'` characters in it and matches nothing. (The Mac examples use single quotes; on
  Windows, change them to double quotes.)
- Always quote values with `*`, spaces, `&`, `|`, `<`, `>` or `^`.
- Write paths with forward slashes `/`, exactly as in the Swagger, even on Windows.
- `--tag`, `--path` and `--operation` are case-sensitive; copy the values from Swagger UI or from
  the `analyze` output. `--method` is not (`post` = `POST`).

### Company network: proxy and certificates
- **Proxy:** set `proxy:` in `config/apitest.yaml` (e.g. `http://proxy.company.local:8080`), or set
  the `HTTPS_PROXY` environment variable. `NO_PROXY` is honoured for internal hosts.
  Proxies that require Windows login (NTLM/Kerberos) are not supported. If yours does, ask IT
  for the address of a proxy without login for internal test systems, or for a no-proxy rule.
- **Company TLS certificate** (error `unable to get local issuer certificate` or
  `self-signed certificate in certificate chain`): export your company root certificate as a
  `.pem` file (IT can provide it) and set `ca_bundle: C:/path/company-root.pem` in
  `config/apitest.yaml`. Alternatively:
  ```powershell
  $env:NODE_EXTRA_CA_CERTS = "C:\path\company-root.pem"
  ```
  On Node 22.15 or newer (or 23.8 or newer), `$env:NODE_OPTIONS = "--use-system-ca"` makes Node
  trust the Windows certificate store directly.

### PowerShell tips
- Quote globs and anything with `&`, `|`, `<`, `>` or `^`, for example `--operation "get_*"`.
- Ctrl+C stops a run cleanly. The current request finishes, then everything the run created is
  deleted. Pressing Ctrl+C a second time quits at once; in that case use `.\apitest.cmd cleanup --run <runId>`.

---

## On the Mac

Open Terminal and go to the project folder:
```bash
cd ~/Desktop/API_Manuel_Test_Tool_with_NodeJS
```
`./apitest` starts the tool. The commands are the same as on Windows.

### Step 1: look at the API (no requests to the API itself)
```bash
./apitest analyze --target simpleapi_offline
```
This shows:
- how many operations the API has;
- which fields have which rules;
- the auth setup;
- problems in the spec.

### Step 2: see which tests would run (dry-run, sends nothing)
```bash
./apitest generate --target simpleapi_offline --dry-run
./apitest generate --target simpleapi_offline --dry-run --level full --csv cases.csv   # all cases into a CSV
```

### Step 3: run the tests for real
```bash
./apitest run --target simpleapi --level smoke       # quick: one valid request per operation (~20 s)
./apitest run --target simpleapi --level standard    # baseline + required fields + data types ... (~4 min)
```
At the end it prints a summary and the path of the HTML report.

### Step 4: open the report
```bash
open runs/simpleapi/*/report.html
```
In the report:
- **1. Defects** lists what the API got wrong. Click a row to see the request, the response and the curl command.
- **Copy for ticket** copies a ready bug description, with title, steps, expected and actual result.
- **4. Cleanup problems** should be empty: everything the tool created was deleted again.

### Useful options
```bash
./apitest run --target simpleapi --operation "get_*"          # only some operations (glob on operationId)
./apitest run --target simpleapi --method GET --method DELETE  # only some HTTP methods
./apitest run --target simpleapi --tag items                   # only one tag
./apitest run --target epiasQA --path '/v1/data/eligible-consumer-and-meter-increases'   # one endpoint
./apitest report --run <runId>                                 # rebuild the report files
./apitest cleanup --run <runId>                                # delete leftovers if a run crashed
```

### APIs that need a credential (e.g. your TGT)
The tool never logs in. You give it the value, preferably through an environment variable:
```bash
export TGT_TOKEN=<your ticket>
./apitest run --target <your-work-target>
```
If no credential is given, operations that need one run only the "missing credential must be rejected" test.
Their other tests show as SKIPPED.

### Testing only part of a spec (one controller or one endpoint)
There are two ways. They select the same operations.

**1. In the config, as the target's default:** the `filters:` block of a target in `config/apitest.yaml`.
It applies to `generate` and `run` whenever you give no filter flag on the command line.
```yaml
  epiasQA:
    ...
    filters:
      tags: [reportind-data-controller]     # only the services under this Swagger tag
      paths: []                             # or one endpoint: ['/v1/data/eligible-consumer-and-meter-increases']
      methods: []                           # e.g. [POST]
      operations: []                        # operationId globs
```
- Empty lists (or no `filters:` block) = every operation.
- Values in one list are OR-ed; different lists are AND-ed. To test **only** one endpoint, put it in
  `paths` and empty `tags` (or keep the tag: the endpoint must then also carry that tag).
- `paths` are globs on the Swagger path **without** the service base path: `/v1/data/*` = every
  endpoint under `/v1/data/`.

**2. On the command line, for one run:** `--tag`, `--path`, `--method`, `--operation` (all repeatable).
Any of these flags **replaces** the whole `filters:` block for that run.
```bash
./apitest generate --target epiasQA --dry-run                                   # uses filters: from the config
./apitest run --target epiasQA --tag reportind-data-controller                  # whole controller
./apitest run --target epiasQA --path '/v1/data/eligible-consumer-and-meter-increases'   # one endpoint
./apitest run --target epiasQA --path '/v1/data/*' --method POST                # all POSTs under /v1/data/
```
`generate` prints which filter is active. A tag or path that matches nothing prints a warning; for a tag
the warning lists every tag of the spec, so a typo is easy to spot. `./apitest analyze --target epiasQA`
also lists the spec's tags and operations.

---

## Adding a new Swagger (a new target)
Adding a target is **config only**: no code changes. Any API works this way, company or public.

### Step 1: add an entry to `config/apitest.yaml`
Only `spec` is required; every other key is optional. For an EPİAŞ service, copy the `epiasQA` entry
and change `spec`, `base_url` and `filters`:
```yaml
  my_service:                       # any name; you use it as --target my_service
    spec: https://my-test-env.company.local/my-service/v2/api-docs   # URL or a saved .json/.yaml file
    base_url: https://my-test-env.company.local/my-service           # must include the service base path
    profile: company-test           # leave it out = public-demo (max 2 req/s); use company-test for work services
    auth:                           # only if the API needs a credential
      header: TGT
      env: TGT_TOKEN
      unauth_expect: [401, 403, 302]
      login_redirect_pattern: "/cas/login"
    exports:                        # only if the API has file-export endpoints
      tag_pattern: "-export-controller$"
      type_field: exportType
    overrides: config/overrides/epias.yaml   # optional, see "Optional files" below
    rules: [config/rules/epias.yaml]         # optional, see "Optional files" below
    filters: { tags: [], paths: [] }         # optional: test only part of the spec
```
- `base_url`: for EPİAŞ services the base path is `/<name>-service` (e.g. `/reporting-service`). Without it
  the requests go to the host root and fail. If you leave `base_url` out, the tool takes the server
  from the Swagger itself.
- Switching an environment (e.g. live → QA) = change the host in `spec` and `base_url`.

### Step 2: check it (no tests are sent; only the Swagger is downloaded)
```bash
./apitest analyze  --target my_service              # servers, tags, which endpoints need a credential, doc problems
./apitest generate --target my_service --dry-run    # which test cases would run
```
Just looking at a Swagger, without adding a target: `./apitest analyze --spec <url or file>`.

### Step 3: run it
First `--level smoke`, then `--level standard`, then look at the report.

### Where the tests come from
1. **The Swagger itself (automatic, every target).** Types, required fields, min/max, lengths, enums
   and formats become tests: missing required field, value one past the limit, wrong type, ...
   Most tests come from here.
2. **`config/rules/domain_rules.yaml` (automatic, every target).** General checks most APIs should
   pass, e.g. any date field gets `2023-02-30` (must be rejected). You never list this file;
   it is always loaded (turn it off with `use_default_rules: false` on the target).
3. **The target's own rules file (optional, you write it).** Rules the Swagger states only in
   description text, which the tool cannot read. Examples: Simple API says "type must be cd, dvd,
   book or blu-ray" only in text; EPİAŞ says "page size must be 10, 20, 24, 50 or 100".
   See "Adding your own rules" below.

### Optional files: do I need them?
| Key | What it is | When you need it |
|---|---|---|
| `rules:` | extra rules from description text | **Not at first.** Add one later if you notice an important limit that is only in the text. Another EPİAŞ service can reuse `config/rules/epias.yaml`. Also used to replace a default rule that is wrong for this API (same `id`). |
| `overrides:` | fixed values for the valid baseline request | Only if the tool cannot guess a valid request itself (e.g. EPİAŞ needs the `page` object). EPİAŞ services reuse `config/overrides/epias.yaml`. |
| `resources:` | how to create and delete test data | Only for services that **create or delete data**, so the tool can clean up after itself. Read-only report services don't need it. Example: `config/resources/simpleapi.yaml`. |
| `known_issues:` | defects you already know about | Only to mark known defects in the report. |

**In short:** start with only `spec`, `base_url`, `profile` and `auth`, run it, and add the other
files only if the report shows you need them.

---

## Exit codes (useful in scripts)
| Code | Meaning |
|---|---|
| 0 | all good |
| 1 | defects found, or cleanup problems |
| 2 | aborted: the server was unhealthy or the credential expired |
| 3 | wrong usage or config |

## What gets tested
| Technique | What it checks | Level |
|---|---|---|
| **BASE** | One valid request per operation. If it fails, the operation's other tests are skipped. | smoke |
| **AUTH** | A missing, empty, malformed or wrong-prefix credential must be rejected. Only for operations that need one. | smoke |
| **B-required** | Each required field omitted, `null`, `""` or whitespace must be rejected. Sending only the required fields must work. | standard |
| **A-datatype** | Wrong types, int32/int64 overflow, values outside an enum or in the wrong case, pattern violations. | standard (more at full) |
| **C-boundary** | min/max ±1, length and item limits from the spec. Where the spec documents no limit: generic limits at **full** level, plus a "constraint missing" documentation finding. | standard / full |
| **D-domain** | Rules the spec doesn't express: date formats, date ranges, paging, sort, and rules written only in descriptions. Defined in `config/rules/*.yaml`. | standard / full |
| **E-protocol** | Malformed JSON, empty body, body as an array, wrong Content-Type, unknown field, undocumented method → 405, unknown path → 404, ID that doesn't exist → 404, and (at full) special characters, unicode, very long strings. | standard / full |
| **F-export** | Each file type of an export operation (XLSX/CSV/PDF): file signature, Content-Type, file name, "JSON instead of a file". Needs `--include-exports`. | standard |
| **E-injection** | SQL/script/template strings. Needs `--allow-injection` and a profile that allows it; never on public demo servers. | full |
| **F (every test)** | Status code, Content-Type, response time, body against the documented schema (also for error bodies), error envelope inside a 2xx. | always |

### Request body types
JSON is used whenever an operation accepts it. Otherwise the tool sends:
- **form** (`application/x-www-form-urlencoded`);
- **multipart** (`multipart/form-data`), with a small generated PNG for file fields;
- **binary** (`application/octet-stream`).

The PNG is saved in the run folder as `apitest.png`, so the report's curl commands work when you run them from that folder.

### Only test what changed
```bash
./apitest diff old_spec.json new_spec.json             # what changed, field by field
./apitest diff <runId> https://.../openapi.json        # compare against the spec saved by an earlier run
./apitest run --target simpleapi --changed-since <runId>   # run only new + changed operations
```

### Adding your own rules
Rules that exist only in documentation go in a YAML file listed under the target's `rules:` (optional; see "Where the tests come from" above). For example, the Simple API's "price must be between 0 and 50000":
```yaml
rules:
  - id: SIMPLE-PRICE-ABOVE-MAX
    match: { location: body, name: "^price$" }
    value: 50000.01
    expect: reject          # reject = 4xx expected · accept = 2xx expected · no_5xx = just no server error
```
A rule with the same `id` as a default rule (`config/rules/domain_rules.yaml`) replaces it for that
target. Use this to set the real maximum date range of a service, for example, or to change the
`expect` of a default rule that is wrong for this API (e.g. the service correctly accepts dates without
a timezone: re-define `DATE-NO-OFFSET` with `expect: accept`).

### Output files of every run
`runs/<target>/<runId>/`:
- `report.html`: the report
- `junit.xml`: for CI tools
- `results.csv` and `results.xlsx`: all cases with results, plus Summary and Findings sheets
- `results.jsonl`, `run.json`, `run.log`, `spec_snapshot.json`, `created_resources.jsonl`: raw data

Rebuild any of them with `apitest report --run <runId> --format html,junit,csv,xlsx`.
