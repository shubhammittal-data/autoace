/**
 * POST /api/schedule-xtime
 * ────────────────────────
 * Middleware orchestration engine called by Retell AI's "Custom Function" tool
 * during a live phone call. Drives the reverse-engineered Xtime REST API
 * through the full confirmed flow:
 *
 *   A) Lookup customer + vehicle by email/phone        → customerVehicles GET
 *   B) Fork: existing user vs. new user (build profile)
 *   C) Get metaVehicleId via trim lookup               → trim GET
 *   D) Get service catalog + build servicePoint        → maintenance POST
 *   E) Get advisors + transport options                → apptOptions POST
 *   F) Check slot availability                         → getFirstAvailability POST
 *   G) Confirm the appointment ("the god request")     → confirm POST
 *
 * The handler returns a JSON response shaped for Retell's voice agent: a
 * machine-readable `success` flag + a one-sentence `message` the agent reads
 * back to the caller.
 *
 * IMPORTANT: this file is intentionally pure server code. Do not import it
 * from a Client Component.
 */

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { getSupabaseAdmin } from '@/lib/supabase';
import type { Database } from '@/lib/database.types';
import {
  bookAppointment,
  checkAvailability,
  getApptOptions,
  getMaintenanceServices,
  getRecommendedServices,
  getMetaVehicleDetails,
  getVehicleTrim,
  getXtimeAuth,
  lookupCustomerVehicles,
  warmSession,
  XtimeError,
  type XtimeAuth,
} from '@/lib/xtime/client';
import { resolveServiceCode } from '@/lib/xtime/serviceCodes';
import type { XtimeCustomer, XtimeVehicle } from '@/lib/xtime/types';
import {
  coerceIsoDateTime,
  humanizeServiceName,
  parseRetellRequest,
  speakableDate,
  type RetellArgs,
} from '@/lib/retell';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ─── Types local to the handler ──────────────────────────────────────────────

type DealerRow = Database['public']['Tables']['dealers']['Row'];

interface OrchestrationContext {
  retell: RetellArgs;
  callId?: string;
  dealer: DealerRow;
  auth: XtimeAuth;
  service: { code: string; description: string };
  appointmentIso: string;
  supabase: SupabaseClient<Database>;
}

interface SuccessResponse {
  success: true;
  message: string;
  appointment: {
    confirmation_number?: string;
    appointment_id?: string | number;
    start_time: string;
    service_code: string;
    service_description: string;
    is_new_customer: boolean;
  };
}

interface FailureResponse {
  success: false;
  message: string;
  error_code:
    | 'BAD_REQUEST'
    | 'DEALER_NOT_FOUND'
    | 'XTIME_LOOKUP_FAILED'
    | 'NO_AVAILABILITY'
    | 'XTIME_AVAILABILITY_FAILED'
    | 'XTIME_BOOKING_FAILED'
    | 'INTERNAL_ERROR';
  details?: unknown;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function POST(req: Request): Promise<NextResponse<SuccessResponse | FailureResponse>> {
  const startedAt = Date.now();
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonFail('BAD_REQUEST', 'Request body must be valid JSON', 400);
  }

  // 0) Validate Retell payload ---------------------------------------------
  let retell: RetellArgs;
  let callId: string | undefined;
  try {
    const parsed = parseRetellRequest(raw);
    retell = parsed.args;
    callId = parsed.callId;
  } catch (err) {
    return jsonFail('BAD_REQUEST', errMsg(err), 400);
  }

  const supabase = getSupabaseAdmin();

  // 1) Look up the dealer in Supabase --------------------------------------
  const dealer = await loadDealer(supabase, retell.dealer_slug);
  if (!dealer) {
    return jsonFail(
      'DEALER_NOT_FOUND',
      "I'm sorry, I couldn't find that dealership in our system.",
      404,
    );
  }

  // 2) Build orchestration context ------------------------------------------
  const auth = getXtimeAuth();
  if (!auth.tokenId) {
    return jsonFail(
      'INTERNAL_ERROR',
      "I'm not able to reach the scheduling system right now. Please try again in a few minutes.",
      503,
      'XTIME_TOKEN_ID is missing from environment. Capture a fresh tokenId from consumer.xtime.com and set it in .env.local.',
    );
  }

  // Pre-mint 3 reCAPTCHA tokens in a single browser session:
  //   [0] settings preflight (warms XID)
  //   [1] customerVehicles lookup
  //   [2] /appointment/confirm booking
  const tokenPool = await auth.recaptcha.mintTokens(3);
  auth.tokenPool = tokenPool;

  const ctx: OrchestrationContext = {
    retell,
    callId,
    dealer,
    auth,
    service: resolveServiceCode(retell.service_requested),
    appointmentIso: coerceIsoDateTime(retell.appointment_time, dealer.timezone),
    supabase,
  };

  // Persist a `pending` row up-front so we have a paper trail even on failure.
  const auditId = await insertPendingAudit(ctx);

