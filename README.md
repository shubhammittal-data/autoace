# AutoAce — Retell AI × Xtime Service Scheduling Bridge

> **Live deployment:** `https://autoace-pink.vercel.app`
>
> **Architecture:** `Retell(Voice) → NextJS(MappingLogic) → Xtime(EndpointInjection)`

Voice-driven service appointment scheduling for car dealerships. A Retell AI
voice agent answers calls, collects customer intent, and fires a single tool
call to a Next.js middleware that orchestrates the full Xtime booking sequence
and writes an audit trail to Supabase.

```
 ┌──────────────┐  voice + tool call  ┌─────────────────────────┐  xws/rest   ┌──────────────┐
 │  Retell AI   │ ──────────────────► │  Next.js API middleware  │ ──────────► │   Xtime API  │
 │  voice agent │    JSON body        │  /api/schedule-xtime     │  tokenId+   │ x10con.xtime │
 │  (Alex)      │ ◄────────────────── │  (Vercel, Node runtime)  │  XID cookie │     .com     │
 └──────────────┘  success/message    └────────────┬────────────┘             └──────────────┘
                                                   │ audit trail
                                                   ▼
                                             ┌──────────┐
                                             │ Supabase │
                                             │ dealers  │
                                             │ appoints │
                                             └──────────┘
```

---

## Deliverables (per Direct Implementation Guide)

### ✅ Deliverable 1 — Reverse-engineered Xtime API + Authentication

Intercepted all traffic from `mcgovernsubaruofacton.com` via Chrome DevTools.
Mapped the complete auth pattern and every endpoint in the booking flow.

**Auth pattern discovered:**

| Token | Location | Lifetime | Source |
|---|---|---|---|
| `tokenId` | Query param | Minutes–hours | `consumer.xtime.com` page HTML |
| `dlrCountryCode` | Query param | Static | Hardcoded `US` |
| `gRecaptchaResponse` | Query param | ~2 min, single-use | CapSolver API / Playwright / manual |
| `XID` cookie | Response → subsequent requests | Session | Auto-captured by `xtimeFetch` on first call |

**Required headers on every call:**
```
Origin:  https://consumer.xtime.com
Referer: https://consumer.xtime.com/
```

**Endpoints mapped (The Fork — Phase 1):**

| Step | Method | Endpoint | Purpose |
|---|---|---|---|
| Preflight | GET | `/xws/rest/dealer/{id}/settings` | Warm XID session cookie |
| A | GET | `/xws/rest/vehicles/dealer/{id}/customerVehicles` | Existing vs. new customer fork |
| C1 | GET | `/xws/rest/vehicles/dealer/{id}/trim` | Resolve `metaVehicleId` + engine details |
| C2 | GET | `/xws/rest/vehicles/dealer/{id}/details` | Confirm vehicle metadata |
| D1 | POST | `/xws/rest/services/dealer/{id}/recommendedServices` | Fetch service catalog |
| D2 | POST | `/xws/rest/services/dealer/{id}/maintenanceServices` | Fallback service catalog |
| E | POST | `/xws/rest/appointment/dealer/{id}/getFirstAvailability` | Check slot availability |
| F | POST | `/xws/rest/appointment/dealer/{id}/confirm` | **The God Request** — final booking |

**The Fork (Phase 1 logic):**
- **Existing customer** (`customerVehicles` returns results) → `apptFlow=FIND_ME` with `customerPersonId` + `vehicleId`
- **New customer** (empty results) → `apptFlow=IM_NEW_HERE` with full name/email/vehicle object

**The God Request — booking payload fields:**
```
dealerId, tokenId, gRecaptchaResponse, advisorId, apptFlow, autoRecallIds,
autoRecallServices, callbackRequired, channel, declinedServices,
emailPrivacySetting, externalValetProvider, ignoreConflicts, locale,
metaVehicleId, mileage, mobilePhoneNumber, selectedDate, selectedTime,
servicePoint, services (JSON), textPrivacySetting, transportationOption,
vehicle (JSON), whoami, email, firstName, lastName, phoneNumber
```

---

### ✅ Deliverable 2 — Postman Collection

All mapped Xtime endpoints + the middleware are in:

```
postman/AutoAce_Xtime.postman_collection.json
```

Import into Postman to exercise raw Xtime calls and the middleware directly.
Includes pre-request scripts, environment variables, and example responses.

---

### ✅ Deliverable 3 — Next.js Middleware `/api/schedule-xtime`

Full orchestration route at `app/api/schedule-xtime/route.ts`.

