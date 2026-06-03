export default function HomePage() {
  const deliverables = [
    {
      num: '01',
      title: 'Reverse-engineered Xtime API',
      desc: 'Intercepted full auth pattern from mcgovernsubaruofacton.com via Chrome DevTools. Mapped tokenId + XID cookie + reCAPTCHA v3 enterprise flow across 8 endpoints.',
      done: true,
    },
    {
      num: '02',
      title: 'Postman Collection',
      desc: 'All Xtime endpoints + middleware in postman/AutoAce_Xtime.postman_collection.json — importable with pre-request scripts and environment variables.',
      done: true,
    },
    {
      num: '03',
      title: 'Next.js Middleware /api/schedule-xtime',
      desc: 'Full orchestration: reCAPTCHA minting → session warm → customer lookup → vehicle/trim resolution → service catalog → availability check → booking → Supabase audit.',
      done: true,
    },
    {
      num: '04',
      title: 'Retell → Next.js → Xtime Integration',
      desc: 'Voice agent "Alex" deployed on Retell AI. Collects intent, fires tool call to this Vercel deployment, handles errors with natural language. Live API hits verified.',
      done: true,
    },
  ];

  const endpoints = [
    { method: 'GET',  path: '/xws/rest/dealer/{id}/settings',                      note: 'Session warm-up (XID cookie)' },
    { method: 'GET',  path: '/xws/rest/vehicles/dealer/{id}/customerVehicles',      note: 'Existing vs. new customer fork' },
    { method: 'GET',  path: '/xws/rest/vehicles/dealer/{id}/trim',                  note: 'metaVehicleId + engine resolution' },
    { method: 'GET',  path: '/xws/rest/vehicles/dealer/{id}/details',               note: 'Vehicle metadata confirmation' },
    { method: 'POST', path: '/xws/rest/services/dealer/{id}/recommendedServices',   note: 'Service catalog (primary)' },
    { method: 'POST', path: '/xws/rest/services/dealer/{id}/maintenanceServices',   note: 'Service catalog (fallback)' },
    { method: 'POST', path: '/xws/rest/appointment/dealer/{id}/getFirstAvailability', note: 'Slot availability check' },
    { method: 'POST', path: '/xws/rest/appointment/dealer/{id}/confirm',            note: 'The God Request — final booking' },
  ];

  return (
    <main style={{ fontFamily: 'system-ui, -apple-system, sans-serif', background: '#0a0a0a', color: '#e5e7eb', minHeight: '100vh' }}>
      {/* Hero */}
      <div style={{ borderBottom: '1px solid #1f2937', padding: '64px 24px 48px', textAlign: 'center' }}>
        <div style={{ maxWidth: 720, margin: '0 auto' }}>
          <div style={{ display: 'inline-block', background: '#052e16', color: '#4ade80', fontSize: 12, fontWeight: 600, letterSpacing: '0.1em', padding: '4px 12px', borderRadius: 99, marginBottom: 24, border: '1px solid #166534' }}>
            LIVE ON VERCEL
          </div>
          <h1 style={{ fontSize: 52, fontWeight: 700, margin: '0 0 16px', letterSpacing: '-0.02em' }}>
            Auto<span style={{ color: '#3b82f6' }}>Ace</span>
          </h1>
          <p style={{ fontSize: 20, color: '#9ca3af', margin: '0 0 12px', lineHeight: 1.5 }}>
            Retell AI Voice Agent → Next.js Middleware → Xtime API
          </p>
          <p style={{ fontSize: 15, color: '#6b7280', margin: 0 }}>
            Reverse-engineered Xtime REST API bridge for programmatic service appointment scheduling at McGovern Subaru of Acton.
          </p>
          <div style={{ marginTop: 32, display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
            <a href="/console" style={{ background: '#3b82f6', color: '#fff', padding: '10px 24px', borderRadius: 8, textDecoration: 'none', fontSize: 14, fontWeight: 600 }}>
              ▶ Live Demo Console
            </a>
            <a href="/api/health" style={{ background: '#1f2937', color: '#e5e7eb', padding: '10px 20px', borderRadius: 8, textDecoration: 'none', fontSize: 14, border: '1px solid #374151' }}>
              GET /api/health
            </a>
          </div>
        </div>
      </div>

      {/* Architecture */}
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '48px 24px 0' }}>
        <h2 style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.1em', color: '#6b7280', marginBottom: 16 }}>ARCHITECTURE</h2>
        <div style={{ background: '#111827', border: '1px solid #1f2937', borderRadius: 12, padding: '24px 32px', fontFamily: 'monospace', fontSize: 13, color: '#d1d5db', lineHeight: 2 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ background: '#1e3a5f', color: '#93c5fd', padding: '4px 12px', borderRadius: 6 }}>Retell AI Voice</span>
            <span style={{ color: '#4b5563' }}>──── tool call JSON ────►</span>
            <span style={{ background: '#1a2e1a', color: '#4ade80', padding: '4px 12px', borderRadius: 6 }}>Next.js /api/schedule-xtime</span>
            <span style={{ color: '#4b5563' }}>──── xws/rest ────►</span>
            <span style={{ background: '#2d1b4e', color: '#c4b5fd', padding: '4px 12px', borderRadius: 6 }}>Xtime x10con API</span>
          </div>
          <div style={{ marginTop: 8, paddingLeft: 16, color: '#4b5563' }}>
            └── audit trail ──► <span style={{ color: '#f9a8d4' }}>Supabase (dealers + appointments)</span>
          </div>
        </div>
      </div>

      {/* Deliverables */}
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '48px 24px 0' }}>
        <h2 style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.1em', color: '#6b7280', marginBottom: 16 }}>DELIVERABLES</h2>
        <div style={{ display: 'grid', gap: 12 }}>
          {deliverables.map((d) => (
            <div key={d.num} style={{ background: '#111827', border: '1px solid #1f2937', borderRadius: 12, padding: '20px 24px', display: 'flex', gap: 20, alignItems: 'flex-start' }}>
              <div style={{ flexShrink: 0, width: 36, height: 36, background: '#052e16', border: '1px solid #166534', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4ade80', fontSize: 16 }}>
                ✓
              </div>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                  <span style={{ color: '#4b5563', fontSize: 12, fontFamily: 'monospace' }}>{d.num}</span>
                  <strong style={{ fontSize: 15 }}>{d.title}</strong>
                </div>
                <p style={{ margin: 0, color: '#9ca3af', fontSize: 14, lineHeight: 1.6 }}>{d.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Endpoints */}
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '48px 24px 0' }}>
        <h2 style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.1em', color: '#6b7280', marginBottom: 16 }}>MAPPED XTIME ENDPOINTS</h2>
        <div style={{ background: '#111827', border: '1px solid #1f2937', borderRadius: 12, overflow: 'hidden' }}>
          {endpoints.map((e, i) => (
            <div key={i} style={{ padding: '14px 24px', borderBottom: i < endpoints.length - 1 ? '1px solid #1f2937' : 'none', display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'monospace', fontSize: 11, fontWeight: 700, color: e.method === 'GET' ? '#34d399' : '#f59e0b', background: e.method === 'GET' ? '#022c22' : '#1c1400', padding: '2px 8px', borderRadius: 4, flexShrink: 0 }}>
                {e.method}
              </span>
              <code style={{ fontSize: 12, color: '#c4b5fd', flex: 1, minWidth: 200 }}>{e.path}</code>
              <span style={{ fontSize: 12, color: '#6b7280' }}>{e.note}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Auth */}
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '48px 24px 0' }}>
        <h2 style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.1em', color: '#6b7280', marginBottom: 16 }}>AUTH PATTERN DISCOVERED</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          {[
            { label: 'tokenId', desc: 'Query param, scraped from consumer.xtime.com', life: 'Hours' },
            { label: 'dlrCountryCode', desc: 'Static query param', life: 'Static' },
            { label: 'gRecaptchaResponse', desc: 'reCAPTCHA v3 enterprise token via CapSolver', life: '~2 min' },
            { label: 'XID cookie', desc: 'Session cookie, auto-captured on first response', life: 'Session' },
          ].map((a) => (
            <div key={a.label} style={{ background: '#111827', border: '1px solid #1f2937', borderRadius: 10, padding: '16px 20px' }}>
              <code style={{ fontSize: 12, color: '#93c5fd' }}>{a.label}</code>
              <p style={{ fontSize: 13, color: '#9ca3af', margin: '8px 0 4px', lineHeight: 1.5 }}>{a.desc}</p>
              <span style={{ fontSize: 11, color: '#4b5563' }}>Lifetime: {a.life}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Known Limitation */}
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '48px 24px 0' }}>
        <h2 style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.1em', color: '#6b7280', marginBottom: 16 }}>⚠️ KNOWN LIMITATION</h2>
        <div style={{ background: '#1c1008', border: '1px solid #78350f', borderRadius: 12, padding: '24px' }}>
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginBottom: 16 }}>
            <span style={{ fontSize: 24, flexShrink: 0 }}>⚠️</span>
            <div>
              <strong style={{ fontSize: 15, color: '#fbbf24' }}>Final booking step returns HTTP 500 from Xtime</strong>
              <p style={{ margin: '8px 0 0', color: '#9ca3af', fontSize: 14, lineHeight: 1.6 }}>
                <code style={{ color: '#c4b5fd' }}>POST /xws/rest/appointment/dealer/{'{id}'}/confirm</code> — the God Request — is rejected server-side by Xtime.
                Every upstream step works correctly (lookup, vehicle resolution, service catalog, availability check, payload construction).
              </p>
            </div>
          </div>
          <div style={{ borderTop: '1px solid #78350f', paddingTop: 16 }}>
            <p style={{ margin: '0 0 8px', fontSize: 13, color: '#d97706', fontWeight: 600 }}>Root cause</p>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: '#9ca3af', lineHeight: 1.6 }}>
              Xtime uses Google reCAPTCHA v3 Enterprise with strict server-side validation. Tokens minted from a real browser score 0.9 (human) and succeed.
              Tokens from cloud servers — including headless Chromium (Playwright) and CAPTCHA-solving services (CapSolver) — are rejected regardless of token format.
              A successful booking was confirmed via direct browser DevTools capture, proving the payload is correct.
            </p>
            <p style={{ margin: '0 0 8px', fontSize: 13, color: '#d97706', fontWeight: 600 }}>Paths to resolution</p>
            <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: '#9ca3af', lineHeight: 1.8 }}>
              <li>Obtain a dealer API key directly from Xtime (bypasses consumer reCAPTCHA entirely)</li>
              <li>Maintain a persistent authenticated browser session server-side via a residential proxy</li>
              <li>Use the dealer's DMS (CDK/Reynolds) API instead of the consumer-facing Xtime endpoint</li>
            </ul>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div style={{ maxWidth: 860, margin: '48px auto 0', padding: '24px', borderTop: '1px solid #1f2937', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <span style={{ fontSize: 13, color: '#4b5563' }}>AutoAce · Built for Vault - The Unsealed Depository</span>
        <div style={{ display: 'flex', gap: 20 }}>
          <a href="/api/health" style={{ fontSize: 13, color: '#6b7280', textDecoration: 'none' }}>Health</a>
          <span style={{ fontSize: 13, color: '#6b7280' }}>POST /api/schedule-xtime</span>
        </div>
      </div>
      <div style={{ height: 48 }} />
    </main>
  );
}