  try {
    // ── Step 0: warm session via /settings (sets XID cookie) ──────────────
    await warmSession({ auth, dealerId: dealer.xtime_dealer_id });

    // ── Step A: customer/vehicle lookup ────────────────────────────────────
    const lookup = await lookupOrThrow(ctx);

    // ── Step B: fork ───────────────────────────────────────────────────────
    const { customer, vehicle, isNewCustomer } = forkCustomer(ctx, lookup);

    // ── Step C: resolve metaVehicleId + engine details via trim lookup ─────
    const meta = await resolveMetaVehicle(ctx, vehicle);

    // ── Step D: fetch service catalog + pick matching service ─────────────
    const serviceInfo = await resolveServicePoint(ctx, vehicle, meta);
    const friendlyService = humanizeServiceName(serviceInfo.serviceName);

    // ── Step E: check slot availability ───────────────────────────────────
    await ensureSlotAvailable(ctx, vehicle, meta, serviceInfo);

    const speakable = speakableDate(ctx.appointmentIso, dealer.timezone);

    // ── Dry-run short-circuit: confirm slot is available but don't book.
    if (retell.dry_run) {
      await ctx.supabase
        .from('appointments')
        .update({ status: 'pending' })
        .eq('id', auditId);

      return NextResponse.json<SuccessResponse>({
        success: true,
        message: `I have a ${friendlyService.toLowerCase()} opening at ${dealer.name} for ${speakable}. Would you like me to book it?`,
        appointment: {
          confirmation_number: undefined,
          appointment_id: undefined,
          start_time: ctx.appointmentIso,
          service_code: ctx.service.code,
          service_description: friendlyService,
          is_new_customer: isNewCustomer,
        },
      });
    }

    // ── Step F: confirm booking ────────────────────────────────────────────
    const booking = await placeBooking(ctx, customer, vehicle, meta, serviceInfo);

    // Mark audit row confirmed.
    await ctx.supabase
      .from('appointments')
      .update({
        status: 'confirmed',
        xtime_appointment_id: booking.reservationId
          ? String(booking.reservationId)
          : null,
      })
      .eq('id', auditId);

    const message = `Great news — your ${friendlyService.toLowerCase()} is confirmed at ${dealer.name} for ${speakable}.${
      booking.confirmationKey ? ` Your confirmation number is ${booking.confirmationKey}.` : ''
    }`;

    return NextResponse.json<SuccessResponse>({
      success: true,
      message,
      appointment: {
        confirmation_number: booking.confirmationKey,
        appointment_id: booking.reservationId,
        start_time: ctx.appointmentIso,
        service_code: ctx.service.code,
        service_description: friendlyService,
        is_new_customer: isNewCustomer,
      },
    });
  } catch (err) {
    await ctx.supabase
      .from('appointments')
      .update({ status: 'failed' })
      .eq('id', auditId);

    return mapErrorToResponse(err, ctx);
  } finally {
    console.info('[schedule-xtime]', {
      callId,
      dealer: dealer.slug,
      service: ctx.service.code,
      ms: Date.now() - startedAt,
    });
  }
}

// ─── Step helpers ────────────────────────────────────────────────────────────

async function loadDealer(
  supabase: SupabaseClient<Database>,
  slug: string | undefined,
): Promise<DealerRow | null> {
  const query = supabase.from('dealers').select('*').limit(1);
  const { data, error } = slug
    ? await query.eq('slug', slug).maybeSingle()
    : await query.maybeSingle();

  if (error) {
    console.error('[schedule-xtime] dealer lookup error', error);
    return null;
  }
  return (data as DealerRow | null) ?? null;
}

async function insertPendingAudit(ctx: OrchestrationContext): Promise<string> {
  const { retell, dealer, callId, service, appointmentIso, supabase } = ctx;
  const { data, error } = await supabase
    .from('appointments')
    .insert({
      dealer_id: dealer.id,
      retell_call_id: callId ?? null,
      customer_phone: retell.customer_phone ?? null,
      customer_email: retell.customer_email ?? null,
      customer_first_name: retell.customer_first_name ?? null,
      customer_last_name: retell.customer_last_name ?? null,
      vehicle_year: retell.vehicle_year ?? null,
      vehicle_make: retell.vehicle_make ?? null,
      vehicle_model: retell.vehicle_model ?? null,
      service_requested: retell.service_requested,
      service_code: service.code,
      appointment_time: appointmentIso,
      status: 'pending',
      raw_payload: retell as unknown as Database['public']['Tables']['appointments']['Insert']['raw_payload'],
    })
    .select('id')
    .single();

  if (error || !data) {
    // Audit failure should not block the booking; surface a stub UUID.
    console.error('[schedule-xtime] audit insert failed', error);
    return '00000000-0000-0000-0000-000000000000';
  }
  return data.id;
}

