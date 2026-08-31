# Invaritech Contact API

A single Cloudflare Worker serving the invaritech.ai contact form. It verifies
Cloudflare Turnstile, appends a row to the leads spreadsheet, and sends a
notification email through Resend. No framework, no dependencies at runtime, no
database or queue.

## Endpoint

```
POST /v1/contact
Content-Type: multipart/form-data
Accept: application/json
```

**Required fields:** `name`, `email`, `country`, `message`, `cf_turnstile_token`

**Optional fields:** `phone`, `company`

**Optional attribution fields:** `submit_page_url`, `submit_page_path`,
`submit_page_title`, `referrer`, `landing_page_url`, `landing_page_path`,
`utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`,
`utm_id`, `utm_source_platform`, `utm_creative_format`,
`utm_marketing_tactic`, `gclid`, `gbraid`, `wbraid`, `fbclid`, `msclkid`,
`li_fat_id`

The invoice extractor uses a second, email-only endpoint backed by the same
Turnstile, rate limit, spreadsheet, and notification pipeline:

```
POST /v1/invoice-interest
```

Required fields are `email`, `interest`, and `cf_turnstile_token`. `interest`
must be `invoice_pipeline` or `three_way_matching`. The Worker derives country
from Cloudflare and writes fixed intent copy; it does not accept a visitor
message or any invoice, filename, or batch identifier.

Every response is JSON, including unexpected failures.

| Status | Body | When |
| --- | --- | --- |
| 201 | `{"success":true}` | Row appended |
| 400 | `{"success":false,"error":"Invalid form submission."}` | Body is not valid multipart |
| 403 | `{"success":false,"error":"Origin not allowed"}` | `Origin` not in `ALLOWED_ORIGINS` |
| 404 / 405 | `{"success":false,"error":"..."}` | Unknown path, or wrong method |
| 413 | `{"success":false,"error":"Request too large."}` | Body exceeds `MAX_BODY_BYTES` |
| 422 | `{"success":false,"error":"..."}` | Field validation or Turnstile rejection |
| 429 | `{"success":false,"error":"Too many requests. Please try again later."}` | Rate limit |
| 500 / 503 | `{"success":false,"error":"Unable to send your message. Please try again."}` | Provider or unexpected failure |

`GET /` returns a health check.

Error messages are fixed, user-facing strings. Provider errors, spreadsheet
identifiers, and stack traces are never returned. Logs record failure points
only — never form contents, email addresses, phone numbers, or messages.

### Example request

```bash
curl -i -X POST https://api.invaritech.ai/v1/contact \
  -H "Origin: https://invaritech.ai" \
  -H "Accept: application/json" \
  -F "name=Ada Lovelace" \
  -F "email=ada@example.com" \
  -F "country=United Kingdom" \
  -F "message=I would like to discuss invoice automation." \
  -F "company=Analytical Engines Ltd" \
  -F "phone=+44 20 7946 0000" \
  -F "utm_source=google" \
  -F "cf_turnstile_token=THE_TOKEN_FROM_THE_WIDGET"
```

## Configuration

Five secrets, set with `wrangler secret put NAME`:

| Secret | Purpose |
| --- | --- |
| `TURNSTILE_SECRET_KEY` | Turnstile siteverify secret. Unset means every submission is refused with 503. |
| `GOOGLE_SHEETS_CLIENT_EMAIL` | Service account with Editor access to the spreadsheet. |
| `GOOGLE_SHEETS_PRIVATE_KEY` | Service-account PEM key. Literal `\n` sequences are expanded before import. |
| `LEADS_SPREADSHEET_ID` | ID from the spreadsheet URL. |
| `RESEND_API_KEY` | Resend API key with send permission. |

Everything else is non-secret and lives in `[vars]` in
[wrangler.toml](wrangler.toml): `ALLOWED_ORIGINS`,
`CONTACT_NOTIFICATION_FROM`, `CONTACT_NOTIFICATION_TO`, `LEADS_SHEET_NAME`,
`MAX_BODY_BYTES`. Rate limiting is the `[[ratelimits]]` binding, currently
5 requests per 60 seconds per client IP.

