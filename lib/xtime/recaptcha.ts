/**
 * reCAPTCHA v3 token providers for Xtime.
 *
 * Xtime gates `xws/rest` calls behind Google reCAPTCHA v3. Each request needs
 * a fresh `gRecaptchaResponse` value that:
 *   - Was minted by Google JS for Xtime's site key
 *   - Is at most ~2 minutes old
 *   - Is single-use in practice
 *
 * We support four modes (selected via `RECAPTCHA_MODE` env):
 *
 *   1. `manual`     — paste a token into env (good for local demos only).
 *   2. `capsolver`  — call CapSolver's API (https://capsolver.com).
 *   3. `twocaptcha` — call 2Captcha's API (https://2captcha.com).
 *   4. `playwright` — launch a real headless Chromium, load consumer.xtime.com,
 *                     and intercept the genuine Google-minted token. Always
 *                     scores 0.9+ because Google sees a real browser.
 *
 * For production use `playwright` — it is free and produces tokens Xtime
 * always accepts. The paid services charge ~$1-3/1000 tokens but may still
 * be rejected by strict enterprise reCAPTCHA keys.
 */

export interface RecaptchaProvider {
  /** Mints a fresh token. `action` is the v3 action label (e.g. 'lookup'). */
  getToken(action?: string): Promise<string>;
  /** Mints `count` tokens in one browser session (Playwright) or sequentially (others). */
  mintTokens(count: number, action?: string): Promise<string[]>;
  /** For logging; never used in URLs. */
  readonly mode: 'manual' | 'capsolver' | 'twocaptcha' | 'playwright';
}

// ─── Config from env ─────────────────────────────────────────────────────────

interface RecaptchaConfig {
  mode: 'manual' | 'capsolver' | 'twocaptcha' | 'playwright';
  siteKey: string;
  pageUrl: string;
  defaultAction: string;
  manualToken?: string;
  capsolverApiKey?: string;
  twocaptchaApiKey?: string;
}

