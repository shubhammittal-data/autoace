/**
 * POST /api/test-xtime-readonly
 * ─────────────────────────────
 * SAFE TEST ENDPOINT — runs only the read-only Xtime calls:
 *
 *   1) lookupCustomerVehicles  (GET, read-only — looks up customer by email)
 *   2) checkAvailability       (POST, read-only — queries open slots)
 *
 * Does NOT call bookAppointment, so nothing gets created in the dealer's
 * Xtime tenant. Use this to verify:
 *   - .env.local credentials are loaded
 *   - XTIME_TOKEN_ID is still valid
 *   - CapSolver reCAPTCHA solver works
 *   - Network path to x10con.xtime.com is reachable
 *
 * Example:
 *   curl -X POST http://localhost:3000/api/test-xtime-readonly \
 *     -H "Content-Type: application/json" \
 *     -d '{"email":"rockhopperpenguin5257@emailhub.kr","appointment_date":"2026-06-02"}'
 */

import { NextResponse } from 'next/server';

import {
  checkAvailability,
  getXtimeAuth,
  lookupCustomerVehicles,
  XtimeError,
} from '@/lib/xtime/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface TestRequestBody {
  email?: string;
  phone?: string;
  appointment_date?: string; // yyyy-MM-dd
  dealer_id?: string;
  // Vehicle + service overrides for the availability call.
  // Defaults below mirror the captured 2026-05-27 payload (Subaru BRZ, oil change).
  make?: string;
  model?: string;
  meta_vehicle_id?: string;
  service_id?: number;
  service_name?: string;
  transportation_option?: string;
}

export async function POST(req: Request) {
  const startedAt = Date.now();
  const results: Record<string, unknown> = {};

  let body: TestRequestBody = {};
  try {
    body = (await req.json()) as TestRequestBody;
  } catch {
    return NextResponse.json(
      { success: false, error: 'Body must be valid JSON' },
      { status: 400 },
    );
  }

  const {
    email,
    phone,
    appointment_date,
    dealer_id = process.env.XTIME_DEALER_ID,
    make = 'SUBARU',
    model = 'BRZ',
    meta_vehicle_id = '77000745527',
    service_id = 14157753,
    service_name = 'Replace engine oil and filter',
    transportation_option = 'WAITER',
  } = body;

  if (!email && !phone) {
    return NextResponse.json(
      { success: false, error: 'Provide at least `email` or `phone`' },
      { status: 400 },
    );
  }

  if (!dealer_id) {
    return NextResponse.json(
      { success: false, error: 'XTIME_DEALER_ID missing in env and no dealer_id in body' },
      { status: 400 },
    );
  }

  // ── 0) Load auth bag and report what was loaded ──────────────────────────
  const auth = getXtimeAuth();
  results.auth_loaded = {
    base_url: auth.baseUrl,
    consumer_origin: auth.consumerOrigin,
    token_id_present: Boolean(auth.tokenId),
    token_id_preview: auth.tokenId ? `${auth.tokenId.slice(0, 4)}…` : null,
    country_code: auth.countryCode,
    recaptcha_mode: process.env.RECAPTCHA_MODE ?? '(unset)',
    recaptcha_site_key_present: Boolean(process.env.RECAPTCHA_SITE_KEY),
    capsolver_key_present: Boolean(process.env.CAPSOLVER_API_KEY),
    dealer_id,
  };

  // ── 1) Lookup ────────────────────────────────────────────────────────────
  try {
    console.info('[test-readonly] Step 1: lookupCustomerVehicles', { email, phone });
    const t0 = Date.now();
    const lookup = await lookupCustomerVehicles({
      auth,
      dealerId: dealer_id,
      email,
      phone,
    });
    results.step1_lookup = {
      ok: true,
      ms: Date.now() - t0,
      customer_count: Array.isArray(lookup?.customers) ? lookup.customers.length : 0,
      vehicle_count: Array.isArray(lookup?.vehicles) ? lookup.vehicles.length : 0,
      xid_cookie_captured: Boolean(auth.xidCookie),
      raw: lookup,
    };
  } catch (err) {
    results.step1_lookup = formatErr(err);
    return NextResponse.json(
      { success: false, ms: Date.now() - startedAt, results },
      { status: 502 },
    );
  }

  // ── 2) Availability (optional, only if appointment_date provided) ────────
  if (appointment_date) {
    try {
      console.info('[test-readonly] Step 2: checkAvailability', {
        appointment_date,
        make,
        model,
        service_name,
      });
      const t0 = Date.now();
      const avail = await checkAvailability({
        auth,
        body: {
          dealerId: dealer_id,
          tokenId: auth.tokenId,
          selectedDate: appointment_date,
          make,
          model,
          metaVehicleId: meta_vehicle_id,
          services: [
            {
              id: service_id,
              shopDuration: 24,
              dmsOpcode: '1',
              name: service_name,
              price: 106.12,
            },
          ],
          transportationOption: transportation_option,
        },
      });

      const days = avail?.availableTimes?.Days ?? [];
      const matchedDay = days.find((d) => d.calendarDate === appointment_date);
      const totalSlots = days.reduce(
        (acc, d) => acc + (d.timeslots?.length ?? 0),
        0,
      );

      results.step2_availability = {
        ok: true,
        ms: Date.now() - t0,
        api_success: avail?.success,
        api_status_code: avail?.statusCode,
        days_returned: days.length,
        total_slots_across_window: totalSlots,
        slots_on_requested_date: matchedDay?.timeslots?.map((t) => t.time) ?? [],
        first_3_days_summary: days.slice(0, 3).map((d) => ({
          date: d.calendarDate,
          isOpen: d.isOpen,
          slotCount: d.timeslots?.length ?? 0,
        })),
      };
    } catch (err) {
      results.step2_availability = formatErr(err);
    }
  } else {
    results.step2_availability = {
      skipped: 'No `appointment_date` provided in body (yyyy-MM-dd).',
    };
  }

  return NextResponse.json({
    success: true,
    ms: Date.now() - startedAt,
    results,
  });
}

function formatErr(err: unknown) {
  if (err instanceof XtimeError) {
    return {
      ok: false,
      kind: 'XtimeError',
      step: err.step,
      status: err.status,
      message: err.message,
      body_preview: err.body?.slice(0, 500),
    };
  }
  if (err instanceof Error) {
    return { ok: false, kind: err.name, message: err.message };
  }
  return { ok: false, kind: 'unknown', message: String(err) };
}