/** Step A wrapper: bubble up rich error if Xtime lookup fails. */
async function lookupOrThrow(ctx: OrchestrationContext) {
  try {
    // Prefer email-only lookup when we have an email. Xtime's
    // /customerVehicles endpoint appears to AND-match email+phone when both
    // are supplied, so passing a randomly-generated phone (Retell may not
    // know the caller's real number) hides legitimate email matches.
    const useEmailOnly = Boolean(ctx.retell.customer_email);
    const lookup = await lookupCustomerVehicles({
      auth: ctx.auth,
      dealerId: ctx.dealer.xtime_dealer_id,
      email: ctx.retell.customer_email,
      phone: useEmailOnly ? undefined : ctx.retell.customer_phone,
    });

    // Xtime returns HTTP 200 with {statusCode:1,success:false} when it rejects
    // the reCAPTCHA on the lookup call. Treat this as an empty result so we
    // can still proceed with IM_NEW_HERE booking flow.
    const xtimeFailed = (lookup as unknown as { success?: boolean })?.success === false;
    if (xtimeFailed) {
      console.warn('[schedule-xtime] lookup returned success:false — treating as new customer');
      return { customers: [], vehicles: [] } as Awaited<ReturnType<typeof lookupCustomerVehicles>>;
    }

    console.info('[schedule-xtime] customer lookup result', {
      lookupKey: useEmailOnly ? 'email' : 'phone',
      customerCount: lookup?.customers?.length ?? 0,
      vehicleCount: lookup?.vehicles?.length ?? 0,
      firstPersonId: lookup?.vehicles?.[0]?.personId,
      firstVehicleId: lookup?.vehicles?.[0]?.vehicleId,
      firstVehicleTrim: lookup?.vehicles?.[0]?.trim,
    });
    return lookup;
  } catch (err) {
    // If the lookup itself throws (network error, non-JSON, etc.) treat as
    // new customer rather than aborting — booking can still proceed.
    console.warn('[schedule-xtime] lookup threw, treating as new customer:', errMsg(err));
    return { customers: [], vehicles: [] } as Awaited<ReturnType<typeof lookupCustomerVehicles>>;
  }
}

/** Step B: parse the lookup response and decide existing vs. new. */
function forkCustomer(
  ctx: OrchestrationContext,
  lookup: Awaited<ReturnType<typeof lookupCustomerVehicles>>,
) {
  // Xtime is inconsistent across tenants: sometimes `customers` + `vehicles`,
  // sometimes a flat array, sometimes nested under `data`. Normalize.
  const customers: XtimeCustomer[] =
    (Array.isArray(lookup) ? lookup : lookup?.customers) ?? [];
  const vehicles: XtimeVehicle[] = lookup?.vehicles ?? [];

  // Pick the best match: prefer a vehicle whose YMM matches the caller's car.
  const wantedYear = ctx.retell.vehicle_year;
  const wantedMake = ctx.retell.vehicle_make?.toLowerCase();
  const wantedModel = ctx.retell.vehicle_model?.toLowerCase();

  const matchedVehicle =
    vehicles.find(
      (v) =>
        (!wantedYear || String(v.year) === String(wantedYear)) &&
        (!wantedMake || v.make?.toLowerCase() === wantedMake) &&
        (!wantedModel || v.model?.toLowerCase() === wantedModel),
    ) ?? vehicles[0];

  // McGovern/Xtime typically omits the top-level `customers[]` array and
  // returns person info embedded on each vehicle (personId, firstname,
  // lastname, email, phoneNumber). Synthesize the customer record from the
  // matched vehicle when that's the case.
  const matchedCustomer: XtimeCustomer | undefined =
    customers.find((c) => c.customerId === matchedVehicle?.customerId) ??
    customers[0] ??
    (matchedVehicle?.personId
      ? {
          customerId: matchedVehicle.personId,
          firstName: matchedVehicle.firstname,
          lastName: matchedVehicle.lastname,
          email: matchedVehicle.email,
          phone: matchedVehicle.phoneNumber,
        }
      : undefined);

  if (matchedCustomer?.customerId && matchedVehicle?.vehicleId) {
    // Existing user path
    console.info('[schedule-xtime] fork=EXISTING', {
      customerId: matchedCustomer.customerId,
      vehicleId: matchedVehicle.vehicleId,
    });
    return {
      customer: matchedCustomer,
      vehicle: matchedVehicle,
      isNewCustomer: false,
    };
  }

  // New user path — synthesize a profile from the Retell payload. The actual
  // `customerId`/`vehicleId` will be assigned by Xtime when we POST the
  // appointment; we just leave them undefined here.
  console.info('[schedule-xtime] fork=NEW', {
    email: ctx.retell.customer_email,
    phone: ctx.retell.customer_phone,
    ymm: `${ctx.retell.vehicle_year} ${ctx.retell.vehicle_make} ${ctx.retell.vehicle_model}`,
  });

  const newCustomer: XtimeCustomer = {
    firstName: ctx.retell.customer_first_name,
    lastName: ctx.retell.customer_last_name,
    email: ctx.retell.customer_email,
    phone: ctx.retell.customer_phone,
  };
  const newVehicle: XtimeVehicle = {
    year: ctx.retell.vehicle_year,
    make: ctx.retell.vehicle_make,
    model: ctx.retell.vehicle_model,
    vin: ctx.retell.vehicle_vin,
    mileage: ctx.retell.vehicle_mileage,
  };
  return { customer: newCustomer, vehicle: newVehicle, isNewCustomer: true };
}

/**
 * Step C.1: Get metaVehicleId from Xtime's trim endpoint.
 * Returns the metaVehicleId and engine details needed for subsequent calls.
 */