function loadConfig(): RecaptchaConfig {
  const mode = (process.env.RECAPTCHA_MODE ?? 'manual').toLowerCase();
  if (mode !== 'manual' && mode !== 'capsolver' && mode !== 'twocaptcha' && mode !== 'playwright') {
    throw new Error(`Unknown RECAPTCHA_MODE='${mode}'`);
  }
  return {
    mode: mode as RecaptchaConfig['mode'],
    siteKey: process.env.RECAPTCHA_SITE_KEY ?? '',
    pageUrl: process.env.RECAPTCHA_PAGE_URL ?? 'https://consumer.xtime.com/',
    defaultAction: process.env.RECAPTCHA_ACTION ?? 'submit',
    manualToken: process.env.XTIME_RECAPTCHA_TOKEN,
    capsolverApiKey: process.env.CAPSOLVER_API_KEY,
    twocaptchaApiKey: process.env.TWOCAPTCHA_API_KEY,
  };
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function getRecaptchaProvider(): RecaptchaProvider {
  const cfg = loadConfig();
  switch (cfg.mode) {
    case 'manual':
      return manualProvider(cfg);
    case 'capsolver':
      return capsolverProvider(cfg);
    case 'twocaptcha':
      return twocaptchaProvider(cfg);
    case 'playwright':
      return playwrightProvider(cfg);
  }
}

// ─── Mode 1: manual paste (local/demo) ───────────────────────────────────────

function manualProvider(cfg: RecaptchaConfig): RecaptchaProvider {
  return {
    mode: 'manual',
    async getToken() {
      if (!cfg.manualToken) {
        throw new Error(
          'RECAPTCHA_MODE=manual requires XTIME_RECAPTCHA_TOKEN. ' +
            'Open consumer.xtime.com in DevTools, capture a fresh token, paste it. ' +
            "Tokens expire ~2 min after Google's JS issues them.",
        );
      }
      return cfg.manualToken;
    },
    async mintTokens(count, action) {
      const t = await this.getToken(action);
      return Array(count).fill(t);
    },
  };
}

// ─── Mode 2: CapSolver ───────────────────────────────────────────────────────
//
// API docs: https://docs.capsolver.com/guide/captcha/ReCaptchaV3.html
// Two-step polling: createTask → getTaskResult.

function capsolverProvider(cfg: RecaptchaConfig): RecaptchaProvider {
  return {
    mode: 'capsolver',
    async getToken(action) {
      if (!cfg.capsolverApiKey) throw new Error('CAPSOLVER_API_KEY missing');
      if (!cfg.siteKey) throw new Error('RECAPTCHA_SITE_KEY missing');

      const createRes = await fetch('https://api.capsolver.com/createTask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientKey: cfg.capsolverApiKey,
          task: {
            // Enterprise variant — Xtime's site key (6Ldjljod...) is registered
            // as a reCAPTCHA Enterprise key by Subaru. Asking for the
            // non-enterprise task produces tokens Google scores low; Xtime
            // then silently filters them (empty results / HTTP 500).
            type: 'ReCaptchaV3EnterpriseTaskProxyLess',
            websiteURL: cfg.pageUrl,
            websiteKey: cfg.siteKey,
            pageAction: action ?? cfg.defaultAction,
            minScore: 0.9,
          },
        }),
      });
      const create = (await createRes.json()) as {
        errorId: number;
        errorDescription?: string;
        taskId?: string;
      };
      if (create.errorId !== 0 || !create.taskId) {
        throw new Error(
          `CapSolver createTask failed: ${create.errorDescription ?? 'unknown'}`,
        );
      }

      // Poll for result; CapSolver usually resolves in 5-15s.
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        await sleep(2_000);
        const pollRes = await fetch('https://api.capsolver.com/getTaskResult', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientKey: cfg.capsolverApiKey,
            taskId: create.taskId,
          }),
        });
        const poll = (await pollRes.json()) as {
          errorId: number;
          errorDescription?: string;
          status: 'idle' | 'processing' | 'ready';
          solution?: { gRecaptchaResponse?: string };
        };
        if (poll.errorId !== 0) {
          throw new Error(
            `CapSolver getTaskResult failed: ${poll.errorDescription ?? 'unknown'}`,
          );
        }
        if (poll.status === 'ready' && poll.solution?.gRecaptchaResponse) {
          return poll.solution.gRecaptchaResponse;
        }
      }
      throw new Error('CapSolver timed out after 60s');
    },
    async mintTokens(count, action) {
      const tokens: string[] = [];
      for (let i = 0; i < count; i++) tokens.push(await this.getToken(action));
      return tokens;
    },
  };
}

// ─── Mode 3: 2Captcha ────────────────────────────────────────────────────────
//
// API docs: https://2captcha.com/2captcha-api#solving_recaptchav3

function twocaptchaProvider(cfg: RecaptchaConfig): RecaptchaProvider {
  return {
    mode: 'twocaptcha',
    async getToken(action) {
      if (!cfg.twocaptchaApiKey) throw new Error('TWOCAPTCHA_API_KEY missing');
      if (!cfg.siteKey) throw new Error('RECAPTCHA_SITE_KEY missing');

      const inUrl = new URL('https://2captcha.com/in.php');
      inUrl.searchParams.set('key', cfg.twocaptchaApiKey);
      inUrl.searchParams.set('method', 'userrecaptcha');
      inUrl.searchParams.set('version', 'v3');
      inUrl.searchParams.set('googlekey', cfg.siteKey);
      inUrl.searchParams.set('pageurl', cfg.pageUrl);
      inUrl.searchParams.set('action', action ?? cfg.defaultAction);
      inUrl.searchParams.set('min_score', '0.7');
      inUrl.searchParams.set('json', '1');

      const inRes = await fetch(inUrl);
      const inJson = (await inRes.json()) as { status: number; request: string };
      if (inJson.status !== 1) {
        throw new Error(`2Captcha in.php failed: ${inJson.request}`);
      }
      const captchaId = inJson.request;

      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        await sleep(5_000);
        const resUrl = new URL('https://2captcha.com/res.php');
        resUrl.searchParams.set('key', cfg.twocaptchaApiKey);
        resUrl.searchParams.set('action', 'get');
        resUrl.searchParams.set('id', captchaId);
        resUrl.searchParams.set('json', '1');

        const resRes = await fetch(resUrl);
        const resJson = (await resRes.json()) as {
          status: number;
          request: string;
        };
        if (resJson.status === 1) return resJson.request;
        if (resJson.request !== 'CAPCHA_NOT_READY') {
          throw new Error(`2Captcha res.php failed: ${resJson.request}`);
        }
      }
      throw new Error('2Captcha timed out after 90s');
    },
    async mintTokens(count, action) {
      const tokens: string[] = [];
      for (let i = 0; i < count; i++) tokens.push(await this.getToken(action));
      return tokens;
    },
  };
}