**Flow:**
1. Receive + validate Retell tool-call JSON (Zod schema)
2. Query Supabase for dealer by `dealer_slug`
3. Mint reCAPTCHA tokens (CapSolver on production, Playwright locally)
4. **Step 0:** Warm XID session via `/settings`
5. **Step A:** `customerVehicles` lookup → existing or new customer fork
6. **Step C:** Resolve `metaVehicleId` + engine/trim via `/trim` + `/details`
7. **Step D:** Fetch service catalog → match natural-language request to Xtime service ID
8. **Step E:** Check slot availability via `getFirstAvailability`
9. **Step F:** Place booking via `/confirm` (the God Request)
10. Write audit row to Supabase `appointments` table
11. Return `{ success, message, appointment }` for Retell agent to speak verbatim

**Service code mapping** (`lib/xtime/serviceCodes.ts`):
Natural language like "oil change", "tire rotation", "brakes" → Xtime `serviceCode`.

**reCAPTCHA modes** (set via `RECAPTCHA_MODE`):
- `capsolver` — cloud CAPTCHA solving via CapSolver API (production)
- `playwright` — headless Chromium minting real tokens (local dev)
- `twocaptcha` — 2Captcha API alternative
- `manual` — paste token directly (demo/testing)

---

### ✅ Deliverable 4 — Retell → Next.js → Xtime Integration

**Verified live** via Vercel deployment logs showing real POST hits from Retell:

```
13:07:50  autoace-pink.vercel.app  POST /api/schedule-xtime  200
13:07:15  autoace-pink.vercel.app  POST /api/schedule-xtime  200
13:06:43  autoace-pink.vercel.app  POST /api/schedule-xtime  200
```

The voice agent ("Alex") correctly:
- Collects name, phone/email, vehicle YMM, service type, transportation preference, time
- Calls `schedule_xtime_appointment` tool with structured JSON
- Reads the `message` field verbatim back to the caller
- Retries with a new time on `NO_AVAILABILITY`
- Offers human transfer on other failures

---

## ⚠️ Known Limitation — Final Booking Step

**What fails:** The last step — `POST /xws/rest/appointment/dealer/{id}/confirm` (the God Request) — returns `{"statusCode":1,"success":false,"message":"HTTP 500 Internal Server Error"}` from Xtime's server.

**What works:** Every upstream step succeeds:
- ✅ Session warm-up (`/settings`)
- ✅ Customer/vehicle lookup (`/customerVehicles`)
- ✅ Vehicle metadata resolution (`/trim`, `/details`)
- ✅ Service catalog matching (`/recommendedServices`, `/maintenanceServices`)
- ✅ Slot availability check (`/getFirstAvailability`) — returns real open slots
- ✅ Full booking payload construction (all 25+ fields correctly populated)
- ✅ Retell voice agent calling the API and handling responses correctly

**Root cause:** Xtime uses **Google reCAPTCHA v3 Enterprise** with server-side token validation. When a real browser at `consumer.xtime.com` executes `grecaptcha.execute()`, Google scores the token 0.9 (human). When the same call is made from a cloud server (even via headless Chromium or a CAPTCHA-solving service like CapSolver), Xtime's backend rejects the token with HTTP 500 — regardless of the token's length or format.

A successful booking was confirmed via direct browser DevTools capture (the real consumer flow works). The API payload is correct — this is purely an anti-bot enforcement issue on Xtime's side, not a code or payload deficiency.

**Potential paths to resolution:**
- Obtain a dealer API key directly from Xtime (bypasses consumer reCAPTCHA entirely)
- Maintain a persistent authenticated browser session server-side using a residential proxy
- Use the dealer's DMS (CDK/Reynolds) API instead of the consumer-facing Xtime endpoint

---

## Repo Layout

| Path | Purpose |
|---|---|
| `app/api/schedule-xtime/route.ts` | Main orchestration handler (Steps 0–F) |
| `app/api/health/route.ts` | Liveness probe |
| `lib/xtime/client.ts` | All Xtime API wrappers + auth bag + XID cookie management |
| `lib/xtime/recaptcha.ts` | reCAPTCHA provider (capsolver / playwright / twocaptcha / manual) |
| `lib/xtime/types.ts` | TypeScript contracts for all Xtime request/response shapes |
| `lib/xtime/serviceCodes.ts` | Natural language → Xtime service code mapping |
| `lib/retell.ts` | Zod schema for Retell tool payload + date helpers |
| `lib/supabase.ts` | Supabase admin client |
| `lib/database.types.ts` | Supabase schema types |
| `supabase/migrations/0001_init.sql` | `dealers` + `appointments` table definitions |
| `retell/agent-prompt.md` | System prompt for the Retell voice agent |
| `retell/schedule-xtime.tool.json` | Retell custom function tool definition |
| `postman/AutoAce_Xtime.postman_collection.json` | Full Postman collection |

