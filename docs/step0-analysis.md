# Step 0 — Spec analysis (offline, read-only)

Date: 2026-11-07. Specs were downloaded once into `tests/fixtures/` and analyzed offline from those files:
- `epias_electricity_swagger.json`: one GET to EPİAŞ, HTTP 200, 871 KB. No other EPİAŞ request was made.
- `petstore_v3_openapi.json` (17 KB), `petstore_v2_swagger.json` (14 KB).

## 1. Version and operation counts

| | EPİAŞ | Petstore v3 | Petstore v2 |
|---|---|---|---|
| Spec version | Swagger 2.0 | OpenAPI 3.0.4 | Swagger 2.0 |
| Base | `seffaflik.epias.com.tr/electricity-service` | server `/api/v3` (relative) | `petstore.swagger.io/v2` |
| Operations / paths | **301** / 301 | 19 / 13 | 20 / 14 |
| By method | POST 270, GET 31 | GET 8, POST 6, PUT 2, DELETE 3 | GET 8, POST 7, PUT 2, DELETE 3 |
| Tags | **35** | 3 (pet 8, user 7, store 4) | 3 (pet 8, user 8, store 4) |
| Schemas | 629 (248 reachable from request bodies) | 6 | 6 |

EPİAŞ tags: 21 `*-data-controller` tags (178 ops) and 14 `*-export-controller` tags (122 ops), plus `menu-controller` (3). The largest are consumption-data 26, markets-gop-data 19, renewables-data 19, consumption-export 17 and renewables-export 17. The 301 paths map 1:1 to operations, and there are no path parameters. Every POST has a required JSON body.

## 2. Auth

| | EPİAŞ | Petstore v3 | Petstore v2 |
|---|---|---|---|
| securityDefinitions / schemes | **none** | `api_key` (apiKey, header `api_key`), `petstore_auth` (oauth2) | same |
| Explicit auth header param | `TGT` on **208** ops, all `required: true` | `api_key` on 1 op (DELETE /pet/{petId}), optional | same, 1 op |
| Security requirement | 0 ops | 9 ops: petstore_auth 7, api_key 1, both 1 | 9 ops: petstore_auth 7, api_key 2 |
| No auth at all | **93** ops | 10 ops (all of store/order, most of user) | 11 ops |

- EPİAŞ: TGT appears on 162/178 data ops, 45/122 export ops, 29/31 GETs and all menu/main/dashboard ops. So "export = public" is false, and the decision has to be made per operation.
- Petstore: `api_key` appears in **both** forms. DELETE /pet/{petId} declares it as a header param *and* has `petstore_auth`. The detection rule (header param OR mapped scheme) covers both. `petstore_auth` (OAuth2) has to be on the ignore list, otherwise 7 pet operations would wrongly need a credential we can't supply.

## 3. Constraint keywords

Counts are occurrences in parameters + schema definitions.

| Keyword | EPİAŞ (all / request side) | Petstore v3 | Petstore v2 |
|---|---|---|---|
| required | 1614 / **545** | 13 | 26 |
| enum | 832 / **116** | 3 | 6 |
| format | 3252 / **504** | 21 | 36 |
| example | 4440 / **719** | 26 | 3 |
| default | 0 | 1 | 1 |
| minimum / maximum | **0 / 0** | 0 / 0 | 2 / 1 |
| minLength / maxLength | **0 / 0** | 0 / 0 | 0 / 0 |
| pattern | **0** | 0 | 0 |
| minItems / maxItems | 0 / 0 | 0 / 0 | 0 / 0 |
| uniqueItems | 6 / 3 | 0 | 0 |

