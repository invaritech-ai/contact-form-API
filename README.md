# Invaritech Contact API

A single synchronous HTTP endpoint for the invaritech.ai contact form. It
verifies Cloudflare Turnstile, appends a row to the leads spreadsheet, and
sends a notification email through Resend. There is no database, queue, or
background worker.

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

Every response is JSON, including unexpected failures.

| Status | Body | When |
| --- | --- | --- |
| 201 | `{"success":true}` | Row appended |
| 400 | `{"success":false,"error":"Invalid form submission."}` | Body is not valid multipart |
| 403 | `{"success":false,"error":"Origin not allowed"}` | `Origin` not in `ALLOWED_ORIGINS` |
| 413 | `{"success":false,"error":"Request too large."}` | Body exceeds `MAX_BODY_BYTES` |
| 422 | `{"success":false,"error":"..."}` | Field validation or Turnstile rejection |
| 429 | `{"success":false,"error":"Too many requests. Please try again later."}` | Rate limit |
| 500 / 503 | `{"success":false,"error":"Unable to send your message. Please try again."}` | Provider or unexpected failure |

Error messages are fixed, user-facing strings. Provider errors, spreadsheet
identifiers, and stack traces are never returned. Logs record failure points
only — never form contents, email addresses, phone numbers, or messages.

### Example request

```bash
curl -i -X POST https://YOUR-DEPLOYMENT/v1/contact \
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

## Environment variables

Every value is read from the runtime environment; nothing is committed. See
[.env.example](.env.example) for the annotated template.

| Variable | Required | Purpose |
| --- | --- | --- |
| `TURNSTILE_SECRET_KEY` | yes | Turnstile siteverify secret. Unset means every submission is refused with 503. |
| `GOOGLE_SHEETS_CLIENT_EMAIL` | yes | Service account with Editor access to the spreadsheet. |
| `GOOGLE_SHEETS_PRIVATE_KEY` | yes | Service-account PEM key. Literal `\n` sequences are expanded at runtime. |
| `LEADS_SPREADSHEET_ID` | yes | ID from the spreadsheet URL. |
| `LEADS_SHEET_NAME` | no | Tab name. Defaults to `Sheet1`. |
| `RESEND_API_KEY` | yes | Resend API key with send permission. |
| `CONTACT_NOTIFICATION_FROM` | yes | Sender address on a Resend-verified domain. |
| `CONTACT_NOTIFICATION_TO` | yes | Recipient(s), comma-separated. |
| `ALLOWED_ORIGINS` | yes | Comma-separated browser origins, exact match, no trailing slash. |
| `RATE_LIMIT_MAX` | no | Requests per window per IP. Defaults to `5`. |
| `RATE_LIMIT_WINDOW_SECONDS` | no | Window length. Defaults to `60`. |
| `MAX_BODY_BYTES` | no | Request body ceiling. Defaults to `100000`. |

## Spreadsheet layout

The service appends to the first empty row. The sheet's header row must match
this order exactly — a mismatch shifts values into the wrong columns:

```
timestamp, form_type, source, name, email, company, phone, country, role,
industry, main_control_problem, message, submit_page_url, submit_page_path,
submit_page_title, referrer, landing_page_url, landing_page_path, utm_source,
utm_medium, utm_campaign, utm_term, utm_content, utm_id, utm_source_platform,
utm_creative_format, utm_marketing_tactic, gclid, gbraid, wbraid, fbclid,
msclkid, li_fat_id, turnstile_status, turnstile_hostname
```

`form_type` and `source` are always `contact`. `role`, `industry`, and
`main_control_problem` belong to the resource form that shares this sheet and
are written empty — they are kept so both forms stay column-aligned.

Values beginning with `=`, `+`, `-`, or `@` are prefixed with an apostrophe so
Google Sheets stores them as text rather than evaluating them as formulas.

## Local development

```bash
npm install
cp .env.example .env.local   # then fill in real values
npm run dev                  # http://localhost:3000
```

Verify without any credentials configured — validation and CORS do not touch a
provider:

```bash
curl -s -X POST http://localhost:3000/v1/contact \
  -H "Origin: https://invaritech.ai" \
  -F name=Ada -F email=not-an-email -F country=UK -F message=hi -F cf_turnstile_token=x
```

That returns `422` with `Please enter a valid email address`. A fully valid
submission returns `503` until `TURNSTILE_SECRET_KEY` is set, because
verification cannot be performed. Set `ALLOWED_ORIGINS` to include
`http://localhost:3000` when testing from a local browser.

### Checks

```bash
npm test        # 40 tests, no network access required
npm run typecheck
npm run build
```

## Deployment

Any Node runtime that supports Next.js route handlers works. The repository is
configured for Vercel.

1. `npx vercel link` (first time only).
2. Add every required variable above to the Production environment, via the
   Vercel dashboard or `npx vercel env add <NAME> production`.
3. `npx vercel deploy --prod`.
4. Confirm the deployment: `curl https://YOUR-DEPLOYMENT/` returns
   `{"name":"Invaritech Contact API","status":"ok",...}`.

Before going live, check that the service account has Editor access to the
spreadsheet, and that `CONTACT_NOTIFICATION_FROM` uses a domain verified in
Resend — an unverified sender is the most common cause of missing
notifications.

### Connecting the website

The website reads its endpoint from `NEXT_PUBLIC_CONTACT_API_URL` at build
time. Set it to the full URL, e.g. `https://YOUR-DEPLOYMENT/v1/contact`, and
add the site's origin to `ALLOWED_ORIGINS` here. No frontend code changes are
needed.

## Design notes

- **Turnstile is the primary abuse control.** Rate limiting is in-memory and
  per-instance, so a serverless deployment with N warm instances allows up to
  N times `RATE_LIMIT_MAX`. Making it exact would require shared state, which
  this service deliberately does not have.
- **The spreadsheet is the source of truth.** If the row is written but the
  notification email fails, the request still returns 201. Returning an error
  would invite a resubmission and duplicate the lead. The email failure is
  logged.
- **`lib/handle-contact.ts` depends only on Web-standard `Request`/`Response`**
  and takes its provider calls as injected dependencies. That keeps the tests
  free of network access and makes a move to another runtime a matter of
  replacing the route wrapper.
- **Client IP** for Turnstile's `remoteip` is read from `cf-connecting-ip`,
  `x-real-ip`, then the first `x-forwarded-for` entry. On a host that forwards
  a client-supplied `x-forwarded-for` without overwriting it, remove that
  fallback in `lib/turnstile.ts`.