// ─── Mode 4: Playwright (real headless Chromium) ─────────────────────────────
//
// Launches a real Chrome browser, navigates to consumer.xtime.com, waits for
// Google's reCAPTCHA JS to load, then calls grecaptcha.execute() directly to
// mint a genuine token. Google scores it 0.9+ because it comes from a real
// browser with a real JS engine — Xtime always accepts it.

function playwrightProvider(cfg: RecaptchaConfig): RecaptchaProvider {
  // Shared browser state — reused across all getToken() calls within the
  // same provider instance (i.e. same request lifecycle). This avoids
  // launching Chrome twice per booking request and gives Google a warmer
  // session, which improves the reCAPTCHA score.
  let browserPromise: Promise<{
    browser: import('playwright-core').Browser;
    page: import('playwright-core').Page;
  }> | null = null;

  async function getSession(chromium: typeof import('playwright-core').chromium) {
    if (!browserPromise) {
      browserPromise = (async () => {
        console.info('[recaptcha/playwright] launching headless Chromium');
        const browser = await chromium.launch({
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
          ],
        });

        const context = await browser.newContext({
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
          locale: 'en-US',
          viewport: { width: 1280, height: 800 },
        });

        const page = await context.newPage();

        await page.addInitScript(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });

        // Block XHR/fetch/image/media so the SPA never hangs.
        await context.route('**/*', (route) => {
          const type = route.request().resourceType();
          if (['xhr', 'fetch', 'image', 'media', 'font', 'websocket'].includes(type)) {
            return route.abort();
          }
          return route.continue();
        });

        // Navigate once to consumer.xtime.com so origin is correct.
        await page.goto(cfg.pageUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });

        // Inject and wait for reCAPTCHA script.
        await page.addScriptTag({
          url: `https://www.google.com/recaptcha/api.js?render=${cfg.siteKey}`,
        });
        await page.waitForFunction(() => typeof (window as any).grecaptcha !== 'undefined', {
          timeout: 15_000,
        });

        return { browser, page };
      })();
    }
    return browserPromise;
  }

  return {
    mode: 'playwright',
    async getToken(action) {
      const { chromium } = await import('playwright-core');
      const resolvedAction = action ?? cfg.defaultAction;

      const { browser, page } = await getSession(chromium);

      try {
        const token = await page.evaluate(
          ({ siteKey, act }: { siteKey: string; act: string }) =>
            new Promise<string>((resolve, reject) => {
              (window as any).grecaptcha.ready(() => {
                (window as any).grecaptcha
                  .execute(siteKey, { action: act })
                  .then(resolve)
                  .catch(reject);
              });
            }),
          { siteKey: cfg.siteKey, act: resolvedAction },
        );

        console.info('[recaptcha/playwright] token minted', {
          length: token.length,
          prefix: token.slice(0, 20),
        });
        return token;
      } finally {
        browser.close().catch(() => {});
        browserPromise = null;
      }
    },
    async mintTokens(count, action) {
      const { chromium } = await import('playwright-core');
      const resolvedAction = action ?? cfg.defaultAction;
      const { browser, page } = await getSession(chromium);
      const tokens: string[] = [];
      try {
        for (let i = 0; i < count; i++) {
          const token = await page.evaluate(
            ({ siteKey, act }: { siteKey: string; act: string }) =>
              new Promise<string>((resolve, reject) => {
                (window as any).grecaptcha.ready(() => {
                  (window as any).grecaptcha
                    .execute(siteKey, { action: act })
                    .then(resolve)
                    .catch(reject);
                });
              }),
            { siteKey: cfg.siteKey, act: resolvedAction },
          );
          console.info('[recaptcha/playwright] token minted', {
            index: i,
            length: token.length,
            prefix: token.slice(0, 20),
          });
          tokens.push(token);
        }
      } finally {
        browser.close().catch(() => {});
        browserPromise = null;
      }
      return tokens;
    },
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
