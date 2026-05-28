/**
 * Type contracts for the (reverse-engineered) Xtime REST surface area.
 *
 * Field names mirror what we observed on x10con.xtime.com network calls.
 * Anything we haven't pinned down precisely is widened to `unknown` so the
 * compiler forces us to narrow at the call site.
 */

export interface XtimeCustomer {
  /** Undefined on the new-customer fork; Xtime assigns it server-side. */
  customerId?: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  homePhone?: string;
  mobilePhone?: string;
  workPhone?: string;
}

export interface XtimeVehicle {
  /** Undefined on the new-customer fork; Xtime assigns it server-side. */
  vehicleId?: number;
  customerId?: number;
  /**
   * Xtime's internal person/customer identifier returned on the
   * /customerVehicles response. Same value the booking endpoint expects
   * in the `customerPersonId` form field.
   */
  personId?: number;
  year?: number | string;
  make?: string;
  model?: string;
  vin?: string;
  trim?: string;
  mileage?: number;
  /** Server may also echo name/contact on the vehicle row. */
  firstname?: string;
  lastname?: string;
  email?: string;
  phoneNumber?: string;
  /** Pre-resolved vehicle catalog id — lets us skip the /trim call. */
  metaVehicleId?: number;
  engineType?: string;
  engineSize?: string;
  driveType?: string;
  transmissionType?: string;
  vehicleRegDate?: string;
  lastDrivingCondition?: string;
}

