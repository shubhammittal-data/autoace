/**
 * Thin fetch wrapper for the reverse-engineered Xtime endpoints.
 *
 * Real auth model (confirmed from a captured DevTools session, 2026-05-22):
 *
 *   GET https://x10con.xtime.com/xws/rest/vehicles/dealer/{dealerId}/customerVehicles
 *       ?tokenId=<short numeric session token>
 *       &dlrCountryCode=US
 *       &gRecaptchaResponse=<fresh Google reCAPTCHA v3 token, ~5KB, ~2-min TTL>
 *       &email=<lookup key>
 *
 *   Origin:  https://consumer.xtime.com
 *   Referer: https://consumer.xtime.com/
 *
 *   The first response sets `Set-Cookie: XID=<hex>; Path=/consumer; HttpOnly`.
 *   Subsequent calls in the same logical session send `Cookie: XID=<hex>`.
 *
 * `tokenId` lifetime: minutes-to-hours (refresh by reloading the consumer page).
 * `gRecaptchaResponse` lifetime: ~2 minutes — minted fresh per request via the
 *   `RecaptchaProvider` interface (`lib/xtime/recaptcha.ts`).
 */

import type {
  ApptOptionsRequest,
  ApptOptionsResponse,
  AvailabilityRequest,
  AvailabilityResponse,
  BookAppointmentResponse,
  CustomerVehiclesResponse,
  MaintenanceServicesResponse,
  RecommendedServicesResponse,
  RepairServicesResponse,
  VehicleDetailsResponse,
  VehicleModelsResponse,
  VehicleTrimResponse,
  VehicleYearsResponse,
} from './types';
import { getRecaptchaProvider, type RecaptchaProvider } from './recaptcha';

// ─── Auth bag ────────────────────────────────────────────────────────────────

export interface XtimeAuth {
  /** API host, e.g. https://x10con.xtime.com */
  baseUrl: string;
  /** Origin/Referer header value, e.g. https://consumer.xtime.com */
  consumerOrigin: string;
  /** Short numeric session token, e.g. 7778139113 */
  tokenId: string;
  /** Country code Xtime requires, e.g. 'US' */
  countryCode: string;
  /** reCAPTCHA v3 token minter. Called once per outbound request. */
  recaptcha: RecaptchaProvider;
  /**
   * XID cookie. The FIRST call doesn't send one — Xtime sets it via
   * `Set-Cookie` on the response. We capture it and reuse it on follow-ups.
   * Mutated in place by `xtimeFetch` so all downstream calls in the same
   * orchestration share the same session.
   */
  xidCookie?: string;
  /**
   * Pre-minted reCAPTCHA tokens. When populated, `buildAuthedUrl` consumes
   * from this array instead of calling `recaptcha.getToken()`. This allows
   * minting all tokens in a single browser session before any Xtime calls.
   */
  tokenPool?: string[];
}

export function getXtimeAuth(): XtimeAuth {
  return {
    baseUrl: process.env.XTIME_BASE_URL ?? 'https://x10con.xtime.com',
    consumerOrigin:
      process.env.XTIME_CONSUMER_ORIGIN ?? 'https://consumer.xtime.com',
    tokenId: process.env.XTIME_TOKEN_ID ?? '',
    countryCode: process.env.XTIME_COUNTRY_CODE ?? 'US',
    recaptcha: getRecaptchaProvider(),
  };
}

// ─── Header builder ──────────────────────────────────────────────────────────

function buildXtimeHeaders(auth: XtimeAuth): HeadersInit {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Origin: auth.consumerOrigin,
    Referer: `${auth.consumerOrigin}/`,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
  };
  if (auth.xidCookie) {
    headers.Cookie = `XID=${auth.xidCookie}`;
    console.debug(`[xtime] sending XID cookie: ${auth.xidCookie.slice(0, 12)}...`);
  }
  return headers;
}