async function resolveMetaVehicle(
  ctx: OrchestrationContext,
  vehicle: XtimeVehicle,
): Promise<{
  metaVehicleId: string;
  engineType: string;
  engineSize: string;
  driveType: string;
  transmission: string;
  trim: string;
}> {
  const make = (vehicle.make ?? ctx.retell.vehicle_make ?? 'SUBARU').toUpperCase();
  const model = (vehicle.model ?? ctx.retell.vehicle_model ?? '').toUpperCase();
  const year = String(vehicle.year ?? ctx.retell.vehicle_year ?? new Date().getFullYear());

  // Fast path: the customerVehicles lookup already returns metaVehicleId,
  // trim, engine details for existing vehicles. Use them directly to skip
  // the noisy /trim + /metavehicle/details round-trips (which often return
  // trim=UNKNOWN and break the /recommended packages lookup).
  if (vehicle.metaVehicleId && vehicle.trim) {
    const resolved = {
      metaVehicleId: String(vehicle.metaVehicleId),
      engineType: vehicle.engineType ?? '',
      engineSize: vehicle.engineSize ?? '',
      driveType: vehicle.driveType ?? '',
      transmission: vehicle.transmissionType ?? '',
      trim: vehicle.trim,
    };
    console.info('[schedule-xtime] resolved meta vehicle (from lookup)', resolved);
    return resolved;
  }

  try {
    const trimResp = await getVehicleTrim({
      auth: ctx.auth,
      dealerId: ctx.dealer.xtime_dealer_id,
      make,
      model,
      year,
    });

    const info = trimResp.vehicleInfo;
    const transmissions = info?.transmissions ?? [];
    console.info('[schedule-xtime] trim response FULL', JSON.stringify(
      transmissions.map((tx) => ({
        tx: tx.value,
        driveTypes: (tx.driveTypes ?? []).map((dt) => ({
          dt: dt.value,
          trims: (dt.trims ?? []).map((tr) => ({
            trim: tr.value,
            engines: (tr.engineTypes ?? []).map((et) => ({
              et: et.value,
              sizes: (et.engineSizes ?? []).map((es) => es.value),
            })),
          })),
        })),
      }))
    ));

    // Find a real (non-UNKNOWN) trim. Xtime's /recommended endpoint filters
    // packages by trim and returns an empty list when trim=UNKNOWN, so
    // searching for the first concrete trim is essential.
    let firstTransmission = transmissions[0];
    let firstDriveType = firstTransmission?.driveTypes?.[0];
    let firstTrim = firstDriveType?.trims?.[0];
    outer: for (const tx of transmissions) {
      for (const dt of tx.driveTypes ?? []) {
        for (const tr of dt.trims ?? []) {
          if (tr.value && tr.value.toUpperCase() !== 'UNKNOWN') {
            firstTransmission = tx;
            firstDriveType = dt;
            firstTrim = tr;
            break outer;
          }
        }
      }
    }
    const firstEngineType = firstTrim?.engineTypes?.[0];
    const firstEngineSize = firstEngineType?.engineSizes?.[0];

    const engineType = firstEngineType?.value ?? '';
    const engineSize = firstEngineSize?.value ?? '';
    const driveType = firstDriveType?.value ?? '';
    const transmission = firstTransmission?.value ?? '';
    const rawTrim = firstTrim?.value ?? '';
    // If Xtime returns no named trim, substitute the model string (e.g. "ASCENT").
    // Sending trim="UNKNOWN" causes Xtime /confirm to return HTTP 500.
    const trim = rawTrim && rawTrim.toUpperCase() !== 'UNKNOWN' ? rawTrim : model;

    // Step C.1b: resolve the internal metaVehicleId via /metavehicle/details.
    // The /trim endpoint doesn't return metaVehicleId — this is the call that does.
    let metaVehicleId = '';
    try {
      const details = await getMetaVehicleDetails({
        auth: ctx.auth,
        dealerId: ctx.dealer.xtime_dealer_id,
        make,
        model,
        year,
        trim,
        engineType,
        engineSize,
        driveType,
        transmissionType: transmission,
      });
      metaVehicleId = String(details.data?.id ?? '');
    } catch (err) {
      console.warn('[schedule-xtime] metavehicle details failed', err);
    }

    // Last-resort fallback for testing.
    if (!metaVehicleId) {
      metaVehicleId = process.env.XTIME_DEFAULT_META_VEHICLE_ID ?? '';
    }

    const resolved = {
      metaVehicleId,
      engineType,
      engineSize,
      driveType,
      transmission,
      trim,
    };
    console.info('[schedule-xtime] resolved meta vehicle', resolved);
    return resolved;
  } catch (err) {
    console.warn('[schedule-xtime] trim lookup failed, using defaults', err);
    const make = (vehicle.make ?? ctx.retell.vehicle_make ?? 'SUBARU').toUpperCase();
    const model = (vehicle.model ?? ctx.retell.vehicle_model ?? make).toUpperCase();
    return {
      metaVehicleId: process.env.XTIME_DEFAULT_META_VEHICLE_ID ?? '',
      engineType: '',
      engineSize: '',
      driveType: '',
      transmission: '',
      trim: model,
    };
  }
}

/**
 * Step C.2: Fetch maintenance services and find the best match for the
 * requested service. Returns the matched service so it can be sent in the
 * `services` array (NOT wrapped as a servicePoint package — Xtime returns
 * 0 slots if we send a malformed package wrapper).
 */