---

## Local Setup

```powershell
# Node 18+ required
npm install

# Copy and fill env vars
copy .env.example .env.local

# Start dev server
npm run dev
```

Health check: `http://localhost:3000/api/health`

**Test booking (PowerShell):**
```powershell
Invoke-RestMethod -Method POST -Uri "http://localhost:3000/api/schedule-xtime" `
  -ContentType "application/json" `
  -Body (@{
    dealer_slug         = "mcgovernsubaruofacton"
    service_requested   = "oil change"
    customer_email      = "test@example.com"
    customer_first_name = "Jane"
    customer_last_name  = "Smith"
    vehicle_make        = "SUBARU"
    vehicle_model       = "ASCENT"
    vehicle_year        = 2023
    appointment_time    = "2026-06-13T09:00:00"
    transportation      = "DROPOFF"
  } | ConvertTo-Json) | ConvertTo-Json -Depth 5
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
| `XTIME_BASE_URL` | `https://x10con.xtime.com` |
| `XTIME_CONSUMER_ORIGIN` | `https://consumer.xtime.com` |
| `XTIME_TOKEN_ID` | Session token from `consumer.xtime.com` network tab |
| `XTIME_COUNTRY_CODE` | `US` |
| `XTIME_DEALER_ID` | Dealer ID from URL path (e.g. `xtm20220211107xx1`) |
| `RECAPTCHA_MODE` | `capsolver` \| `playwright` \| `twocaptcha` \| `manual` |
| `RECAPTCHA_SITE_KEY` | Google reCAPTCHA v3 site key from `consumer.xtime.com` |
| `RECAPTCHA_PAGE_URL` | `https://consumer.xtime.com/` |
| `CAPSOLVER_API_KEY` | CapSolver API key (if `RECAPTCHA_MODE=capsolver`) |

---

## Supabase Schema

```sql
-- Run supabase/migrations/0001_init.sql in Supabase SQL editor
-- Creates: dealers, appointments tables
-- Seed: insert one row into dealers with xtime_dealer_id
```

---

## Retell Agent Setup

1. Go to [app.retellai.com](https://app.retellai.com) → **Create Agent → Single Prompt**
2. Paste `retell/agent-prompt.md` (lines after the `---`) into the System Prompt
3. **Functions → Add Function** → paste `retell/schedule-xtime.tool.json`
4. Tool URL: `https://autoace-pink.vercel.app/api/schedule-xtime`
5. Click **Run Test** and say: *"Hi, I need an oil change for my 2023 Subaru Ascent"*

---

## Production Deployment

Already deployed to Vercel:

**`https://autoace-pink.vercel.app`**

To redeploy after changes:
```powershell
vercel --prod --yes
```

To update a single env var:
```powershell
echo "new-value" | vercel env add XTIME_TOKEN_ID production --force
vercel --prod --yes
```

---

## API Response Contract

**Success:**
```jsonc
{
  "success": true,
  "message": "Great news — your oil change is confirmed at McGovern Subaru of Acton for Friday, June 13 at 9:00 AM. Your confirmation number is 842156.",
  "appointment": {
    "confirmation_number": "842156",
    "appointment_id": 987654,
    "start_time": "2026-06-13T09:00:00.000Z",
    "service_code": "1",
    "service_description": "Replace engine oil and filter",
    "is_new_customer": false
  }
}
```

**Failure:**
```jsonc
{
  "success": false,
  "error_code": "NO_AVAILABILITY",
  "message": "Sorry, I don't have an opening for June 13 at 9:00 AM. Would you like me to check a different time?"
}
```

Error codes: `BAD_REQUEST | DEALER_NOT_FOUND | NO_AVAILABILITY | XTIME_AVAILABILITY_FAILED | XTIME_BOOKING_FAILED | INTERNAL_ERROR`

---

## Other Known Limitations

- **`tokenId` rotation:** Xtime session tokens expire after ~hours. Refresh by opening `consumer.xtime.com` in DevTools, capturing a new `tokenId` from any `xws/rest` request, and updating `XTIME_TOKEN_ID` in Vercel env + redeploying.
- **reCAPTCHA on Vercel:** Playwright (headless browser) cannot run on Vercel's serverless runtime. Production uses CapSolver. Locally, Playwright is available for higher-quality tokens.
- **`IM_NEW_HERE` flow:** Some Xtime dealer configurations require customers to pre-exist in the DMS before online self-scheduling is permitted. If the lookup returns empty, the new-customer booking path may be blocked at the Xtime level.
- **Retell webhook verification:** `RETELL_WEBHOOK_SECRET` is reserved but not yet enforced. Add an HMAC header check before going to production.
