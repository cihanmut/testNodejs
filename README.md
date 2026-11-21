# apitest — Swagger-driven REST API test tool (Node.js)

Takes a Swagger 2.0 / OpenAPI 3.x spec (file, URL or editor.swagger.io link), builds **one valid
baseline request per operation**, then generates test cases that each change **exactly one thing**
(so every failure points to one field and one rule). It runs them safely and writes a self-contained
HTML report you can attach to a bug ticket.

This is the **Node.js version** of the tool, with the same working logic as the Python version
(`API_Manuel_Test_Tool_with_Python`): same techniques, same safety rules, same config files, same
run folder and report formats. It needs **only Node.js 18 or newer**:

- no `npm install`;
- no Python;
- no admin rights;
- no download on the work PC.

You copy the folder and run it.

Docs:
- `docs/how-to-run.md`: step-by-step guide, macOS and Windows.
- `docs/porting-notes.md`: how the Python libraries were replaced, and the small differences.
- `docs/requirements.md`: the requirements.
- `docs/step0-analysis.md`: the spec analysis.
- `docs/implementation-plan.md`: the design.
- `CLAUDE.md`: rules for contributors and AI sessions.

## Run it

```bash
./apitest --help                 # macOS / Linux
apitest.cmd --help               # Windows (cmd or PowerShell: .\apitest.cmd --help)
node src/cli.js --help           # anywhere
```

## Commands

```bash
apitest analyze  --target epias                          # Step-0 statistics + documentation findings
apitest generate --target epias --dry-run [--level full] [--include-exports] [--tag T] [--csv cases.csv]
apitest run      --target simpleapi --level standard               # shared public demo, 1 req/s
apitest run      --resume <runId> --credential-env TGT_TOKEN        # e.g. after the credential expired
apitest report   --run <runId>                           # re-render HTML, JUnit, CSV, Excel
apitest cleanup  --run <runId>                           # retry deleting leftovers of a run
apitest diff     <old spec|runId> <new spec|URL>         # what changed between two spec versions
apitest run      --target simpleapi --changed-since <runId>  # test only new/changed operations
apitest fetch-spec <url|editor link> --out tests/fixtures/x.json      # only way to touch a denylisted host
```

- **Filters:** `--tag`, `--path` (glob), `--method`, `--operation` (operationId glob). All are repeatable.
- **Levels:** `smoke` (baseline + auth) ⊂ `standard` ⊂ `full`.
- **Exit codes:**
  - 0: ok
  - 1: failures or cleanup problems
  - 2: aborted (unhealthy server or expired credential)
  - 3: usage or config error
  - 4: blocked by the denylist

Every run writes these files to `runs/<target>/<runId>/`:

- `report.html`, `junit.xml`, `results.csv`, `results.xlsx`
- `results.jsonl`: the checkpoint
- `run.json`, `spec_snapshot.json`, `created_resources.jsonl`
- `run.log`: masked

The format is the same as the Python version's, so the Node reporter can re-render a Python run folder.

## Credentials

The tool never logs in and never creates, refreshes or stores a credential. You give it one, and it
uses the first of these that is set:

1. `--credential VALUE`
2. `--credential-env NAME`
3. the target's env var (`auth.env` in the config, for example `TGT_TOKEN`)
4. `config/credentials.local.yaml` (git-ignored), with a line `<target>: <value>`

The credential is masked everywhere: only the last 4 characters are shown. The curl commands in the report use the env var
name instead: `$TGT_TOKEN` in bash, `$env:TGT_TOKEN` in PowerShell.

## Safety

- `config/safety.yaml` and the built-in default list hosts that must never receive requests
  (EPİAŞ). No CLI flag can override them.
- The `public-demo` profile is enforced in code:
  - at most 2 requests per second;
  - PUT/DELETE only on resources this run created;
  - no injection strings.
- Everything a run creates is deleted, even on failure or Ctrl+C.
- Retries happen only on network errors, never on an HTTP status. Redirects are never followed.

## Configuration

- Targets: `config/apitest.yaml`
- Resource lifecycles: `config/resources/*.yaml`
- Baseline overrides: `config/overrides/*.yaml`
- Domain rules: `config/rules/*.yaml`
- Accepted findings: `config/known_issues/*.yaml`, reported as KNOWN

Adding an API means one new target entry with its spec link.

## Tests (development only; not needed on the work PC)

```bash
npm test                    # 92 offline unit tests (node:test, saved spec fixtures + in-memory fakes)
```

## Third-party code

`vendor/js-yaml.mjs` is the [js-yaml](https://github.com/nodeca/js-yaml) 4.1.0 YAML parser (MIT
licence, `vendor/js-yaml.LICENSE`), copied in as a single file so nothing has to be installed.
Everything else is plain Node.js built-in modules.