async function resolveServicePoint(
  ctx: OrchestrationContext,
  vehicle: XtimeVehicle,
  meta: Awaited<ReturnType<typeof resolveMetaVehicle>>,
): Promise<{
  servicePointJson: string;
  servicesJson: string;
  serviceId: number;
  serviceName: string;
  serviceObject: {
    id: number;
    name: string;
    shopDuration: number;
    dmsOpcode: string;
    price: number;
    waiterAllowed: number;
    loanerAllowed: number;
    selectable: number;
    showPrice: number;
  } | null;
}> {
  const make = (vehicle.make ?? ctx.retell.vehicle_make ?? 'SUBARU').toUpperCase();
  const model = (vehicle.model ?? ctx.retell.vehicle_model ?? '').toUpperCase();
  const year = String(vehicle.year ?? ctx.retell.vehicle_year ?? new Date().getFullYear());
  const mileageNum = vehicle.mileage ?? ctx.retell.vehicle_mileage ?? 0;
  const mileageStr = mileageNum > 0 ? String(mileageNum) : '';
  const regDate = `${year}-01-01`;

  try {
    // Use the recommended endpoint — same one the browser uses. It returns
    // full menu packages ("Dealer Menu 3") that Xtime's /confirm expects.
    const recResp = await getRecommendedServices({
      auth: ctx.auth,
      dealerId: ctx.dealer.xtime_dealer_id,
      make,
      model,
      year,
      regDate,
      engineType: meta.engineType,
      engineSize: meta.engineSize,
      driveType: meta.driveType,
      trim: meta.trim,
      transmissionType: meta.transmission,
      mileage: mileageStr,
    });

    // The recommended endpoint returns packages[], each with services[].
    // Pick the package whose first service's dmsOpcode matches, or the first package.
    let packages = recResp.packages ?? (recResp.services ? [{ services: recResp.services, name: 'Service', id: 0, dmsOpcode: '', price: 0, shopDuration: 0 }] : []);

    // If /recommended returned nothing (some vehicles have no mileage packages),
    // fall back to the /unscheduledservices/maintenance endpoint which returns
    // individual a-la-carte services instead of bundled menus.
    let isAlacarte = false;
    if (packages.length === 0) {
      console.info('[schedule-xtime] no recommended packages, falling back to maintenance services');
      isAlacarte = true;
      const maintResp = await getMaintenanceServices({
        auth: ctx.auth,
        dealerId: ctx.dealer.xtime_dealer_id,
        make,
        model,
        year,
        metaVehicleId: meta.metaVehicleId,
        engineType: meta.engineType,
        engineSize: meta.engineSize,
        driveType: meta.driveType,
        transmission: meta.transmission,
        trim: meta.trim,
        mileage: mileageStr,
      });
      const maintServices = maintResp.services ?? [];
      if (maintServices.length > 0) {
        packages = [{
          services: maintServices,
          name: 'Maintenance Services',
          id: 0,
          dmsOpcode: '',
          price: 0,
          shopDuration: 0,
          alacarte: 1,
        }];
      }
    }
    const serviceText = ctx.retell.service_requested.toLowerCase();

    // Match package: prefer dmsOpcode match on any sub-service, else phrase match, else first
    let matchedPkg = packages.find((pkg) =>
      pkg.services?.some((s) => s.dmsOpcode === ctx.service.code),
    ) ?? packages.find((pkg) =>
      pkg.name?.toLowerCase().includes(serviceText) ||
      pkg.services?.some((s) => s.name?.toLowerCase().includes(serviceText)),
    ) ?? packages[0];

    // Representative sub-service for serviceObject (used in availability check)
    const subService = matchedPkg?.services?.find((s) => s.dmsOpcode === ctx.service.code)
      ?? matchedPkg?.services?.[0];

    console.info('[schedule-xtime] service catalog', {
      totalPackages: packages.length,
      requested: serviceText,
      matchedPkg: matchedPkg ? { id: matchedPkg.id, name: matchedPkg.name, dmsOpcode: matchedPkg.dmsOpcode } : null,
      subService: subService ? { id: subService.id, name: subService.name, dmsOpcode: subService.dmsOpcode } : null,
    });

    if (!matchedPkg || !subService) {
      return {
        servicePointJson: '{}',
        servicesJson: '[]',
        serviceId: 0,
        serviceName: ctx.service.description,
        serviceObject: null,
      };
    }

    const serviceObject = {
      id: subService.id,
      name: subService.name,
      shopDuration: subService.shopDuration ?? 0,
      dmsOpcode: subService.dmsOpcode ?? '',
      price: subService.price ?? 0,
      waiterAllowed: 1,
      loanerAllowed: 0,
      selectable: 0,
      showPrice: 0,
    };

    // A-la-carte path (no real package from /recommended):
    // Send servicePoint='{}' and the single matched service in services[].
    // This is the shape Xtime accepts for individual services.
    if (isAlacarte) {
      // Browser's working payload only sends these 5 fields per service —
      // sending extras (waiterAllowed, loanerAllowed, selectable, showPrice)
      // appears to confuse Xtime's /confirm endpoint.
      const minimalService = {
        id: subService.id,
        shopDuration: subService.shopDuration ?? 24,
        dmsOpcode: subService.dmsOpcode ?? '',
        name: subService.name,
        price: subService.price ?? 0,
      };
      return {
        servicePointJson: '{}',
        servicesJson: JSON.stringify([minimalService]),
        serviceId: subService.id,
        serviceName: subService.name,
        serviceObject,
      };
    }

    // Package path: build the full menu object exactly as the browser sends it.
    // The browser: alacarte=0, position=1, actual mileage, full services array.
    const pkgServices = (matchedPkg.services ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      waiterAllowed: s.waiterAllowed ?? 1,
      loanerAllowed: s.loanerAllowed ?? 0,
      selectable: s.selectable ?? 0,
      showPrice: s.showPrice ?? 0,
      price: s.price ?? 0,
      shopDuration: s.shopDuration ?? 0,
      dmsOpcode: s.dmsOpcode ?? '',
    }));

    const servicePointMenu = {
      menuType: {
        services: pkgServices,
        shopDuration: matchedPkg.shopDuration ?? 0,
        name: matchedPkg.name,
        description: matchedPkg.description ?? matchedPkg.name,
        alacarte: 0,
        duration: 0,
        dmsOpcode: matchedPkg.dmsOpcode ?? '',
        selectAll: 0,
        totalPrice: matchedPkg.totalPrice ?? matchedPkg.price ?? 0,
        price: matchedPkg.totalPrice ?? matchedPkg.price ?? 0,
      },
      mileage: mileageNum,
      months: matchedPkg.months ?? 0,
      units: 'miles',
      position: 1,
    };

    return {
      servicePointJson: JSON.stringify(servicePointMenu),
      servicesJson: '[]',
      serviceId: subService.id,
      serviceName: matchedPkg.name ?? subService.name,
      serviceObject,
    };
  } catch (err) {
    console.warn('[schedule-xtime] service lookup failed', err);
    return {
      servicePointJson: '{}',
      servicesJson: '[]',
      serviceId: 0,
      serviceName: ctx.service.description,
      serviceObject: null,
    };
  }
}

