/**
 * Helpers for parsing & validating the payload Retell AI's "Custom Function"
 * tool sends to our middleware.
 *
 * Retell wraps the tool args in `{ name, args, call }` when invoking a custom
 * function during a live call, but it also supports a flat `{ args: ... }`
 * shape for `inbound_dynamic_variables`. We accept either.
 */

import { z } from 'zod';

export const RetellArgsSchema = z.object({
  customer_phone: z.string().trim().min(7).optional(),
  customer_email: z.string().trim().email().optional(),
  customer_first_name: z.string().trim().optional(),
  customer_last_name: z.string().trim().optional(),
  vehicle_year: z.coerce.number().int().min(1980).max(2100).optional(),
  vehicle_make: z.string().trim().optional(),
  vehicle_model: z.string().trim().optional(),
  vehicle_vin: z.string().trim().length(17).optional(),
  vehicle_mileage: z.coerce.number().int().nonnegative().optional(),
  service_requested: z.string().trim().min(2),
  appointment_time: z.string().trim().min(4),       // ISO or natural-language
  transportation: z
    .enum(['CUSTWAIT', 'WAITER', 'DROPOFF', 'LOANER', 'SHUTTLE'])
    .optional(),
  dealer_slug: z.string().trim().optional(),         // override which dealer
  /**
   * When true, stop after the availability check — do NOT create a real
   * appointment in Xtime. Returns the would-be confirmation details so the
   * voice agent can read back the slot for caller confirmation before
   * actually booking.
   */
  dry_run: z.coerce.boolean().optional(),
});

export type RetellArgs = z.infer<typeof RetellArgsSchema>;

/** Outer envelope Retell sends for a "function tool" invocation. */
const RetellEnvelopeSchema = z.object({
  name: z.string().optional(),
  args: z.unknown().optional(),
  call: z
    .object({ call_id: z.string().optional() })
    .partial()
    .optional(),
});

export interface ParsedRetellRequest {
  args: RetellArgs;
  callId?: string;
}

export function parseRetellRequest(raw: unknown): ParsedRetellRequest {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Request body must be a JSON object');
  }

  const env = RetellEnvelopeSchema.safeParse(raw);
  // Body may already BE the args (flat shape) or wrap them under `args`.
  const candidate =
    env.success && env.data.args && typeof env.data.args === 'object'
      ? env.data.args
      : raw;

  const parsed = RetellArgsSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `Invalid Retell payload: ${issue.path.join('.')} ${issue.message}`,
    );
  }

  if (!parsed.data.customer_phone && !parsed.data.customer_email) {
    throw new Error(
      'Either customer_phone or customer_email is required to identify the caller',
    );
  }

  return {
    args: parsed.data,
    callId: env.success ? env.data.call?.call_id : undefined,
  };
}

/** Format a date for the voice agent to read aloud (e.g. "Friday at 2 PM"). */
export function speakableDate(iso: string, timezone = 'America/New_York'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;

  const dayFmt = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: timezone,
  });
  const timeFmt = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: timezone,
  });
  return `${dayFmt.format(d)} at ${timeFmt.format(d)}`;
}

/**
 * Convert Xtime's verbose, ALL-CAPS service names into something a voice
 * agent can read naturally. Truncates long menu descriptions at the first
 * colon (e.g. "C SERVICE: oil change, replace drain plug..." → "C Service").
 */
export function humanizeServiceName(raw: string): string {
  if (!raw) return 'Service Visit';
  const beforeColon = raw.split(':')[0].trim();
  const candidate = beforeColon.length > 0 ? beforeColon : raw.trim();
  // Title-case it
  return candidate
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Best-effort coercion of whatever the LLM hands us into an ISO timestamp.
 * Production-grade callers should use a real NLP date parser (chrono-node);
 * we only handle ISO + a couple obvious shapes here so the route stays
 * dependency-light.
 */
export function coerceIsoDateTime(input: string, timezone = 'America/New_York'): string {
  const direct = new Date(input);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();

  // "2025-05-23 14:00" → "2025-05-23T14:00:00"
  const match = input.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})/);
  if (match) {
    const [, ymd, h, m] = match;
    const d = new Date(`${ymd}T${h.padStart(2, '0')}:${m}:00`);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }

  // Give up: return original; downstream will surface the error.
  void timezone;
  return input;
}
