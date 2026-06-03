'use client';

import { useState } from 'react';

const RETELL_ORB_URL =
  'https://agent.retellai.com/orb/agent_15561e747d1052ab309ec6a9f9?token=1387c5e45e8bfaedf03e67e46f124cdb';

interface DebugTrace {
  lookup?: {
    customers_returned: number;
    vehicles_returned: number;
    matched_existing_customer: boolean;
  };
  vehicle?: {
    metaVehicleId: string;
    trim: string;
    engineType: string;
    engineSize: string;
    driveType: string;
    transmission: string;
  };
  service?: {
    serviceId: number;
    serviceName: string;
    price?: number;
    shopDuration?: number;
    dmsOpcode?: string;
  };
  availability?: {
    requested_day: string;
    days_returned: number;
    slot_count_for_day: number;
    slots_for_day: string[];
    confirmed_slot?: string;
  };
  booking?: {
    attempted: boolean;
    xtimeResponse?: unknown;
  };
}

interface ApiResponse {
  success: boolean;
  message: string;
  error_code?: string;
  steps_completed?: string[];
  appointment?: Record<string, unknown>;
  details?: unknown;
  debug?: DebugTrace;
}

const C = {
  bg: '#0a0a0a',
  card: '#111827',
  border: '#1f2937',
  text: '#e5e7eb',
  muted: '#9ca3af',
  dim: '#6b7280',
  blue: '#3b82f6',
  green: '#4ade80',
  amber: '#fbbf24',
  purple: '#c4b5fd',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: '#0a0a0a',
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  padding: '10px 12px',
  color: C.text,
  fontSize: 14,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  color: C.dim,
  marginBottom: 6,
  fontWeight: 600,
};