/** Step F: ask Xtime if the requested slot is open. */
async function ensureSlotAvailable(
  ctx: OrchestrationContext,
  vehicle: XtimeVehicle,
  meta: Awaited<ReturnType<typeof resolveMetaVehicle>>,
  serviceInfo: Awaited<ReturnType<typeof resolveServicePoint>>,
) {
  // Extract yyyy-MM-dd in the dealer's timezone (not UTC).
  const tz = ctx.dealer.timezone || 'America/New_York';
  const apptDate = new Date(ctx.appointmentIso);
  const dParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(apptDate);
  const day = `${dParts.find((p) => p.type === 'year')?.value}-${dParts.find((p) => p.type === 'month')?.value}-${dParts.find((p) => p.type === 'day')?.value}`;

  const make = (vehicle.make ?? ctx.retell.vehicle_make ?? 'SUBARU').toUpperCase();
  const model = (vehicle.model ?? ctx.retell.vehicle_model ?? '').toUpperCase();
  const transportation = mapTransportation(ctx.retell.transportation);

  let resp;
  try {
    resp = await checkAvailability({
      auth: ctx.auth,
      body: {
        dealerId: ctx.dealer.xtime_dealer_id,
        tokenId: ctx.auth.tokenId,
        selectedDate: day,
        make,
        model,
        metaVehicleId: meta.metaVehicleId,
        servicePoint: '{}',
        services: serviceInfo.serviceObject ? [serviceInfo.serviceObject] : [],
        transportationOption: transportation,
        vehicleId: vehicle.vehicleId ? String(vehicle.vehicleId) : '',
        view: 'BIWEEKLY',
        whoami: 'CP8',
      },
    });
  } catch (err) {
    if (err instanceof XtimeError) {
      throw new TaggedError('XTIME_AVAILABILITY_FAILED', err.message, err);
    }
    throw err;
  }

  const days = resp?.availableTimes?.Days ?? [];
  console.info('[schedule-xtime] availability response', {
    requested_day: day,
    days_returned: days.length,
    first_3_days: days.slice(0, 3).map((d) => ({
      date: d.calendarDate,
      isOpen: d.isOpen,
      slotCount: d.timeslots?.length ?? 0,
    })),
  });

  // Find the requested day
  const matchedDay = days.find((d) => d.calendarDate === day);
  if (!matchedDay?.timeslots?.length) {
    const speakable = speakableDate(ctx.appointmentIso, tz);
    throw new TaggedError(
      'NO_AVAILABILITY',
      `Sorry, I don't have an opening for ${speakable}. Would you like me to find the next available time?`,
    );
  }

  // Extract requested HH:mm in dealer tz to compare against slot times.
  const tParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(apptDate);
  const requestedHour = Number(tParts.find((p) => p.type === 'hour')?.value ?? '0');
  const requestedMin = Number(tParts.find((p) => p.type === 'minute')?.value ?? '0');

  const slots = matchedDay.timeslots;
  const hit =
    slots.find((s) => {
      const [h, m] = s.time.split(':').map(Number);
      return h === requestedHour && m === requestedMin;
    }) ?? slots[0];

  // Reconstruct ISO from the confirmed slot in the dealer's timezone.
  // We snap minutes/hours but keep the same yyyy-MM-dd.
  ctx.appointmentIso = isoInTimezone(day, hit.time, tz);
}

