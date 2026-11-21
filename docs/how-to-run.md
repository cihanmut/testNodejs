# How to run the tool (Node.js version)

The tool has a few everyday commands. You always tell it **which API** to test with `--target`.
Targets are defined in `config/apitest.yaml`.

| Target name | What it is | Sends requests? |
|---|---|---|
| `simpleapi` | apichallenges.com Simple API (spec downloaded from the internet) | yes, at 1 request/second |
| `simpleapi_offline` | same API, spec read from `tests/fixtures/` | only `run` sends requests |
| `epias` | EPİAŞ fixture | **never**. `run` is blocked (exit code 4) |

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

---

## Adding your work service as a target
Add an entry under `targets:` in `config/apitest.yaml`. Copy the `epias` entry as a template:
```yaml
  my_service:
    spec: https://my-test-env.company.local/my-service/v2/api-docs   # or a saved file
    base_url: https://my-test-env.company.local/my-service
    profile: company-test
    auth:
      header: TGT
      env: TGT_TOKEN
      unauth_expect: [401, 403, 302]
      login_redirect_pattern: "/cas/login"
    exports:
      tag_pattern: "-export-controller$"
      type_field: exportType
    overrides: config/overrides/epias.yaml
    rules: [config/rules/epias.yaml]
```
Then start with `generate --dry-run`, then a `smoke` run, then `standard`. Services that create
data also need a `resources:` file, so the tool can delete what it creates; see
`config/resources/simpleapi.yaml` for an example.

---

## Exit codes (useful in scripts)
| Code | Meaning |
|---|---|
| 0 | all good |
| 1 | defects found, or cleanup problems |
| 2 | aborted: the server was unhealthy or the credential expired |
| 3 | wrong usage or config |
| 4 | blocked by the host denylist |

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
Rules that exist only in documentation go in a YAML file listed under the target's `rules:`. For example, the Simple API's "price must be between 0 and 50000":
```yaml
rules:
  - id: SIMPLE-PRICE-ABOVE-MAX
    match: { location: body, name: "^price$" }
    value: 50000.01
    expect: reject          # reject = 4xx expected · accept = 2xx expected · no_5xx = just no server error
```
A rule with the same `id` as a default rule (`config/rules/domain_rules.yaml`) replaces it for that
target. Use this to set the real maximum date range of a service, for example.

### Output files of every run
`runs/<target>/<runId>/`:
- `report.html`: the report
- `junit.xml`: for CI tools
- `results.csv` and `results.xlsx`: all cases with results, plus Summary and Findings sheets
- `results.jsonl`, `run.json`, `run.log`, `spec_snapshot.json`, `created_resources.jsonl`: raw data

Rebuild any of them with `apitest report --run <runId> --format html,junit,csv,xlsx`.