/** GET /xws/rest/vehicles/dealer/{dealerId}/customerVehicles */
export interface CustomerVehiclesResponse {
  customers?: XtimeCustomer[];
  vehicles?: XtimeVehicle[];
  /** Some tenants flatten the response to a top-level array. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}

/**
 * POST /xws/rest/dealer/{dealerId}/appointment/getFirstAvailability
 *
 * Sent as `application/x-www-form-urlencoded` (NOT JSON). Field names and
 * defaults mirror the real consumer.xtime.com payload captured 2026-05-27.
 *
 * Auth model for this endpoint:
 *   - tokenId is in the BODY (not URL)
 *   - relies on the XID cookie set by the prior /customerVehicles call
 *   - NO gRecaptchaResponse needed (cookie auth carries the trust)
 *
 * Key insight from DevTools capture:
 *   - `servicePoint` is a JSON-stringified object containing the full menu/package
 *   - `services` is always `[]` (individual add-on services, usually empty)
 *   - `metaVehicleId` is the Xtime internal vehicle catalog ID (e.g. 77000772724)
 */
export interface AvailabilityRequest {
  dealerId: string;
  /** Form field `tokenId`. Numeric session token from .env. */
  tokenId: string;
  /** Form field `selectedDate`, yyyy-MM-dd. */
  selectedDate: string;
  /** Vehicle make, e.g. "SUBARU". Uppercase. */
  make: string;
  /** Vehicle model, e.g. "BRZ". Uppercase. */
  model: string;
  /**
   * Xtime's internal vehicle catalog id (from `metaVehicleId` in repair/maintenance
   * payload, e.g. 77000772724). Required.
   */
  metaVehicleId: string | number;
  /**
   * JSON-stringified servicePoint object containing the selected menu/package.
   * This is the full recommended menu object from the `recommended` endpoint,
   * wrapped as: {menuType: {...}, mileage, months, units, position}
   * Use `{}` or `""` if no package selected (individual services mode).
   */
  servicePoint?: string;
  /**
   * Individual add-on services (not in a package).
   * Usually [] when a servicePoint/package is selected.
   * Format: [{id, name, shopDuration, dmsOpcode, price, ...}]
   */
  services?: Array<{
    id: number;
    shopDuration?: number;
    dmsOpcode?: string;
    name: string;
    price?: number;
    waiterAllowed?: number;
    loanerAllowed?: number;
    selectable?: number;
    showPrice?: number;
  }>;
  /** "WAITER" | "DROPOFF" | "PICKUP" */
  transportationOption?: string;
  /** "BIWEEKLY" by default. */
  view?: string;
  locale?: string;
  /** "CP8" — consumer-portal-v8 client identifier. */
  whoami?: string;
  vin?: string;
  vehicleId?: string;
  advisorId?: string;
  pickupAddress?: string;
  dropoffAddress?: string;
  /** Stringified JSON arrays, default "[]". */
  autoRecallIds?: string;
  declinedServices?: string;
}

/**
 * POST /xws/rest/dealers/{dealerId}/apptOptions
 *
 * Fetches available advisors and transport options for the selected services.
 * Sent after service selection, before calendar. Form-urlencoded.
 * `servicePoint` is the JSON-stringified menu object (same as getFirstAvailability).
 */
export interface ApptOptionsRequest {
  dealerId: string;
  tokenId: string;
  make: string;
  model: string;
  year: string;
  metaVehicleId: string | number;
  servicePoint: string;
  services?: string;
  autoRecallIds?: string;
  declinedServices?: string;
  locale?: string;
  isValetCustomerBased?: string;
}

export interface ApptOptionsResponse {
  apptOptions?: {
    advisors?: Array<{ data: number; label: string; code: string }>;
    transportOptions?: Array<{ label: string; data: string; configuration?: object }>;
  };
  statusCode?: number;
  success?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}

/** Single open slot returned by Xtime. */
export interface AvailabilityTimeslot {
  time: string; // "HH:mm:ss"
}

export interface AvailabilityDay {
  isOpen: boolean;
  isToday: boolean;
  calendarDate: string; // yyyy-MM-dd
  timeslots?: AvailabilityTimeslot[];
}

export interface AvailabilityResponse {
  availableTimes?: {
    greeterInterval?: string;
    Days?: AvailabilityDay[];
  };
  key?: string;
  statusCode?: number;
  success?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}

// ─── Vehicle metadata ────────────────────────────────────────────────────────

/** POST /xws/rest/vehicles/make/{make}/years */
export interface VehicleYearsResponse {
  key?: string;
  statusCode?: number;
  success?: boolean;
  years?: string[];
}

/** POST /xws/rest/vehicles/make/{make}/models */
export interface VehicleModelsResponse {
  key?: string;
  statusCode?: number;
  success?: boolean;
  models?: Array<{ label: string; data: string }>;
}

/**
 * POST /xws/rest/vehicles/dealer/{dealerId}/metavehicle/details
 *
 * Resolves the internal metaVehicleId from year/make/model/trim/engine/etc.
 * Returns `data.id` which is the metaVehicleId (e.g. 77000772724).
 * Fired by the consumer.xtime.com client right after the user picks trim/engine.
 */
export interface VehicleDetailsResponse {
  data?: {
    id?: number;                  // ← this is the metaVehicleId
    make?: string;
    model?: string;
    year?: number;
    trim?: string;
    engineType?: string;
    engineSize?: string;
    driveType?: string;
    transmissionType?: string;
  };
  statusCode?: number;
  success?: boolean;
}

/**
 * GET /xws/rest/vehicles/dealer/{dealerId}/make/{make}/model/{model}/year/{year}/trim
 * Returns nested transmission → driveType → trim → engineType → engineSize tree.
 */
export interface VehicleTrimResponse {
  key?: string;
  statusCode?: number;
  success?: boolean;
  vehicleInfo?: {
    year?: string;
    make?: string;
    model?: string;
    showDrivingCondition?: boolean;
    defaultDrivingCondition?: string;
    transmissions?: Array<{
      label: string;
      value: string;
      driveTypes?: Array<{
        label: string;
        value: string;
        trims?: Array<{
          label: string;
          value: string;
          engineTypes?: Array<{
            label: string;
            value: string;
            engineSizes?: Array<{
              label: string;
              value: string;
              drivingConditions?: Array<{ label: string; data: string }>;
            }>;
          }>;
        }>;
      }>;
    }>;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}

// ─── Service catalog ──────────────────────────────────────────────────────────

export interface XtimeService {
  id: number;
  name: string;
  price?: number;
  shopDuration?: number;
  dmsOpcode?: string;
  description?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}

/** GET /xws/rest/...recommended — recommended maintenance package */
export interface RecommendedServicesResponse {
  key?: string;
  statusCode?: number;
  success?: boolean;
  services?: XtimeService[];
  packages?: Array<{
    id: number;
    name: string;
    price?: number;
    services?: XtimeService[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [k: string]: any;
  }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}

/** GET .../repair — individual repair services */
export interface RepairServicesResponse {
  key?: string;
  statusCode?: number;
  success?: boolean;
  services?: XtimeService[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}

/** GET .../maintenance — maintenance services */
export interface MaintenanceServicesResponse {
  key?: string;
  statusCode?: number;
  success?: boolean;
  services?: XtimeService[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}

/**
 * POST /xws/rest/dealer/{dealerId}/appointment/confirm ("the god request")
 *
 * Confirmed from DevTools capture 2026-05-27. Sent as form-urlencoded.
 * `gRecaptchaResponse` goes in the FORM BODY (not URL).
 *
 * Date format: MM/dd/yyyy (e.g. "06/02/2026")
 * Time format: "hh:mm am/pm" (e.g. "08:00 am")
 * `vehicle` is a JSON-stringified object with engine/trim details.
 */
export interface BookAppointmentRequest {
  dealerId: string;
  tokenId: string;
  /** Fresh reCAPTCHA v3 token — goes in form body for this endpoint. */
  gRecaptchaResponse: string;