/** Step G: the booking POST to /dealer/{id}/appointment/confirm. */
async function placeBooking(
  ctx: OrchestrationContext,
  customer: XtimeCustomer,
  vehicle: XtimeVehicle,
  meta: Awaited<ReturnType<typeof resolveMetaVehicle>>,
  serviceInfo: Awaited<ReturnType<typeof resolveServicePoint>>,
) {
  const make = (vehicle.make ?? ctx.retell.vehicle_make ?? 'SUBARU').toUpperCase();
  const model = (vehicle.model ?? ctx.retell.vehicle_model ?? '').toUpperCase();
  const year = String(vehicle.year ?? ctx.retell.vehicle_year ?? '');
  const transportation = mapTransportation(ctx.retell.transportation);

  // Format date/time in the dealer's local timezone (not the server's).
  const apptDate = new Date(ctx.appointmentIso);
  const tz = ctx.dealer.timezone || 'America/New_York';

  // MM/dd/yyyy in dealer tz
  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(apptDate);
  const mm = dateParts.find((p) => p.type === 'month')?.value ?? '01';
  const dd = dateParts.find((p) => p.type === 'day')?.value ?? '01';
  const yyyy = dateParts.find((p) => p.type === 'year')?.value ?? '2026';
  const selectedDate = `${mm}/${dd}/${yyyy}`;

  // "hh:mm am" lowercase in dealer tz
  const timeStr = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })
    .format(apptDate)
    .toLowerCase();
  // Intl gives "08:00 am" already, but sometimes "8:00 am" — normalize.
  const [hm, ampm] = timeStr.split(' ');
  const [hh, mn] = hm.split(':');
  const selectedTime = `${hh.padStart(2, '0')}:${mn} ${ampm}`;

  // Build the vehicle JSON object — field order and shape match the
  // captured working browser /confirm payload (2026-05-27):
  //   make, year, model, engineType, engineSize, driveType, transmissionType,
  //   trim, licenseNumber, drivingCondition, mileage:null, vehRegDate.
  // Notably the browser sends `mileage: null` even when the customer has a
  // known mileage, and does NOT include phoneNumber in this nested JSON.
  const vehicleJson = JSON.stringify({
    make,
    year,
    model,
    engineType: meta.engineType,
    engineSize: meta.engineSize,
    driveType: meta.driveType,
    transmissionType: meta.transmission,
    trim: meta.trim,
    licenseNumber: vehicle.vin ?? '',
    drivingCondition: 'Normal',
    mileage: null,
    vehRegDate: `01/01/${year}`,
  });

  // Get fresh reCAPTCHA token for the booking step.
  // IMPORTANT: pass no action so the env default (`RECAPTCHA_ACTION=submit`)
  // is used. Xtime validates the token's `action` claim against what their
  // JS uses on consumer.xtime.com, which is `submit`. Passing a custom
  // action like 'book_appointment' causes Xtime to reject the booking
  // with HTTP 500 even though the token itself is valid.
  const gRecaptchaResponse = await ctx.auth.recaptcha.getToken();

  // Existing customer path: when the lookup step found a matching customer +
  // vehicle pair in Xtime, we MUST send `customerPersonId` (= customer.customerId)
  // and `vehicleId`, set `apptFlow=FIND_ME`, and OMIT firstName/lastName/email
  // — the captured working browser payload does exactly this. Sending name/
  // email alongside a personId causes Xtime's /confirm to return HTTP 500.
  const isExistingCustomer = Boolean(customer.customerId && vehicle.vehicleId);

  const bookingBody: Record<string, string> = {
    dealerId: ctx.dealer.xtime_dealer_id,
    tokenId: ctx.auth.tokenId,
    gRecaptchaResponse,
    advisorId: '',
    apptFlow: isExistingCustomer ? 'FIND_ME' : 'IM_NEW_HERE',
    autoRecallIds: '[]',
    autoRecallServices: '[]',
    callbackRequired: '0',
    channel: '2',
    declinedServices: '[]',
    emailPrivacySetting: '0,X,X,X,X,X,X',
    externalValetProvider: '',
    ignoreConflicts: 'true',
    locale: 'en_US',
    metaVehicleId: String(meta.metaVehicleId),
    mileage: '',
    mobilePhoneNumber: '',
    selectedDate,
    selectedTime,
    servicePoint: serviceInfo.servicePointJson,
    services: serviceInfo.servicesJson,
    textPrivacySetting: '0,X,X,X,X,X,0',
    transportationOption: transportation,
    vehicle: vehicleJson,
    whoami: 'CP8',
  };

  if (isExistingCustomer) {
    bookingBody.customerPersonId = String(customer.customerId);
    bookingBody.vehicleId = String(vehicle.vehicleId);
  } else {
    bookingBody.email = customer.email ?? ctx.retell.customer_email ?? '';
    bookingBody.firstName = customer.firstName ?? ctx.retell.customer_first_name ?? '';
    bookingBody.lastName = customer.lastName ?? ctx.retell.customer_last_name ?? '';
    bookingBody.phoneNumber = '';
  }

  // Log the outbound payload so we can diff it against the captured working
  // browser request. (gRecaptchaResponse is truncated for log readability.)
  console.info('[schedule-xtime] booking payload', {
    ...bookingBody,
    gRecaptchaResponse: `${gRecaptchaResponse.slice(0, 20)}...(${gRecaptchaResponse.length} chars)`,
    vehicle: bookingBody.vehicle.slice(0, 200),
    servicePoint: bookingBody.servicePoint.slice(0, 200),
  });

  try {
    const resp = await bookAppointment({
      auth: ctx.auth,
      body: bookingBody,
    });

    // Xtime returns HTTP 200 even when the booking is rejected. The actual
    // success indicator is in the response body: `success: true` + presence
    // of `confirmationKey`. Throw if either is missing.
    const ok = resp.success === true && Boolean(resp.appointment?.confirmationKey);

    console.info('[schedule-xtime] booking response', {
      ok,
      confirmationKey: resp.appointment?.confirmationKey,
      reservationId: resp.appointment?.reservationId,
      startTime: resp.appointment?.startTime,
      lifecycleState: resp.appointment?.lifecycleState,
      agentName: resp.appointment?.agentName,
      success: resp.success,
      statusCode: resp.statusCode,
      key: resp.key,
      // Dump the rest so we can diagnose unknown error shapes.
      full_response: resp,
    });

    if (!ok) {
      throw new TaggedError(
        'XTIME_BOOKING_FAILED',
        "I was able to find your vehicle, match your service, and confirm there's an opening — but I wasn't able to lock in the appointment due to a security restriction on Xtime's end. Let me transfer you to a human advisor who can complete this for you.",
        { xtimeResponse: resp },
      );
    }

    return {
      confirmationKey: resp.appointment?.confirmationKey,
      reservationId: resp.appointment?.reservationId,
      startTime: resp.appointment?.startTime,
    };
  } catch (err) {
    if (err instanceof XtimeError) {
      throw new TaggedError('XTIME_BOOKING_FAILED', err.message, err);
    }
    throw err;
  }
}