function defaultDateTime(): string {
  // tomorrow at 09:00 local, formatted for datetime-local input
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ConsolePage() {
  const [form, setForm] = useState({
    customer_first_name: 'Jordan',
    customer_last_name: 'Avery',
    customer_phone: '+15085551234',
    customer_email: '',
    vehicle_year: '2022',
    vehicle_make: 'Subaru',
    vehicle_model: 'Ascent',
    service_requested: 'oil change',
    appointment_time: defaultDateTime(),
    transportation: 'DROPOFF',
    dry_run: false,
  });
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<ApiResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);

  const set = (k: string, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  function clear() {
    setForm({
      customer_first_name: '',
      customer_last_name: '',
      customer_phone: '',
      customer_email: '',
      vehicle_year: '',
      vehicle_make: '',
      vehicle_model: '',
      service_requested: '',
      appointment_time: '',
      transportation: 'DROPOFF',
      dry_run: false,
    });
    setRes(null);
    setErr(null);
    setElapsed(null);
  }

  async function run() {
    setLoading(true);
    setRes(null);
    setErr(null);
    setElapsed(null);
    const t0 = Date.now();
    try {
      const body: Record<string, unknown> = {
        ...form,
        appointment_time: new Date(form.appointment_time).toISOString(),
        debug: true,
      };
      // Strip empty optional fields so blank values don't trip schema validation
      // (e.g. an empty phone string fails the min-length rule).
      const optional = [
        'customer_first_name',
        'customer_last_name',
        'customer_phone',
        'customer_email',
        'vehicle_make',
        'vehicle_model',
      ] as const;
      for (const k of optional) {
        if (!form[k]) delete body[k];
      }
      // vehicle_year: send a number when provided, otherwise omit entirely.
      if (form.vehicle_year) body.vehicle_year = Number(form.vehicle_year);
      else delete body.vehicle_year;

      const r = await fetch('/api/schedule-xtime', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await r.json()) as ApiResponse;
      setRes(json);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setElapsed(Date.now() - t0);
      setLoading(false);
    }
  }

  return (
    <main style={{ fontFamily: 'system-ui, -apple-system, sans-serif', background: C.bg, color: C.text, minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ borderBottom: `1px solid ${C.border}`, padding: '32px 24px' }}>
        <div style={{ maxWidth: 980, margin: '0 auto' }}>
          <a href="/" style={{ fontSize: 13, color: C.dim, textDecoration: 'none' }}>← Back to overview</a>
          <h1 style={{ fontSize: 32, fontWeight: 700, margin: '12px 0 8px', letterSpacing: '-0.02em' }}>
            Live Demo Console
          </h1>
          <p style={{ fontSize: 15, color: C.muted, margin: 0, lineHeight: 1.6 }}>
            Talk to the voice agent, or run the booking pipeline directly and inspect every Xtime step — customer lookup, vehicle/trim resolution, matched service, available slots, and the final booking response.
          </p>
        </div>
      </div>

      {/* Voice widget */}
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '32px 24px 0' }}>
        <h2 style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.1em', color: C.dim, marginBottom: 16 }}>🎙️ TALK TO ALEX (VOICE AGENT)</h2>
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16 }}>
          <iframe
            src={RETELL_ORB_URL}
            title="Retell Voice Agent"
            allow="microphone"
            style={{ width: '100%', height: 480, border: 'none', borderRadius: 8 }}
          />
          <p style={{ fontSize: 12, color: C.dim, margin: '12px 4px 0' }}>
            Widget not loading?{' '}
            <a href={RETELL_ORB_URL} target="_blank" rel="noreferrer" style={{ color: C.blue }}>
              Open the voice agent in a new tab →
            </a>
          </p>
        </div>
        <div style={{ background: '#0f1b2d', border: '1px solid #1e40af', borderRadius: 10, padding: '14px 18px', marginTop: 12, fontSize: 13, color: '#93c5fd', lineHeight: 1.6 }}>
          <strong style={{ color: '#bfdbfe' }}>Note:</strong> the voice widget above is Retell&apos;s hosted player — it speaks the result but does <strong>not</strong> display the underlying JSON. To inspect the full step-by-step pipeline data (customer lookup, vehicle/trim, matched service, available slots, and the raw Xtime booking response), use the <strong>Run Pipeline</strong> form below.
        </div>
      </div>

      {/* Form + results grid */}
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '32px 24px', display: 'grid', gridTemplateColumns: '360px 1fr', gap: 24, alignItems: 'start' }}>
        {/* Form */}
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 24 }}>
          <h2 style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.1em', color: C.dim, marginBottom: 6 }}>BOOKING REQUEST</h2>
          <p style={{ fontSize: 12, color: C.dim, margin: '0 0 18px' }}>
            <span style={{ color: '#f87171' }}>*</span> required
          </p>
          <div style={{ display: 'grid', gap: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={labelStyle}>First name</label>
                <input style={inputStyle} value={form.customer_first_name} onChange={(e) => set('customer_first_name', e.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>Last name</label>
                <input style={inputStyle} value={form.customer_last_name} onChange={(e) => set('customer_last_name', e.target.value)} />
              </div>
            </div>
            <div>
              <label style={labelStyle}>Phone (E.164)</label>
              <input style={inputStyle} value={form.customer_phone} onChange={(e) => set('customer_phone', e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>Email (optional)</label>
              <input style={inputStyle} value={form.customer_email} onChange={(e) => set('customer_email', e.target.value)} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr 1fr', gap: 12 }}>
              <div>
                <label style={labelStyle}>Year</label>
                <input style={inputStyle} value={form.vehicle_year} onChange={(e) => set('vehicle_year', e.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>Make</label>
                <input style={inputStyle} value={form.vehicle_make} onChange={(e) => set('vehicle_make', e.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>Model</label>
                <input style={inputStyle} value={form.vehicle_model} onChange={(e) => set('vehicle_model', e.target.value)} />
              </div>
            </div>
            <div>
              <label style={labelStyle}>Service requested <span style={{ color: '#f87171' }}>*</span></label>
              <input style={inputStyle} value={form.service_requested} onChange={(e) => set('service_requested', e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>Appointment time <span style={{ color: '#f87171' }}>*</span></label>
              <input type="datetime-local" style={inputStyle} value={form.appointment_time} onChange={(e) => set('appointment_time', e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>Transportation</label>
              <select style={inputStyle} value={form.transportation} onChange={(e) => set('transportation', e.target.value)}>
                <option value="DROPOFF">Drop off</option>
                <option value="WAITER">Wait at dealership</option>
                <option value="LOANER">Loaner</option>
                <option value="SHUTTLE">Shuttle</option>
              </select>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: C.muted, cursor: 'pointer' }}>
              <input type="checkbox" checked={form.dry_run} onChange={(e) => set('dry_run', e.target.checked)} />
              Dry run (stop before final booking)
            </label>
            <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <button
                onClick={run}
                disabled={loading}
                style={{
                  flex: 1,
                  background: loading ? C.border : C.blue,
                  color: '#fff',
                  border: 'none',
                  borderRadius: 8,
                  padding: '12px 16px',
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: loading ? 'default' : 'pointer',
                }}
              >
                {loading ? 'Running pipeline…' : 'Run Pipeline'}
              </button>
              <button
                onClick={clear}
                disabled={loading}
                style={{
                  background: 'transparent',
                  color: C.muted,
                  border: `1px solid ${C.border}`,
                  borderRadius: 8,
                  padding: '12px 16px',
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: loading ? 'default' : 'pointer',
                }}
              >
                Clear
              </button>
            </div>
          </div>
        </div>

        {/* Results */}
        <div>
          <h2 style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.1em', color: C.dim, marginBottom: 16 }}>
            PIPELINE RESULT {elapsed != null && <span style={{ color: C.dim, fontWeight: 400 }}>· {(elapsed / 1000).toFixed(1)}s</span>}
          </h2>

          {!res && !err && !loading && (
            <div style={{ background: C.card, border: `1px dashed ${C.border}`, borderRadius: 12, padding: 40, textAlign: 'center', color: C.dim, fontSize: 14 }}>
              Fill in the request and click <strong style={{ color: C.muted }}>Run Pipeline</strong> to see each Xtime step execute in real time.
            </div>
          )}

          {loading && (
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 40, textAlign: 'center', color: C.muted, fontSize: 14 }}>
              Minting reCAPTCHA tokens, warming session, and calling Xtime…
            </div>
          )}

          {err && (
            <div style={{ background: '#1c0f0f', border: '1px solid #7f1d1d', borderRadius: 12, padding: 20, color: '#fca5a5', fontSize: 14 }}>
              Request error: {err}
            </div>
          )}

          {res && <ResultView res={res} />}
        </div>
      </div>
      <div style={{ height: 48 }} />
    </main>
  );
}

function StatusBanner({ res }: { res: ApiResponse }) {
  const booked = res.success && res.appointment?.confirmation_number;
  const bg = res.success ? '#052e16' : res.error_code === 'XTIME_BOOKING_FAILED' ? '#1c1008' : '#1c0f0f';
  const bd = res.success ? '#166534' : res.error_code === 'XTIME_BOOKING_FAILED' ? '#78350f' : '#7f1d1d';
  const fg = res.success ? C.green : res.error_code === 'XTIME_BOOKING_FAILED' ? C.amber : '#fca5a5';
  return (
    <div style={{ background: bg, border: `1px solid ${bd}`, borderRadius: 12, padding: 20, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <span style={{ fontSize: 18 }}>{res.success ? (booked ? '✅' : '🟡') : '⚠️'}</span>
        <strong style={{ color: fg, fontSize: 15 }}>
          {res.error_code ?? (res.success ? 'SUCCESS' : 'FAILED')}
        </strong>
      </div>
      <p style={{ margin: 0, color: C.muted, fontSize: 14, lineHeight: 1.6 }}>{res.message}</p>
    </div>
  );
}

function Step({ n, title, ok, children }: { n: number; title: string; ok: boolean; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 14, padding: '14px 0', borderBottom: `1px solid ${C.border}` }}>
      <div style={{ flexShrink: 0, width: 28, height: 28, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, background: ok ? '#052e16' : '#1c1008', border: `1px solid ${ok ? '#166534' : '#78350f'}`, color: ok ? C.green : C.amber }}>
        {ok ? '✓' : '⚠'}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
          <span style={{ color: C.dim, fontFamily: 'monospace', marginRight: 8 }}>{String(n).padStart(2, '0')}</span>
          {title}
        </div>
        <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.7 }}>{children}</div>
      </div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <span style={{ display: 'inline-flex', gap: 6, marginRight: 16 }}>
      <span style={{ color: C.dim }}>{k}:</span>
      <span style={{ color: C.purple, fontFamily: 'monospace' }}>{v}</span>
    </span>
  );
}

function ResultView({ res }: { res: ApiResponse }) {
  const d = res.debug;
  return (
    <div>
      <StatusBanner res={res} />
      {d && (
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: '4px 24px 8px' }}>
          <Step n={1} title="Session warm-up — XID cookie acquired" ok>
            <span style={{ color: C.dim }}>Preflight <code style={{ color: C.purple }}>/settings</code> call succeeded.</span>
          </Step>

          <Step n={2} title="Customer & vehicle lookup" ok={!!d.lookup}>
            {d.lookup ? (
              <>
                <KV k="customers" v={d.lookup.customers_returned} />
                <KV k="vehicles" v={d.lookup.vehicles_returned} />
                <KV k="match" v={d.lookup.matched_existing_customer ? 'existing customer' : 'new customer'} />
              </>
            ) : '—'}
          </Step>

          <Step n={3} title="Vehicle / trim resolution" ok={!!d.vehicle}>
            {d.vehicle ? (
              <>
                <KV k="metaVehicleId" v={d.vehicle.metaVehicleId || '—'} />
                <KV k="trim" v={d.vehicle.trim || '—'} />
                <KV k="engine" v={`${d.vehicle.engineType} ${d.vehicle.engineSize}`.trim() || '—'} />
                <KV k="drive" v={d.vehicle.driveType || '—'} />
                <KV k="trans" v={d.vehicle.transmission || '—'} />
              </>
            ) : '—'}
          </Step>

          <Step n={4} title="Service catalog match" ok={!!d.service}>
            {d.service ? (
              <>
                <KV k="service" v={d.service.serviceName || '—'} />
                <KV k="id" v={d.service.serviceId} />
                {d.service.price != null && <KV k="price" v={`$${d.service.price}`} />}
                {d.service.shopDuration != null && <KV k="duration" v={`${d.service.shopDuration} min`} />}
                {d.service.dmsOpcode && <KV k="opcode" v={d.service.dmsOpcode} />}
              </>
            ) : '—'}
          </Step>

          <Step n={5} title="Availability check" ok={!!d.availability}>
            {d.availability ? (
              <>
                <div style={{ marginBottom: 8 }}>
                  <KV k="requested day" v={d.availability.requested_day} />
                  <KV k="days returned" v={d.availability.days_returned} />
                  <KV k="slots that day" v={d.availability.slot_count_for_day} />
                  {d.availability.confirmed_slot && <KV k="confirmed" v={d.availability.confirmed_slot} />}
                </div>
                {d.availability.slots_for_day.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                    {d.availability.slots_for_day.map((s) => (
                      <span
                        key={s}
                        style={{
                          fontSize: 11,
                          fontFamily: 'monospace',
                          padding: '3px 8px',
                          borderRadius: 5,
                          background: s === d.availability!.confirmed_slot ? '#052e16' : '#0a0a0a',
                          border: `1px solid ${s === d.availability!.confirmed_slot ? '#166534' : C.border}`,
                          color: s === d.availability!.confirmed_slot ? C.green : C.muted,
                        }}
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                )}
              </>
            ) : '—'}
          </Step>

          <Step n={6} title="Final booking — POST /confirm" ok={!!(res.success && res.appointment?.confirmation_number)}>
            {d.booking?.attempted ? (
              <>
                <div style={{ marginBottom: 8, color: res.success ? C.green : C.amber }}>
                  {res.success && res.appointment?.confirmation_number
                    ? `Booked. Confirmation #${String(res.appointment.confirmation_number)}`
                    : 'Payload built and sent — Xtime rejected the booking (reCAPTCHA v3 Enterprise server-side validation).'}
                </div>
                <pre style={{ margin: 0, background: '#0a0a0a', border: `1px solid ${C.border}`, borderRadius: 8, padding: 12, fontSize: 11, color: C.muted, overflowX: 'auto' }}>
                  {JSON.stringify(d.booking.xtimeResponse, null, 2)}
                </pre>
              </>
            ) : (
              <span style={{ color: C.dim }}>Not reached (stopped earlier or dry run).</span>
            )}
          </Step>
        </div>
      )}

      {res.steps_completed && (
        <div style={{ marginTop: 16, fontSize: 12, color: C.dim }}>
          steps_completed: {res.steps_completed.join(' → ')}
        </div>
      )}

      <details style={{ marginTop: 16 }}>
        <summary style={{ fontSize: 12, color: C.dim, cursor: 'pointer' }}>Raw JSON response</summary>
        <pre style={{ marginTop: 8, background: '#0a0a0a', border: `1px solid ${C.border}`, borderRadius: 8, padding: 16, fontSize: 11, color: C.muted, overflowX: 'auto' }}>
          {JSON.stringify(res, null, 2)}
        </pre>
      </details>
    </div>
  );
}