/** Build a URL with the auth query params Xtime requires on every call. */
async function buildAuthedUrl(
  auth: XtimeAuth,
  path: string,
  action: string,
  extra?: Record<string, string | number | undefined>,
): Promise<string> {
  if (!auth.tokenId) {
    throw new Error('XTIME_TOKEN_ID is empty — capture one from consumer.xtime.com');
  }
  // Always mint with the default action (`submit`) — Xtime/Google validate the
  // recaptcha token's `action` claim against what consumer.xtime.com's JS uses,
  // which is uniformly `submit` for every endpoint. Passing custom labels like
  // `lookup_customer` causes Google to score the token as bot, so Xtime
  // silently returns empty results or a generic HTTP 500.
  void action;
  // Consume pre-minted token from pool if available, otherwise mint fresh.
  const recaptchaToken =
    auth.tokenPool && auth.tokenPool.length > 0
      ? auth.tokenPool.shift()!
      : await auth.recaptcha.getToken();

  const url = new URL(path, auth.baseUrl);
  url.searchParams.set('tokenId', auth.tokenId);
  url.searchParams.set('dlrCountryCode', auth.countryCode);
  url.searchParams.set('gRecaptchaResponse', recaptchaToken);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

// ─── Error type ──────────────────────────────────────────────────────────────

export class XtimeError extends Error {
  status: number;
  body: string;
  step: string;
  constructor(step: string, status: number, body: string, message?: string) {
    super(message ?? `Xtime ${step} failed (${status})`);
    this.name = 'XtimeError';
    this.step = step;
    this.status = status;
    this.body = body;
  }
}

// ─── Fetch core ──────────────────────────────────────────────────────────────

/**
 * Internal fetch helper:
 *   - enforces JSON parse + non-2xx → XtimeError
 *   - captures `Set-Cookie: XID=...` and stashes it on the auth bag for reuse
 *   - retries once on 5xx / network blips (with a fresh reCAPTCHA token if
 *     the URL builder is invoked again)
 */
async function xtimeFetch<T>(
  step: string,
  url: string,
  init: RequestInit,
  auth: XtimeAuth,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { ...init, cache: 'no-store' });

      // Capture XID for downstream calls.
      // Use getSetCookie() (returns string[]) so multiple Set-Cookie headers
      // are not collapsed — some runtimes merge them with commas which breaks
      // the XID=... regex.
      const setCookies: string[] =
        typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === 'function'
          ? (res.headers as { getSetCookie: () => string[] }).getSetCookie()
          : (res.headers.get('set-cookie') ?? '').split(/,(?=\s*\w+=)/)
              .filter(Boolean);
      for (const c of setCookies) {
        const match = /XID=([^;]+)/i.exec(c);
        if (match) {
          auth.xidCookie = match[1];
          break;
        }
      }
      console.debug(`[xtime/${step}] XID=${auth.xidCookie ?? '(none)'}`);

      const text = await res.text();

      // Surface the full raw body for the booking step (and any non-2xx) so we
      // can see Xtime's real error detail — the parsed JSON often hides it.
      if (step === 'book' || step === 'lookup' || !res.ok) {
        console.info(`[xtime/${step}] HTTP ${res.status} raw body:`, text.slice(0, 2000));
      }

      if (!res.ok) {
        if (res.status >= 500 && attempt === 0) {
          lastErr = new XtimeError(step, res.status, text);
          continue;
        }
        throw new XtimeError(step, res.status, text);
      }

      if (!text) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new XtimeError(step, res.status, text, 'Xtime returned non-JSON body');
      }
    } catch (err) {
      lastErr = err;
      if (attempt === 1) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ─── Endpoint wrappers ───────────────────────────────────────────────────────

/**
 * Step A — Customer / Vehicle identification.
 *
 * GET /xws/rest/vehicles/dealer/{dealerId}/customerVehicles
 *     ?tokenId=...&dlrCountryCode=US&gRecaptchaResponse=...&email=...
 */
export async function lookupCustomerVehicles(args: {
  auth: XtimeAuth;
  dealerId: string;
  email?: string;
  phone?: string;
}): Promise<CustomerVehiclesResponse> {
  const { auth, dealerId, email, phone } = args;

  const url = await buildAuthedUrl(
    auth,
    `/xws/rest/vehicles/dealer/${encodeURIComponent(dealerId)}/customerVehicles`,
    'lookup_customer',
    {
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
    },
  );

  return xtimeFetch<CustomerVehiclesResponse>(
    'lookup',
    url,
    { method: 'GET', headers: buildXtimeHeaders(auth) },
    auth,
  );
}

/**
 * Preflight — warms the XID session cookie by calling /settings exactly as
 * the real consumer.xtime.com browser does before /customerVehicles.
 * Without this warm XID the lookup returns {statusCode:1,success:false}.
 */
export async function warmSession(args: {
  auth: XtimeAuth;
  dealerId: string;
}): Promise<void> {
  const { auth, dealerId } = args;
  const url = new URL(
    `/xws/rest/dealer/${encodeURIComponent(dealerId)}/settings`,
    auth.baseUrl,
  );
  url.searchParams.set('tokenId', auth.tokenId);
  url.searchParams.set('dlrCountryCode', auth.countryCode);
  url.searchParams.set('variant', 'CONSUMER');
  try {
    await xtimeFetch<unknown>(
      'settings',
      url.toString(),
      { method: 'GET', headers: buildXtimeHeaders(auth) },
      auth,
    );
    console.info('[xtime/settings] session warmed, XID:', auth.xidCookie?.slice(0, 12));
  } catch (err) {
    // Non-fatal — proceed even if settings call fails
    console.warn('[xtime/settings] preflight failed (non-fatal):', String(err));
  }
}

/**
 * Step C — Availability check.
 *
 * POST /xws/rest/dealer/{dealerId}/appointment/getFirstAvailability
 *
 * Auth: relies on the XID cookie set by the earlier /customerVehicles call.
 * No tokenId / dlrCountryCode / gRecaptchaResponse in the URL — `tokenId`
 * goes in the form body. Content-Type is `application/x-www-form-urlencoded`.
 */
export async function checkAvailability(args: {
  auth: XtimeAuth;
  body: AvailabilityRequest;
}): Promise<AvailabilityResponse> {
  const { auth, body } = args;

  if (!auth.tokenId) {
    throw new Error('XTIME_TOKEN_ID is empty — capture one from consumer.xtime.com');
  }

  const url = new URL(
    `/xws/rest/dealer/${encodeURIComponent(body.dealerId)}/appointment/getFirstAvailability`,
    auth.baseUrl,
  ).toString();

  // Build URL-encoded form body matching the confirmed DevTools capture.
  // Key: servicePoint = JSON-stringified menu object; services = [] (add-ons).
  const form = new URLSearchParams();
  form.set('advisorId', body.advisorId ?? '');
  form.set('autoRecallIds', body.autoRecallIds ?? '[]');
  form.set('declinedServices', body.declinedServices ?? '[]');
  form.set('dropoffAddress', body.dropoffAddress ?? '');
  form.set('locale', body.locale ?? 'en_US');
  form.set('make', body.make);
  form.set('metaVehicleId', String(body.metaVehicleId));
  form.set('model', body.model);
  form.set('pickupAddress', body.pickupAddress ?? '');
  form.set('selectedDate', body.selectedDate);
  form.set('servicePoint', body.servicePoint ?? '{}');
  form.set('services', JSON.stringify(body.services ?? []));
  form.set('tokenId', body.tokenId);
  form.set('transportationOption', body.transportationOption ?? 'WAITER');
  form.set('vehicleId', body.vehicleId ?? '');
  form.set('view', body.view ?? 'BIWEEKLY');
  form.set('vin', body.vin ?? '');
  form.set('whoami', body.whoami ?? 'CP8');

  // Override Content-Type — this endpoint expects form-urlencoded, not JSON.
  const headers = {
    ...(buildXtimeHeaders(auth) as Record<string, string>),
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  return xtimeFetch<AvailabilityResponse>(
    'availability',
    url,
    {
      method: 'POST',
      headers,
      body: form.toString(),
    },
    auth,
  );
}

/**
 * apptOptions — POST /xws/rest/dealers/{dealerId}/apptOptions
 *
 * Fetches available advisors and transport options after service selection.
 * Must be called before getFirstAvailability. Form-urlencoded.
 * servicePoint: JSON-stringified menu object from the recommended endpoint.
 */
export async function getApptOptions(args: {
  auth: XtimeAuth;
  body: ApptOptionsRequest;
}): Promise<ApptOptionsResponse> {
  const { auth, body } = args;

  if (!auth.tokenId) {
    throw new Error('XTIME_TOKEN_ID is empty');
  }

  const url = new URL(
    `/xws/rest/dealers/${encodeURIComponent(body.dealerId)}/apptOptions`,
    auth.baseUrl,
  ).toString();

  const form = new URLSearchParams();
  form.set('autoRecallIds', body.autoRecallIds ?? '[]');
  form.set('declinedServices', body.declinedServices ?? '[]');
  form.set('isValetCustomerBased', body.isValetCustomerBased ?? 'false');
  form.set('locale', body.locale ?? 'en_US');
  form.set('make', body.make);
  form.set('metaVehicleId', String(body.metaVehicleId));
  form.set('model', body.model);
  form.set('servicePoint', body.servicePoint);
  form.set('services', body.services ?? '[]');
  form.set('tokenId', body.tokenId);
  form.set('year', body.year);

  const headers = {
    ...(buildXtimeHeaders(auth) as Record<string, string>),
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  return xtimeFetch<ApptOptionsResponse>(
    'appt_options',
    url,
    { method: 'POST', headers, body: form.toString() },
    auth,
  );
}

// ─── Vehicle metadata endpoints ────────────────────────────────────────────────────────

/**
 * POST /xws/rest/vehicles/make/{make}/years
 *
 * Returns available model years for a given make.
 * Payload is form-urlencoded with `tokenId` and `dealerId`.
 */
export async function getVehicleYears(args: {
  auth: XtimeAuth;
  make: string;
}): Promise<VehicleYearsResponse> {
  const { auth, make } = args;

  if (!auth.tokenId) {
    throw new Error('XTIME_TOKEN_ID is empty');
  }

  const url = new URL(
    `/xws/rest/vehicles/make/${encodeURIComponent(make.toUpperCase())}/years`,
    auth.baseUrl,
  ).toString();

  const form = new URLSearchParams();
  form.set('tokenId', auth.tokenId);
  form.set('dlrCountryCode', auth.countryCode);

  const headers = {
    ...(buildXtimeHeaders(auth) as Record<string, string>),
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  return xtimeFetch<VehicleYearsResponse>(
    'vehicle_years',
    url,
    { method: 'POST', headers, body: form.toString() },
    auth,
  );
}

/**
 * POST /xws/rest/vehicles/make/{make}/models
 *
 * Returns available models for a given make + year.
 * Payload is form-urlencoded.
 */
export async function getVehicleModels(args: {
  auth: XtimeAuth;
  make: string;
  year: string;
}): Promise<VehicleModelsResponse> {
  const { auth, make, year } = args;

  if (!auth.tokenId) {
    throw new Error('XTIME_TOKEN_ID is empty');
  }

  const url = new URL(
    `/xws/rest/vehicles/make/${encodeURIComponent(make.toUpperCase())}/models`,
    auth.baseUrl,
  ).toString();

  const form = new URLSearchParams();
  form.set('tokenId', auth.tokenId);
  form.set('dlrCountryCode', auth.countryCode);
  form.set('year', year);
  form.set('variant', 'SUBARUUSA_ENH2');
  form.set('channel', '2');
  form.set('languageCode', 'en');
  form.set('locale', 'en_US');

  const headers = {
    ...(buildXtimeHeaders(auth) as Record<string, string>),
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  return xtimeFetch<VehicleModelsResponse>(
    'vehicle_models',
    url,
    { method: 'POST', headers, body: form.toString() },
    auth,
  );
}

/**
 * GET /xws/rest/vehicles/dealer/{dealerId}/make/{make}/model/{model}/year/{year}/trim
 *
 * Returns trim/transmission/engine tree for the selected vehicle.
 */
export async function getVehicleTrim(args: {
  auth: XtimeAuth;
  dealerId: string;
  make: string;
  model: string;
  year: string;
}): Promise<VehicleTrimResponse> {
  const { auth, dealerId, make, model, year } = args;

  if (!auth.tokenId) {
    throw new Error('XTIME_TOKEN_ID is empty');
  }

  const url = new URL(
    `/xws/rest/vehicles/dealer/${encodeURIComponent(dealerId)}/make/${encodeURIComponent(make.toUpperCase())}/model/${encodeURIComponent(model.toUpperCase())}/year/${encodeURIComponent(year)}/trim`,
    auth.baseUrl,
  );
  url.searchParams.set('dataStyle', '1');
  url.searchParams.set('channel', '2');
  url.searchParams.set('tokenId', auth.tokenId);
  url.searchParams.set('variant', 'SUBARUUSA_ENH2');
  url.searchParams.set('countryCode', auth.countryCode);
  url.searchParams.set('languageCode', 'en');
  url.searchParams.set('locale', 'en_US');
  url.searchParams.set('useSkipTrim', '1');
  url.searchParams.set('addIDK', 'true');

  return xtimeFetch<VehicleTrimResponse>(
    'vehicle_trim',
    url.toString(),
    { method: 'GET', headers: buildXtimeHeaders(auth) },
    auth,
  );
}

/**
 * POST /xws/rest/vehicles/dealer/{dealerId}/metavehicle/details
 *
 * Resolves the internal metaVehicleId from the vehicle attributes.
 * Confirmed shape from DevTools capture 2026-05-27:
 *   Response.data.id is the metaVehicleId (e.g. 77000772724).
 * This is the missing link between the `trim` cascade and the
 * service catalog / availability endpoints.
 */
export async function getMetaVehicleDetails(args: {
  auth: XtimeAuth;
  dealerId: string;
  make: string;
  model: string;
  year: string;
  trim?: string;
  engineType?: string;
  engineSize?: string;
  driveType?: string;
  transmissionType?: string;
  regDate?: string;
}): Promise<VehicleDetailsResponse> {
  const {
    auth,
    dealerId,
    make,
    model,
    year,
    trim = 'UNKNOWN',
    engineType = '',
    engineSize = '',
    driveType = '',
    transmissionType = '',
    regDate = `01/01/${year}`,
  } = args;

  if (!auth.tokenId) {
    throw new Error('XTIME_TOKEN_ID is empty');
  }

  const url = new URL(
    `/xws/rest/vehicles/dealer/${encodeURIComponent(dealerId)}/metavehicle/details`,
    auth.baseUrl,
  ).toString();

  const form = new URLSearchParams();
  form.set('driveType', driveType);
  form.set('engineSize', engineSize);
  form.set('engineType', engineType);
  form.set('licenseNumber', '');
  form.set('make', make.toUpperCase());
  form.set('metaVehicleId', '');
  form.set('mileage', '');
  form.set('model', model.toUpperCase());
  form.set('regDate', regDate);
  form.set('transmissionType', transmissionType);
  form.set('trim', trim);
  form.set('year', year);

  const headers = {
    ...(buildXtimeHeaders(auth) as Record<string, string>),
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  return xtimeFetch<VehicleDetailsResponse>(
    'metavehicle_details',
    url,
    { method: 'POST', headers, body: form.toString() },
    auth,
  );
}

// ─── Service catalog endpoints ────────────────────────────────────────────────────────

/**
 * GET /xws/rest/services/dealer/{dealerId}/make/{make}/model/{model}/year/{year}/recommended
 *
 * Fetches the recommended maintenance packages (mileage-based menus).
 * Uses `authId` (= tokenId) as a query param — NOT `tokenId`.
 * Captured payload: regDate, engineType, engineSize, driveType, trim,
 * drivingCondition, transmissionType, locale, authId, variant, units,
 * isCappedPricing, useExactMileage.
 */
export async function getRecommendedServices(args: {
  auth: XtimeAuth;
  dealerId: string;
  make: string;
  model: string;
  year: string;
  regDate?: string;
  engineType?: string;
  engineSize?: string;
  driveType?: string;
  trim?: string;
  drivingCondition?: string;
  transmissionType?: string;
  mileage?: string;
}): Promise<RecommendedServicesResponse> {
  const {
    auth,
    dealerId,
    make,
    model,
    year,
    regDate = '2025-01-01',
    engineType = '',
    engineSize = '',
    driveType = '',
    trim = 'UNKNOWN',
    drivingCondition = 'Normal',
    transmissionType = '',
    mileage = '',
  } = args;

  if (!auth.tokenId) {
    throw new Error('XTIME_TOKEN_ID is empty');
  }

  const url = new URL(
    `/xws/rest/services/dealer/${encodeURIComponent(dealerId)}/make/${encodeURIComponent(make.toUpperCase())}/model/${encodeURIComponent(model.toUpperCase())}/year/${encodeURIComponent(year)}/recommended`,
    auth.baseUrl,
  );
  url.searchParams.set('regDate', regDate);
  url.searchParams.set('engineType', engineType);
  url.searchParams.set('engineSize', engineSize);
  url.searchParams.set('driveType', driveType);
  url.searchParams.set('trim', trim);
  url.searchParams.set('drivingCondition', drivingCondition);
  url.searchParams.set('transmissionType', transmissionType);
  url.searchParams.set('locale', 'en_US');
  url.searchParams.set('authId', auth.tokenId);
  url.searchParams.set('variant', 'SUBARUUSA_ENH2');
  url.searchParams.set('units', 'miles');
  url.searchParams.set('isCappedPricing', 'false');
  url.searchParams.set('useExactMileage', '0');
  if (mileage) url.searchParams.set('mileage', mileage);

  return xtimeFetch<RecommendedServicesResponse>(
    'recommended_services',
    url.toString(),
    { method: 'GET', headers: buildXtimeHeaders(auth) },
    auth,
  );
}

/**
 * POST /xws/rest/services/dealer/{dealerId}/make/{make}/model/{model}/year/{year}/unscheduledservices/kind/repair
 *
 * Fetches individual repair services. Form-urlencoded body with:
 * authId, driveType, engineSize, engineType, licenseNumber, locale,
 * make, metaVehicleId, mileage, regDate, transmission, trim, units, variant.
 */
export async function getRepairServices(args: {
  auth: XtimeAuth;
  dealerId: string;
  make: string;
  model: string;
  year: string;
  metaVehicleId: string;
  engineType?: string;
  engineSize?: string;
  driveType?: string;
  trim?: string;
  transmission?: string;
  regDate?: string;
  mileage?: string;
}): Promise<RepairServicesResponse> {
  const {
    auth,
    dealerId,
    make,
    model,
    year,
    metaVehicleId,
    engineType = '',
    engineSize = '',
    driveType = '',
    trim = 'UNKNOWN',
    transmission = '',
    regDate = '2025-01-01',
    mileage = '',
  } = args;

  if (!auth.tokenId) {
    throw new Error('XTIME_TOKEN_ID is empty');
  }

  const url = new URL(
    `/xws/rest/services/dealer/${encodeURIComponent(dealerId)}/make/${encodeURIComponent(make.toUpperCase())}/model/${encodeURIComponent(model.toUpperCase())}/year/${encodeURIComponent(year)}/unscheduledservices/kind/repair`,
    auth.baseUrl,
  ).toString();

  const form = new URLSearchParams();
  form.set('authId', auth.tokenId);
  form.set('driveType', driveType);
  form.set('engineSize', engineSize);
  form.set('engineType', engineType);
  form.set('licenseNumber', '');
  form.set('locale', 'en_US');
  form.set('make', make.toUpperCase());
  form.set('metaVehicleId', metaVehicleId);
  form.set('mileage', mileage);
  form.set('regDate', regDate);
  form.set('transmission', transmission);
  form.set('trim', trim);
  form.set('units', 'miles');
  form.set('variant', 'SUBARUUSA_ENH2');

  const headers = {
    ...(buildXtimeHeaders(auth) as Record<string, string>),
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  return xtimeFetch<RepairServicesResponse>(
    'repair_services',
    url,
    { method: 'POST', headers, body: form.toString() },
    auth,
  );
}

/**
 * POST /xws/rest/services/dealer/{dealerId}/make/{make}/model/{model}/year/{year}/unscheduledservices/kind/maintenance
 *
 * Fetches maintenance services. Same form-urlencoded body as repair.
 * Confirmed from DevTools: same payload shape, same metaVehicleId.
 */
export async function getMaintenanceServices(args: {
  auth: XtimeAuth;
  dealerId: string;
  make: string;
  model: string;
  year: string;
  metaVehicleId: string;
  engineType?: string;
  engineSize?: string;
  driveType?: string;
  trim?: string;
  transmission?: string;
  regDate?: string;
  mileage?: string;
}): Promise<MaintenanceServicesResponse> {
  const {
    auth,
    dealerId,
    make,
    model,
    year,
    metaVehicleId,
    engineType = '',
    engineSize = '',
    driveType = '',
    trim = 'UNKNOWN',
    transmission = '',
    regDate = '2025-01-01',
    mileage = '',
  } = args;

  if (!auth.tokenId) {
    throw new Error('XTIME_TOKEN_ID is empty');
  }

  const url = new URL(
    `/xws/rest/services/dealer/${encodeURIComponent(dealerId)}/make/${encodeURIComponent(make.toUpperCase())}/model/${encodeURIComponent(model.toUpperCase())}/year/${encodeURIComponent(year)}/unscheduledservices/kind/maintenance`,
    auth.baseUrl,
  ).toString();

  const form = new URLSearchParams();
  form.set('authId', auth.tokenId);
  form.set('driveType', driveType);
  form.set('engineSize', engineSize);
  form.set('engineType', engineType);
  form.set('licenseNumber', '');
  form.set('locale', 'en_US');
  form.set('make', make.toUpperCase());
  form.set('metaVehicleId', metaVehicleId);
  form.set('mileage', mileage);
  form.set('regDate', regDate);
  form.set('transmission', transmission);
  form.set('trim', trim);
  form.set('units', 'miles');
  form.set('variant', 'SUBARUUSA_ENH2');

  const headers = {
    ...(buildXtimeHeaders(auth) as Record<string, string>),
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  return xtimeFetch<MaintenanceServicesResponse>(
    'maintenance_services',
    url,
    { method: 'POST', headers, body: form.toString() },
    auth,
  );
}

/**
 * Step D — The "god request": create the appointment.
 *
 * POST /xws/rest/dealer/{dealerId}/appointment/confirm
 *
 * Confirmed from DevTools capture 2026-05-27:
 *   - Sent as `application/x-www-form-urlencoded`
 *   - `gRecaptchaResponse` goes in the FORM BODY (not URL)
 *   - `selectedDate` = "MM/dd/yyyy"
 *   - `selectedTime` = "hh:mm am"
 *   - `vehicle` = JSON-stringified object with engine/trim details
 *   - No tokenId/dlrCountryCode in URL — auth is via XID cookie + tokenId in body
 */
export async function bookAppointment(args: {
  auth: XtimeAuth;
  body: Record<string, string>;
}): Promise<BookAppointmentResponse> {
  const { auth, body } = args;

  const url = new URL(
    `/xws/rest/dealer/${encodeURIComponent(body.dealerId)}/appointment/confirm`,
    auth.baseUrl,
  ).toString();

  // Faithfully forward every key the caller supplies — no defaulting, no
  // dropping — so the booking payload can match the captured working browser
  // request byte-for-byte (including newer fields like customerPersonId,
  // vehicleId that aren't on the original BookAppointmentRequest type).
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v !== undefined && v !== null) form.set(k, v);
  }

  const headers = {
    ...(buildXtimeHeaders(auth) as Record<string, string>),
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  return xtimeFetch<BookAppointmentResponse>(
    'book',
    url,
    { method: 'POST', headers, body: form.toString() },
    auth,
  );
}