- EPİAŞ request formats: `date-time` 406, `int64` 82, `int32` 13. Required request fields are dominated by `startDate` (187), `endDate` (180), `exportType` (111) and `period` (26). The request-side enums are almost all `exportType` (XLSX/CSV/PDF), plus `SortDTO.direction` (ASC/DESC).
- **Every date example is `2021-01-01T00:00:00+03:00`** (406/406). The `startDate` description says "`2023-01-01T00:00:00+03:00` formatında". The spec has no `pattern` for this format.
- Paging: 222 request models carry `page: Page{number, size, total, sort: SortDTO{field, direction ASC|DESC}}`. Examples are number=1, size=20 (description: "10,20,24,50,100"), sort.field=`startDate`.
- None of the three specs has min/max length or a pattern, and Petstore v2 has only 3 min/max constraints. Spec-driven boundary tests (technique C) therefore have almost nothing to trigger on. Most findings will come from the generic-limits path (reported as "constraint missing in spec" DOCUMENTATION findings) and from the domain rules file (technique D).

## 4. Request content types and ID dependencies

| | EPİAŞ | Petstore v3 | Petstore v2 |
|---|---|---|---|
| Request bodies | JSON 267 + XML 267 (`consumes` both); 270 body params | JSON 6, XML 5, form-urlencoded 5, octet-stream 1 | JSON 7, XML 2, form-urlencoded 1, multipart 1 |
| Param locations | body 270, header 208 | path 9, query 7, header 1 | path 9, body 7, query 4, formData 4, header 1 |
| Distinct body models | 246 (nearly one per op) | Pet, User, Order, array, binary | Pet, User, Order, array |