  // ─ Customer contact ───────────────────────────────────────────────────
  email: string;
  firstName?: string;
  lastName?: string;
  /** Main phone number (shown on review page). */
  phoneNumber?: string;
  mobilePhoneNumber?: string;

  // ─ Appointment slot ─────────────────────────────────────────────
  /** MM/dd/yyyy — e.g. "06/02/2026" */
  selectedDate: string;
  /** "hh:mm am" — e.g. "08:00 am" */
  selectedTime: string;
  /** "DROPOFF" | "WAITER" | "PICKUP" */
  transportationOption?: string;
  advisorId?: string;

  // ─ Vehicle ───────────────────────────────────────────────────────
  metaVehicleId: string | number;
  mileage?: string;
  /**
   * JSON-stringified vehicle details object.
   * e.g. {"make":"SUBARU","model":"BRZ","year":"2025",
   *        "engineType":"H4","engineSize":"2.4L","driveType":"RWD",
   *        "transmissionType":"Automatic","trim":"UNKNOWN",
   *        "drivingCondition":"Normal","mileage":null,
   *        "vehRegDate":"01/01/2025","licenseNumber":"",
   *        "phoneNumber":"9785550100"}
   */
  vehicle: string;

  // ─ Services (same as getFirstAvailability) ──────────────────────
  servicePoint?: string;
  services?: string;
  autoRecallIds?: string;
  autoRecallServices?: string;
  declinedServices?: string;

  // ─ Flow metadata ─────────────────────────────────────────────────
  /** "IM_NEW_HERE" for new customers. */
  apptFlow?: string;
  /** Always "2". */
  channel?: string;
  callbackRequired?: string;
  ignoreConflicts?: string;
  emailPrivacySetting?: string;
  textPrivacySetting?: string;
  externalValetProvider?: string;
  locale?: string;
  whoami?: string;
}

export interface BookAppointmentResponse {
  appointment?: {
    confirmationKey?: string;       // e.g. "X10DDTVBPM"
    reservationId?: number;
    startTime?: string;             // "2026-06-02 08:00:00"
    endTime?: string;
    lifecycleState?: string;        // "CONFIRMED"
    transportationOption?: string;
    transportationDisplayText?: string;
    agentName?: string;
    vehicle?: {
      metaVehicleId?: number;
      vehicleId?: number;
      make?: string;
      model?: string;
      year?: string;
      trim?: string;
      engineType?: string;
      engineSize?: string;
      transmissionType?: string;
      driveType?: string;
    };
    personInfo?: { id?: number };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [k: string]: any;
  };
  key?: string;
  statusCode?: number;
  success?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}