/**
 * Build an ISO timestamp from a yyyy-MM-dd date string + HH:mm:ss time
 * string interpreted in the given timezone. Returns a UTC ISO string.
 *
 * Approach: compute the timezone's UTC offset at that local time by
 * comparing what the host would format vs. what we expect.
 */
function isoInTimezone(day: string, time: string, tz: string): string {
  const [y, mo, d] = day.split('-').map(Number);
  const [h, mi, s] = time.split(':').map(Number);

  // Start with a guess: treat the local time as UTC, then correct.
  const guess = new Date(Date.UTC(y, mo - 1, d, h, mi, s || 0));

  // What does Intl say is the local time in `tz` for this guess?
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(guess);
  const get = (t: string) =>
    Number(parts.find((p) => p.type === t)?.value ?? '0');

  const localUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') === 24 ? 0 : get('hour'),
    get('minute'),
    get('second'),
  );
  // Diff between the guessed UTC and what `tz` thinks "local time" is.
  const offsetMs = guess.getTime() - localUtc;

  return new Date(guess.getTime() + offsetMs).toISOString();
}

/** Maps Retell transport codes → Xtime transport codes. */
function mapTransportation(code: string | undefined): string {
  switch (code) {
    case 'DROPOFF':  return 'DROPOFF';
    case 'LOANER':   return 'LOANER';
    case 'SHUTTLE':  return 'SHUTTLE';
    case 'WAITER':   return 'WAITER';
    case 'CUSTWAIT': return 'WAITER';
    default:         return 'WAITER';
  }
}

// ─── Error plumbing ──────────────────────────────────────────────────────────

class TaggedError extends Error {
  code: FailureResponse['error_code'];
  cause?: unknown;
  constructor(code: FailureResponse['error_code'], message: string, cause?: unknown) {
    super(message);
    this.code = code;
    this.cause = cause;
  }
}

function mapErrorToResponse(
  err: unknown,
  ctx: OrchestrationContext,
): NextResponse<FailureResponse> {
  console.error('[schedule-xtime] failure', err);

  if (err instanceof TaggedError) {
    switch (err.code) {
      case 'NO_AVAILABILITY':
        return jsonFail('NO_AVAILABILITY', err.message, 200);
      case 'XTIME_LOOKUP_FAILED':
        return jsonFail(
          'XTIME_LOOKUP_FAILED',
          "I'm having trouble pulling up your account right now — could we try again in a moment?",
          502,
          err.cause,
        );
      case 'XTIME_AVAILABILITY_FAILED':
        return jsonFail(
          'XTIME_AVAILABILITY_FAILED',
          "I'm having trouble checking the schedule. Let me transfer you to an advisor.",
          502,
          err.cause,
        );
      case 'XTIME_BOOKING_FAILED':
        return jsonFail(
          'XTIME_BOOKING_FAILED',
          "I was able to find your vehicle, match your service, and confirm there's an opening — but I wasn't able to lock in the appointment due to a security restriction on Xtime's end. Let me transfer you to a human advisor who can complete this for you.",
          502,
          err.cause,
        );
    }
  }

  return jsonFail(
    'INTERNAL_ERROR',
    "Something went wrong on our end. Let me transfer you to an advisor.",
    500,
    errMsg(err),
  );

  // unused param kept for future per-dealer messaging
  void ctx;
}

function jsonFail(
  code: FailureResponse['error_code'],
  message: string,
  status: number,
  details?: unknown,
): NextResponse<FailureResponse> {
  return NextResponse.json<FailureResponse>(
    { success: false, message, error_code: code, details },
    { status },
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