ID fields that need values from other operations:
- **Petstore:** `petId` (int64 path ×4), `orderId` (int64 path ×2), `username` (string path ×3), and `Order.petId` in the body. Producers: POST /pet → `$.id`, POST /store/order → `$.id`, POST /user → `username` (taken from the request we send; POST /user's response is not the source of truth).
- **EPİAŞ:** no path IDs. The body carries lookup IDs instead: `organizationId` 28, `id` 21, `provinceId` 14, `uevcbId` 10, `powerPlantId` 8, `distributionId` 6, `damId` 5, `regionId` 3. They come from list operations (e.g. GET distribution-region, get-distribution-companies). This is a read-only "lookup" dependency, not create/delete. Example values are present for most of them, but they can't be checked without calling the API. In dry-run they come from overrides/examples.

## 5. Responses and envelopes

| | EPİAŞ | Petstore v3 | Petstore v2 |
|---|---|---|---|
| Codes (ops) | 200: 301, **400: 208, 500: 208** | 200: 19, 400: 15, 404: 8, 422: 3, default: 19 | 200: 9, 400: 12, 404: 8, 405: 3, default: 4 |
| Error body schemas | **none** | none | none |
| 200 schemas | 301 | 14 | 9 |

- EPİAŞ: 400/500 are documented on **exactly the same 208 operations that have TGT**. The 93 public operations document only 200.
- EPİAŞ 200 shapes: `{items, page}` 59, `{items, page, statistics}` 52, `{items}` 23, other/empty 14.
- **All 122 export operations declare a 200 schema of Spring `ModelAndView`** (`{empty, model, modelMap, reference, status, view}`) and `produces: application/json, application/xml`. The XLSX/CSV/PDF file output is not documented anywhere except in the `exportType` enum and the description text. The tool has to recognise file responses through config or the export-tag convention, not through the spec.
- Petstore: there is no error envelope model. `ApiResponse{code, type, message}` exists, but only as a success body (uploadImage).
- No spec defines an error envelope inside 200. The JSON path for that check has to come from config.

## 6. Spec quality issues

| Issue | EPİAŞ | Petstore v3 | Petstore v2 |
|---|---|---|---|
| Unrendered `${...}` | **2**: POST `/v1/consumption/data/multiple-factor-bulk` summary `${VALUE_MULTIPLE_FACTOR_BULK_DATA}`, description `${NOTES_MULTIPLE_FACTOR_BULK_DATA}` | 0 | 0 |
| Duplicate summaries | 4 summaries shared by 8 ops (e.g. "Profil Abone Grubu Listeleme Servisi" ×2) | 0 | 1 ("Creates list of users with given input array" ×2) |
| Missing summary/description | 1 op (`GET /v1/menu/get-menu-tree`) | 0 | 11 ops without description |
| Properties without description | 703 / 2523 | 24 / 27 | 24 / 27 |
| Properties without example | 1384 / 2523 | 10 / 27 | 25 / 27 |
| File responses not declared | 122 export ops (ModelAndView) | — | — |
| Error responses without schema | 208 ops | all | all |
| `consumes` missing | 1 POST (`multiple-factor-distribution`) + GETs | — | — |

Rules that exist only in description text, i.e. domain-rule candidates:
- EPİAŞ: `uevcbIds`, `powerPlantIds`, `organizationIds` say "must not exceed 1000; avoid duplicate ids", but the schema has no maxItems and the uniqueItems setting doesn't match. Block-order ops say "at least 3, at most 24 hours". `size` is restricted to "10, 20, 24, 50, 100" in text only. The date format is given only in text, and the spec has no pattern.
- Petstore v3: DELETE /store/order/{orderId}: "IDs above 1000 or non-integers will generate API errors". It is not expressed as a maximum.
- None of the specs states a maximum date-range length. That has to be a configurable domain rule.

## 7. Your assumptions vs. the spec

| Your assumption | Result |
|---|---|
| Swagger 2.0, ~300 ops, ~35 tags | ✅ 301 ops, 35 tags |
| Mostly POST + JSON body, some GET | ✅ 270 POST (all with a required body), 31 GET |
| `*-export-controller` returns XLSX/CSV/PDF | ✅ by intent (`exportType` enum), ⚠ but the spec declares JSON/XML + ModelAndView |
| Auth only via `TGT` header, not securityDefinitions | ✅ 208 ops, required:true; 93 ops without |
| Date format `yyyy-MM-dd'T'HH:mm:ssXXX` | ✅ all 406 date examples use `+03:00` offset; no `pattern` |
| Paging (number, size, total) + sort (field, ASC/DESC) | ✅ `Page` + `SortDTO`, in 222 request models |
| Responses mostly 200/400/500, no error schemas | ✅ exactly; 400/500 only on TGT ops |

## 8. What this means for the design
1. **Auth detection has to handle both styles.** EPİAŞ uses only a header param (208/301 ops). Petstore uses schemes plus one explicit param, and `petstore_auth` has to be ignored. This confirms the planned rule: header-param OR mapped-scheme, with config overrides on top.
2. **The baseline can mostly come from spec examples on EPİAŞ** (719 request-side examples, a consistent date example). One fixed date (`2021-01-01`) is risky as a range, so smart defaults should build `startDate`/`endDate` from the field names.
3. **Boundary tests have to fall back to generic limits plus domain rules.** No spec has length, pattern or array limits. Most of the value comes from the date/paging/sort rule file and from "constraint missing" documentation findings.
4. **The negative/oracle logic needs codes from config**, because error codes and schemas are barely documented: the 93 public EPİAŞ ops document only 200.
5. **Export operations need special handling.** Identify them by tag pattern + `exportType`, and validate them as files, never against the ModelAndView schema. That schema itself is a documentation finding for all 122.
6. **Resource lifecycle is a Petstore-only concern** (pet/order/user, 6 dependent path params). EPİAŞ needs "lookup" dependencies, which overrides can satisfy for dry-run.
7. **Body formats:** EPİAŞ needs JSON (XML is declared for all 267 bodies; offer it as optional). Petstore v3 also needs XML, form-urlencoded and octet-stream; v2 needs multipart. This matches the Phase 1 JSON → Phase 3 form/multipart split.
8. **Scale:** 301 ops × ~2 date fields × ~20 date rules + paging/sort rules → several thousand dry-run cases. Generation must be model-driven and fast (no per-case schema re-resolution).