For local development, put everything in `.env.local` instead — see
[.env.example](.env.example).

## Spreadsheet layout

The Worker appends to the first empty row. The sheet's header row must match
this order exactly — a mismatch shifts values into the wrong columns:

```
timestamp, form_type, source, name, email, company, phone, country, role,
industry, main_control_problem, message, submit_page_url, submit_page_path,
submit_page_title, referrer, landing_page_url, landing_page_path, utm_source,
utm_medium, utm_campaign, utm_term, utm_content, utm_id, utm_source_platform,
utm_creative_format, utm_marketing_tactic, gclid, gbraid, wbraid, fbclid,
msclkid, li_fat_id, turnstile_status, turnstile_hostname, client_ref
```

For the contact form, `form_type` and `source` are `contact`. Invoice-interest
rows use `invoice_interest` and the selected interest code. `role`, `industry`, and
`main_control_problem` belong to the resource form that shares this sheet and
are written empty — they are kept so both forms stay column-aligned.
`client_ref` is the final column. It is empty for the general contact form and
contains the full browser UUID for invoice-interest rows.

Rows are written with `valueInputOption=RAW`, so Sheets stores every value
exactly as submitted instead of parsing it as though typed into the grid. That
is what keeps formulas inert — `=HYPERLINK(...)` is stored as text, never
evaluated — and what stops silent coercion: `02079460000` keeps its leading
zero, `1E5` stays `1E5`, and `3-4` does not become a date. Nothing is escaped,
so cells read back exactly as the visitor typed them.

One consequence: the `timestamp` column holds an ISO 8601 string rather than a
native Sheets date. It still sorts correctly, being lexicographically ordered,
but date-based formulas over that column need `DATEVALUE`.

## Local development

```bash
npm install
cp .env.example .env.local   # then fill in real values
npx wrangler dev             # http://127.0.0.1:8787
```

`wrangler dev` runs the real workerd runtime, so local behaviour matches
production. Verify without configuring anything — validation and CORS never
reach a provider:

```bash
curl -s -X POST http://127.0.0.1:8787/v1/contact \
  -H "Origin: https://invaritech.ai" \
  -F name=Ada -F email=not-an-email -F country=UK -F message=hi -F cf_turnstile_token=x
```

That returns `422` with `Please enter a valid email address`. A fully valid
submission returns `503` until `TURNSTILE_SECRET_KEY` is set, and `422` once it
is, because a hand-made token cannot pass siteverify. To exercise the
spreadsheet and email path end to end, temporarily set `TURNSTILE_SECRET_KEY`
to Cloudflare's always-passing test secret,
`1x0000000000000000000000000000000AA` — note that this writes a real row and
sends a real email.

### Checks

```bash
npm test          # 55 tests, no network access required
npm run typecheck
```

## Deployment

```bash
npx wrangler login
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put GOOGLE_SHEETS_CLIENT_EMAIL
npx wrangler secret put GOOGLE_SHEETS_PRIVATE_KEY
npx wrangler secret put LEADS_SPREADSHEET_ID
npx wrangler secret put RESEND_API_KEY
npm run deploy
```

Confirm the deployment:

```bash
curl https://api.invaritech.ai/
```

### Domain

`wrangler.toml` declares `api.invaritech.ai` as a Custom Domain. On deploy,
Cloudflare creates the DNS record and issues the certificate automatically,
provided the `invaritech.ai` zone is in the same account as the Worker — the
zone already uses Cloudflare nameservers, so this is a matter of account
placement, not a DNS migration.

If the first deploy fails on the route, comment out the `[[routes]]` block,
deploy to the `workers.dev` URL, move the zone into this account, then restore
the block and redeploy.

Before going live, check that the service account has Editor access to the
spreadsheet, and that `CONTACT_NOTIFICATION_FROM` uses a domain verified in
Resend — an unverified sender is the most common cause of missing
notifications.

### Connecting the website

The website reads its endpoint from `NEXT_PUBLIC_CONTACT_API_URL` at build
time. Set it to `https://api.invaritech.ai/v1/contact` and keep the site's
origin in `ALLOWED_ORIGINS`. No frontend code changes are needed.

## Troubleshooting

The Worker logs the reason a submission failed, with credentials, tokens, and
submitted values excluded. Spreadsheet IDs are replaced with
`[spreadsheet-id]` before any Google message is logged. Read them in the
dashboard under **Observability**, or with `wrangler tail`.

| Log line | Meaning | Fix |
| --- | --- | --- |
| `sheets: append failed` with `INVALID_ARGUMENT` and `Unable to parse range` | The tab named in `LEADS_SHEET_NAME` does not exist. The `range` and `sheetName` fields show what was attempted. | Set `LEADS_SHEET_NAME` to the exact tab name. Unset, it defaults to `Sheet1`. |
| `sheets: append failed` with `NOT_FOUND` | `LEADS_SPREADSHEET_ID` points at a spreadsheet that does not exist, or one the service account cannot see. | Check the ID, and share the sheet with `GOOGLE_SHEETS_CLIENT_EMAIL` as Editor. |
| `sheets: append failed` with `PERMISSION_DENIED` | The service account lacks access, or the Sheets API is disabled on its Google Cloud project. | Share the sheet as Editor; enable the Google Sheets API. |
| `sheets: credentials missing` | `GOOGLE_SHEETS_CLIENT_EMAIL` or `GOOGLE_SHEETS_PRIVATE_KEY` is not set. The log reports which. | Set the missing secret. |
| `sheets: LEADS_SPREADSHEET_ID is not set` | Self-explanatory. | Set the secret. |
| `sheets: private key could not be parsed` | The PEM is malformed. The log reports its length and whether it starts with the PEM header and contains escaped or real newlines. | Re-paste the key as a single line with literal `\n` sequences. |
| `sheets: token exchange failed` with `invalid_grant` | The private key does not match the service account, or the machine clock is far off. | Re-issue the service-account key. |
| `contact: notification email failed` | Resend rejected the send. The row was still written and the caller still got a 201. | Check `RESEND_API_KEY` and that `CONTACT_NOTIFICATION_FROM` uses a Resend-verified domain. |

A successful write logs `sheets: append ok` with the tab name.

**Configuration precedence matters here.** Variables set in the Cloudflare
dashboard and `[vars]` in `wrangler.toml` are not merged — a deploy that
carries `[vars]` replaces the plain variables on the Worker. If the two
disagree, the running Worker may not match this repository. Secrets are never
touched by a deploy.

## Design notes

- **No `googleapis`.** That client depends on Node built-ins and does not run
  on Workers. `src/sheets.ts` signs the service-account JWT with WebCrypto
  (`RSASSA-PKCS1-v1_5` over an imported PKCS#8 key), exchanges it for an access
  token, and calls the Sheets REST API. The token is cached per isolate and
  refreshed a minute before expiry.
- **Rate limiting is enforced at the edge** by Cloudflare's rate limiting
  binding, not by per-instance counters. `src/rate-limit.ts` keeps a small
  in-memory fallback for tests and for `wrangler dev` runs without the binding.
- **Client IP comes from `CF-Connecting-IP` only.** The edge sets it and a
  client cannot forge it, so it is safe as Turnstile's `remoteip`. Forwarded
  headers are deliberately ignored.
- **Sheets writes use `RAW`.** See the spreadsheet section above: `USER_ENTERED`
  would evaluate formulas and rewrite phone numbers and click IDs that happen
  to look numeric.
- **The spreadsheet is the source of truth.** If the row is written but the
  notification email fails, the request still returns 201. Returning an error
  would invite a resubmission and duplicate the lead. The failure is logged.
- **`src/handle-contact.ts` takes its provider calls as injected dependencies**
  and uses only Web-standard `Request`/`Response`, so the tests need no network
  and the logic is not coupled to Workers.
