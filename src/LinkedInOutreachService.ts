import { EventEmitter } from "events";
import path from "path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { buildOutreachMessage } from "./messageBuilder";
import { resolveSessionCookies } from "./cookieLoader";
import type {
  LinkedInOutreachServiceEvents,
  OutreachStatusEvent,
  ProspectRow,
  RunOptions,
  RunSummary,
  ServiceConfig,
} from "./types";
import {
  pickRandom,
  randomDelay,
  randomInt,
  sleep,
  STEALTH_LAUNCH_OPTIONS,
  USER_AGENTS,
  VIEWPORTS,
} from "./utils";

const LINKEDIN_HOME = "https://www.linkedin.com/";
const VOYAGER_ME_URL = "https://www.linkedin.com/voyager/api/me";

type ProcessResult =
  | "success"
  | "message_sent"
  | "already_connected"
  | "skipped"
  | "failed";

export class LinkedInOutreachService extends EventEmitter {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private readonly config: Required<
    Omit<
      ServiceConfig,
      | "browserChannel"
      | "liAtCookie"
      | "cookiesPath"
      | "storageStatePath"
      | "profileDir"
      | "authMode"
      | "cdpUrl"
    >
  > &
    Pick<
      ServiceConfig,
      | "browserChannel"
      | "liAtCookie"
      | "cookiesPath"
      | "storageStatePath"
      | "profileDir"
      | "authMode"
      | "cdpUrl"
    >;
  private usesPersistentProfile = false;
  private usesCdpConnection = false;

  constructor(config: ServiceConfig) {
    super();
    const authMode = config.authMode ?? "cookies";
    const hasStorageState = Boolean(config.storageStatePath?.trim());
    const hasLiAt = Boolean(config.liAtCookie?.trim());
    const hasCookiesFile = Boolean(config.cookiesPath?.trim());
    const hasProfileDir = Boolean(config.profileDir?.trim());

    if (authMode === "profile") {
      if (!hasProfileDir) {
        throw new Error("profileDir is required when authMode is profile");
      }
    } else if (authMode === "cdp") {
      // cdpUrl has a default
    } else if (!hasStorageState && !hasLiAt && !hasCookiesFile) {
      throw new Error(
        "Provide LI_AT, LINKEDIN_COOKIES_PATH, LINKEDIN_STORAGE_STATE, or set AUTH_MODE=profile"
      );
    }

    this.config = {
      authMode,
      cdpUrl: config.cdpUrl?.trim() || "http://127.0.0.1:9222",
      profileDir: config.profileDir?.trim(),
      manualLoginTimeoutMs: config.manualLoginTimeoutMs ?? 300_000,
      liAtCookie: config.liAtCookie?.trim(),
      cookiesPath: config.cookiesPath?.trim(),
      storageStatePath: config.storageStatePath?.trim(),
      headless: config.headless ?? false,
      browserChannel: config.browserChannel,
      actionDelayMinMs: config.actionDelayMinMs ?? 1000,
      actionDelayMaxMs: config.actionDelayMaxMs ?? 3000,
      profileDelayMinMs: config.profileDelayMinMs ?? 9_000,
      profileDelayMaxMs: config.profileDelayMaxMs ?? 9_000,
      typeDelayMinMs: config.typeDelayMinMs ?? 50,
      typeDelayMaxMs: config.typeDelayMaxMs ?? 150,
    };
  }

  emitStatus(
    code: OutreachStatusEvent["code"],
    message: string,
    prospect?: ProspectRow,
    error?: Error,
    meta?: Record<string, unknown>
  ): void {
    const event: OutreachStatusEvent = { code, message, prospect, error, meta };
    this.emit("status", event);
  }

  async initialize(): Promise<void> {
    if (this.config.authMode === "cdp") {
      await this.initializeCdpSession();
      return;
    }
    if (this.config.authMode === "profile") {
      await this.initializePersistentProfile();
      return;
    }
    await this.initializeCookieSession();
  }

  private async initializeCdpSession(): Promise<void> {
    const cdpUrl = this.config.cdpUrl!;
    this.emitStatus("INFO", `Connecting to your Chrome at ${cdpUrl}…`);

    try {
      this.browser = await chromium.connectOverCDP(cdpUrl, { timeout: 15_000 });
    } catch {
      this.emitStatus(
        "AUTH_FAILED",
        "Could not connect to Chrome. Close all Chrome windows, then run: npm run chrome"
      );
      throw new Error("CDP connection failed — start Chrome with npm run chrome first");
    }

    this.context = this.browser.contexts()[0];
    if (!this.context) {
      throw new Error("Connected to Chrome but no browser context was found");
    }
    this.usesCdpConnection = true;

    if (await this.isLoggedIn(this.context)) {
      this.emitStatus("INFO", "Session verified — using your logged-in Chrome.");
      return;
    }

    this.emitStatus(
      "INFO",
      "Not logged in yet. In the Chrome window from 'npm run chrome', open linkedin.com/feed and sign in."
    );
    await this.waitForManualLogin(this.context);
    this.emitStatus("INFO", "Session verified — ready to process prospects.");
  }

  private async initializePersistentProfile(): Promise<void> {
    const profileDir = path.resolve(this.config.profileDir!);
    const browserLabel = this.config.browserChannel ?? "playwright-chromium";
    this.emitStatus(
      "INFO",
      `Launching persistent browser profile (${browserLabel}) at ${profileDir}…`
    );

    if (this.config.headless) {
      this.emitStatus(
        "WARNING",
        "HEADLESS=true ignored for profile auth — a visible browser is required for login."
      );
    }

    this.context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      ...(this.config.browserChannel
        ? { channel: this.config.browserChannel }
        : {}),
      viewport: null,
      locale: "en-US",
      ...STEALTH_LAUNCH_OPTIONS,
    });
    this.usesPersistentProfile = true;

    if (await this.verifySession(this.context)) {
      this.emitStatus("INFO", "Session verified from saved browser profile.");
      return;
    }

    await this.waitForManualLogin(this.context);
    this.emitStatus("INFO", "Session verified — ready to process prospects.");
  }

  private async initializeCookieSession(): Promise<void> {
    const browserLabel = this.config.browserChannel ?? "playwright-chromium";
    this.emitStatus(
      "INFO",
      `Launching browser (${browserLabel}) with stealth-oriented context…`
    );

    const viewport = pickRandom(VIEWPORTS);
    const userAgent = pickRandom(USER_AGENTS);

    this.browser = await chromium.launch({
      headless: this.config.headless,
      ...(this.config.browserChannel
        ? { channel: this.config.browserChannel }
        : {}),
      ...STEALTH_LAUNCH_OPTIONS,
    });

    this.context = await this.browser.newContext({
      viewport,
      userAgent,
      locale: "en-US",
      timezoneId: "America/New_York",
      colorScheme: "light",
      deviceScaleFactor: 1,
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
      },
      ...(this.config.storageStatePath
        ? { storageState: this.config.storageStatePath }
        : {}),
    });

    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined,
      });
    });

    if (!this.config.storageStatePath) {
      const cookies = resolveSessionCookies({
        liAtCookie: this.config.liAtCookie,
        cookiesPath: this.config.cookiesPath,
      });
      await this.context.addCookies(cookies);
      this.emitStatus(
        "INFO",
        `Injected ${cookies.length} LinkedIn cookie(s) into browser context.`
      );
    }

    const authed = await this.verifySession(this.context);
    if (!authed) {
      this.emitStatus(
        "AUTH_FAILED",
        "Cookie auth failed. Set AUTH_MODE=profile in .env, log in once in the browser, or export all cookies to linkedin-cookies.json (see README)."
      );
      throw new Error("LinkedIn authentication failed");
    }

    this.emitStatus("INFO", "Session verified — ready to process prospects.");
  }

  private async waitForManualLogin(context: BrowserContext): Promise<void> {
    this.emitStatus(
      "INFO",
      "Polling for login every 2s (max 5 min). Log in in Chrome — outreach starts automatically once detected."
    );

    let lastProgressAt = 0;
    const deadline = Date.now() + this.config.manualLoginTimeoutMs;

    while (Date.now() < deadline) {
      if (await this.isLoggedIn(context)) {
        this.emitStatus("INFO", "Login detected — starting outreach.");
        return;
      }

      const now = Date.now();
      if (now - lastProgressAt >= 15_000) {
        lastProgressAt = now;
        const linkedinTabs = context
          .pages()
          .map((p) => p.url())
          .filter((u) => u.includes("linkedin.com"));
        const hasLiAt = await this.hasLiAtCookie(context);
        this.emitStatus(
          "INFO",
          `Still waiting… li_at cookie: ${hasLiAt ? "yes" : "no"} | tabs: ${linkedinTabs.join(", ") || "(open linkedin.com/feed in Chrome)"}`
        );
      }

      await sleep(2000);
    }

    this.emitStatus(
      "AUTH_FAILED",
      "Login not detected in 5 minutes. In Chrome: go to linkedin.com/feed, log in fully, then re-run the script."
    );
    throw new Error("LinkedIn manual login timed out");
  }

  private async hasLiAtCookie(context: BrowserContext): Promise<boolean> {
    const cookies = await context.cookies("https://www.linkedin.com");
    const liAt = cookies.find((c) => c.name === "li_at");
    return Boolean(liAt?.value && liAt.value.length > 20);
  }

  private async isLoggedIn(context: BrowserContext): Promise<boolean> {
    if (!(await this.hasLiAtCookie(context))) {
      return false;
    }

    for (const page of context.pages()) {
      const url = page.url();
      if (!url.includes("linkedin.com")) continue;
      if (url.includes("/login") || url.includes("flagship-web/login")) continue;
      if (url.includes("/feed") || url.includes("/mynetwork") || url.includes("/in/")) {
        return true;
      }
      if (await this.verifySessionOnPage(page).catch(() => false)) {
        return true;
      }
    }

    return this.verifySessionViaApi(context);
  }

  async run(prospects: ProspectRow[], options: RunOptions = {}): Promise<RunSummary> {
    if (!this.context) {
      throw new Error("Call initialize() before run()");
    }

    const summary: RunSummary = {
      total: prospects.length,
      success: 0,
      messagesSent: 0,
      alreadyConnected: 0,
      skipped: 0,
      failed: 0,
      halted: false,
    };

    const continueOnError = options.continueOnError ?? true;

    for (let i = 0; i < prospects.length; i++) {
      const prospect = prospects[i]!;
      this.emit("progress", { current: i + 1, total: prospects.length, prospect });

      const displayName =
        prospect.founder_name?.trim() || prospect.company_name || prospect.linkedin_url;

      try {
        if (await this.detectRateLimitOnContext()) {
          summary.halted = true;
          summary.haltReason = "rate_limit";
          this.emitStatus(
            "RATE_LIMITED",
            "Halting queue — LinkedIn rate limit or security challenge detected.",
            prospect
          );
          break;
        }

        const result = await this.processProspect(prospect);

        switch (result) {
          case "success":
            summary.success += 1;
            this.emitStatus("SUCCESS", `Connection request sent to ${displayName}`, prospect);
            if (
              options.maxSuccesses !== undefined &&
              summary.success + summary.messagesSent >= options.maxSuccesses
            ) {
              this.emitStatus("HALTED", `Reached maxSuccesses cap (${options.maxSuccesses}).`);
              summary.halted = true;
              summary.haltReason = "max_successes";
              return this.finishRun(summary);
            }
            break;
          case "message_sent":
            summary.messagesSent += 1;
            this.emitStatus("MESSAGE_SENT", `Direct message sent to ${displayName}`, prospect);
            if (
              options.maxSuccesses !== undefined &&
              summary.success + summary.messagesSent >= options.maxSuccesses
            ) {
              this.emitStatus("HALTED", `Reached maxSuccesses cap (${options.maxSuccesses}).`);
              summary.halted = true;
              summary.haltReason = "max_successes";
              return this.finishRun(summary);
            }
            break;
          case "already_connected":
            summary.alreadyConnected += 1;
            this.emitStatus(
              "ALREADY_CONNECTED",
              `Skipping ${displayName} — connected but direct message failed.`,
              prospect
            );
            break;
          case "skipped":
            summary.skipped += 1;
            this.emitStatus(
              "SKIP_NO_CONNECT",
              `Skipping ${displayName} — Connect option not available.`,
              prospect
            );
            break;
          case "failed":
            summary.failed += 1;
            this.emitStatus(
              "ERROR",
              `Could not send invite to ${displayName} — Connect clicked but note/send step failed.`,
              prospect
            );
            break;
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));

        if (error.message === "RATE_LIMITED") {
          summary.halted = true;
          summary.haltReason = "rate_limit";
          this.emitStatus(
            "RATE_LIMITED",
            "Halting queue — LinkedIn rate limit or security challenge detected.",
            prospect,
            error
          );
          break;
        }

        summary.failed += 1;
        this.emitStatus("ERROR", `Failed for ${displayName}: ${error.message}`, prospect, error);

        if (!continueOnError) {
          summary.halted = true;
          summary.haltReason = "error";
          break;
        }
      }

      if (i < prospects.length - 1 && !summary.halted) {
        const waitMs = randomInt(
          this.config.profileDelayMinMs,
          this.config.profileDelayMaxMs
        );
        this.emitStatus(
          "INFO",
          `Waiting ${Math.round(waitMs / 1000)}s before next profile…`,
          prospect,
          undefined,
          { waitMs }
        );
        await sleep(waitMs);
      }
    }

    return this.finishRun(summary);
  }

  async shutdown(): Promise<void> {
    if (this.usesCdpConnection) {
      if (this.browser) {
        await this.browser.close().catch(() => undefined);
        this.browser = null;
        this.context = null;
      }
      this.emitStatus("INFO", "Disconnected from Chrome (browser left open).");
      return;
    }

    if (this.context) {
      await this.context.close().catch(() => undefined);
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
    }
    this.emitStatus("INFO", "Browser closed.");
  }

  private finishRun(summary: RunSummary): RunSummary {
    this.emit("complete", summary);
    return summary;
  }

  private async actionDelay(): Promise<void> {
    await randomDelay(this.config.actionDelayMinMs, this.config.actionDelayMaxMs);
  }

  private async verifySession(context: BrowserContext): Promise<boolean> {
    const viaApi = await this.verifySessionViaApi(context);
    if (viaApi) return true;

    const page = await context.newPage();
    try {
      await page.goto(LINKEDIN_HOME, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await this.actionDelay();
      return this.verifySessionOnPage(page);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("ERR_TOO_MANY_REDIRECTS")) {
        this.emitStatus(
          "WARNING",
          "Redirect loop detected — usually means an expired li_at or missing companion cookies (bcookie, JSESSIONID). Export all cookies to linkedin-cookies.json."
        );
      }
      return false;
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private async verifySessionViaApi(context: BrowserContext): Promise<boolean> {
    try {
      const response = await context.request.get(VOYAGER_ME_URL, {
        failOnStatusCode: false,
        timeout: 30_000,
        headers: {
          Accept: "application/vnd.linkedin.normalized+json+2.1",
          "X-Restli-Protocol-Version": "2.0.0",
        },
      });

      if (response.status() !== 200) {
        return false;
      }

      const body = (await response.json().catch(() => null)) as unknown;
      return body !== null && typeof body === "object";
    } catch {
      return false;
    }
  }

  private async verifySessionOnPage(page: Page): Promise<boolean> {
    const url = page.url();
    if (
      url.includes("/login") ||
      url.includes("/checkpoint") ||
      url.includes("flagship-web/login")
    ) {
      return false;
    }

    const loginForm = page.locator('input[name="session_key"]');
    if (await loginForm.isVisible({ timeout: 3000 }).catch(() => false)) {
      return false;
    }

    const nav = page.locator(
      'nav[aria-label="Primary"], .global-nav, #global-nav'
    );
    return nav.first().isVisible({ timeout: 15_000 }).catch(() => false);
  }

  private async detectRateLimit(page: Page): Promise<boolean> {
    const url = page.url();
    if (
      url.includes("/checkpoint") ||
      url.includes("/challenge") ||
      url.includes("/security")
    ) {
      return true;
    }

    const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
    const signals = [
      "unusual activity",
      "let's do a quick security check",
      "security verification",
      "captcha",
      "automated behavior",
    ];
    return signals.some((s) => bodyText.includes(s));
  }

  private async detectRateLimitOnContext(): Promise<boolean> {
    if (!this.context) return false;
    const pages = this.context.pages();
    for (const page of pages) {
      if (await this.detectRateLimit(page)) return true;
    }
    return false;
  }

  private async processProspect(prospect: ProspectRow): Promise<ProcessResult> {
    if (!this.context) throw new Error("Browser context not initialized");

    const page = await this.context.newPage();

    try {
      const { message, truncated, originalLength } = buildOutreachMessage(prospect);

      if (truncated) {
        this.emitStatus(
          "WARNING",
          `Message truncated from ${originalLength} to ${message.length} chars for ${prospect.company_name}`,
          prospect,
          undefined,
          { originalLength, finalLength: message.length }
        );
      }

      const profileUrl = this.normalizeProfileUrl(prospect.linkedin_url);
      this.emitStatus("INFO", `Opening profile: ${profileUrl}`, prospect);
      await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.bringToFront();
      await this.waitForProfileReady(page);
      await this.actionDelay();

      if (await this.detectRateLimit(page)) {
        throw new Error("RATE_LIMITED");
      }

      await this.humanScroll(page);
      await page.evaluate("window.scrollTo(0, 0)");
      await this.actionDelay();
      await this.dismissOverlays(page);

      if (await this.isAlreadyConnected(page)) {
        this.emitStatus(
          "INFO",
          "Already connected (Message visible) — sending direct message…",
          prospect
        );
        const messaged = await this.sendDirectMessage(page, message, prospect);
        return messaged ? "message_sent" : "already_connected";
      }

      const connectState = await this.resolveAndClickConnect(page, prospect);

      if (connectState === "clicked") {
        await this.actionDelay();
        const sent = await this.completeConnectionNote(page, message, prospect);
        if (sent) return "success";

        await this.dismissOverlays(page);
        this.emitStatus(
          "INFO",
          "Connection invite failed — falling back to direct message…",
          prospect
        );
        const messaged = await this.sendDirectMessage(page, message, prospect);
        return messaged ? "message_sent" : "failed";
      }

      this.emitStatus(
        "INFO",
        "Connect not available — sending direct message…",
        prospect
      );
      const messaged = await this.sendDirectMessage(page, message, prospect);
      if (messaged) return "message_sent";

      if (connectState === "already_connected") return "already_connected";
      return "skipped";
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private normalizeProfileUrl(url: string): string {
    let normalized = url.trim();
    if (!normalized.startsWith("http")) {
      normalized = `https://${normalized}`;
    }
    try {
      const parsed = new URL(normalized);
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return normalized;
    }
  }

  private async humanScroll(page: Page): Promise<void> {
    const steps = randomInt(2, 4);
    for (let i = 0; i < steps; i++) {
      const down = randomInt(280, 520);
      await page.mouse.wheel(0, down);
      await randomDelay(800, 1500);
    }
    for (let i = 0; i < randomInt(1, 2); i++) {
      const up = randomInt(120, 280);
      await page.mouse.wheel(0, -up);
      await randomDelay(600, 1200);
    }
  }

  private async waitForProfileReady(page: Page): Promise<void> {
    await page
      .locator(
        "main section.artdeco-card, .pv-top-card, .pvs-header, h1.inline.t-24"
      )
      .first()
      .waitFor({ state: "visible", timeout: 20_000 })
      .catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => undefined);
  }

  private actionScopes(page: Page): Locator[] {
    const main = page.locator("main").first();
    return [
      main.locator(".pvs-profile-actions").first(),
      main.locator(".pv-top-card-v2-ctas").first(),
      main.locator("section.artdeco-card").first(),
      main.locator(".ph5").first(),
      main.locator("div").filter({ has: main.locator("h1") }).first(),
      main,
    ];
  }

  private async findInScopes(
    page: Page,
    finder: (scope: Locator) => Promise<Locator | null>
  ): Promise<Locator | null> {
    for (const scope of this.actionScopes(page)) {
      if ((await scope.count()) === 0) continue;
      const found = await finder(scope);
      if (found) return found;
    }
    return null;
  }

  private async findMoreButton(scope: Locator): Promise<Locator | null> {
    const selectors = [
      scope.getByRole("button", { name: /^More$/i }),
      scope.getByRole("button", { name: /more actions/i }),
      scope.locator('button[aria-label="More actions"]'),
      scope.locator('button[aria-label*="More actions" i]'),
      scope.locator('button[aria-label*="More" i]'),
      scope.locator("button.artdeco-dropdown__trigger"),
    ];

    for (const locator of selectors) {
      const target = locator.first();
      if (await target.isVisible({ timeout: 1000 }).catch(() => false)) {
        return target;
      }
    }
    return null;
  }

  private async hasMessageButton(page: Page): Promise<boolean> {
    return (await this.findInScopes(page, (s) => this.findMessageButton(s))) !== null;
  }

  private async isAlreadyConnected(page: Page): Promise<boolean> {
    if (await this.hasMessageButton(page)) {
      return true;
    }

    for (const scope of this.actionScopes(page)) {
      if ((await scope.count()) === 0) continue;
      const pending = scope.getByRole("button", { name: /^Pending$/i }).first();
      if (await pending.isVisible({ timeout: 800 }).catch(() => false)) {
        return true;
      }
    }
    return false;
  }

  private async resolveAndClickConnect(
    page: Page,
    prospect: ProspectRow
  ): Promise<"clicked" | "already_connected" | "not_found"> {
    if (await this.hasMessageButton(page)) {
      return "already_connected";
    }

    const connectBtn = await this.findInScopes(page, (s) => this.findConnectButton(s));
    if (connectBtn) {
      this.emitStatus("INFO", "Clicking Connect button…", prospect);
      await this.safeClick(connectBtn, page);
      return "clicked";
    }

    this.emitStatus("INFO", "Connect not visible — checking More menu…", prospect);
    const moreClicked = await this.openMoreAndConnect(page, prospect);
    if (moreClicked) return "clicked";

    if (await this.hasMessageButton(page)) {
      return "already_connected";
    }

    return "not_found";
  }

  private async findConnectButton(scope: Locator): Promise<Locator | null> {
    const selectors = [
      scope.getByRole("button", { name: /^Connect$/i }),
      scope.getByRole("link", { name: /^Connect$/i }),
      scope.locator('button[aria-label*="Invite"][aria-label*="connect" i]'),
      scope.locator("button").filter({ hasText: /^Connect$/ }),
      scope.locator('a[role="button"]').filter({ hasText: /^Connect$/ }),
    ];

    for (const locator of selectors) {
      const target = locator.first();
      if (await target.isVisible({ timeout: 1000 }).catch(() => false)) {
        return target;
      }
    }
    return null;
  }

  private async dismissOverlays(page: Page): Promise<void> {
    await page.keyboard.press("Escape").catch(() => undefined);
    await sleep(400);
  }

  private async safeClick(locator: Locator, page: Page): Promise<void> {
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    try {
      await locator.click({ timeout: 8000 });
    } catch {
      await locator.click({ force: true });
    }
  }

  private async openMoreAndConnect(
    page: Page,
    prospect: ProspectRow
  ): Promise<boolean> {
    const moreButton = await this.findInScopes(page, (s) => this.findMoreButton(s));

    if (!moreButton) {
      this.emitStatus("WARNING", "More actions button not found.", prospect);
      return false;
    }

    await this.safeClick(moreButton, page);
    await this.actionDelay();

    const menu = page
      .locator(
        '.artdeco-dropdown__content--is-open, [role="menu"], div[aria-hidden="false"].artdeco-dropdown__content'
      )
      .first();

    await menu.waitFor({ state: "visible", timeout: 5000 }).catch(() => undefined);

    let connectItem = await this.findConnectButton(menu);
    if (!connectItem) {
      connectItem = await this.findConnectButton(page.locator('[role="menu"]').first());
    }

    if (connectItem) {
      this.emitStatus("INFO", "Clicking Connect in More menu…", prospect);
      await this.safeClick(connectItem, page);
      return true;
    }

    await page.keyboard.press("Escape").catch(() => undefined);
    this.emitStatus("WARNING", "Connect option not found in More menu.", prospect);
    return false;
  }

  private async completeConnectionNote(
    page: Page,
    message: string,
    prospect: ProspectRow
  ): Promise<boolean> {
    const dialog = page
      .locator('[role="dialog"]:has-text("Add a note"), [role="dialog"]:has-text("invitation"), .send-invite')
      .first();

    const genericDialog = page.locator('[role="dialog"], .artdeco-modal').first();
    const targetDialog = (await dialog.isVisible({ timeout: 3000 }).catch(() => false))
      ? dialog
      : genericDialog;

    await targetDialog.waitFor({ state: "visible", timeout: 12_000 }).catch(() => undefined);

    if (!(await targetDialog.isVisible({ timeout: 2000 }).catch(() => false))) {
      this.emitStatus("WARNING", "Invitation modal did not open after Connect.", prospect);
      return false;
    }

    const isInviteModal = await targetDialog
      .locator('textarea[name="message"], button:has-text("Add a note"), button:has-text("Send invitation")')
      .first()
      .isVisible({ timeout: 2000 })
      .catch(() => false);

    if (!isInviteModal) {
      this.emitStatus("WARNING", "Opened dialog is not a connection invite — skipping.", prospect);
      await this.dismissOverlays(page);
      return false;
    }

    this.emitStatus("INFO", "Invitation modal open — adding note…", prospect);

    const addNote = targetDialog.getByRole("button", { name: /Add a note/i }).first();

    if (await addNote.isVisible({ timeout: 4000 }).catch(() => false)) {
      await this.safeClick(addNote, page);
      await this.actionDelay();
    }

    const textarea = targetDialog
      .locator(
        'textarea[name="message"], textarea#custom-message, textarea.connect-button-send-invite__custom-message'
      )
      .first();

    const hasTextarea = await textarea.isVisible({ timeout: 8000 }).catch(() => false);

    if (!hasTextarea) {
      this.emitStatus("WARNING", "Note textarea not found in invite modal.", prospect);
      await this.dismissOverlays(page);
      return false;
    }

    await textarea.click();
    await textarea.fill("");
    await this.actionDelay();
    const typeDelay = randomInt(this.config.typeDelayMinMs, this.config.typeDelayMaxMs);
    await textarea.pressSequentially(message, { delay: typeDelay });
    this.emitStatus("INFO", `Typed ${message.length}-char note.`, prospect);
    await this.actionDelay();

    const sendButton = targetDialog
      .getByRole("button", { name: /^Send$/i })
      .or(targetDialog.getByRole("button", { name: /^Send invitation$/i }))
      .first();

    if (!(await sendButton.isVisible({ timeout: 5000 }).catch(() => false))) {
      this.emitStatus("WARNING", "Send button not found in invite modal.", prospect);
      return false;
    }

    await this.safeClick(sendButton, page);
    await this.actionDelay();

    const stillOpen = await targetDialog.isVisible({ timeout: 3000 }).catch(() => false);
    if (stillOpen) {
      this.emitStatus("WARNING", "Invite modal still open after Send.", prospect);
      return false;
    }

    return true;
  }

  private async findMessageButton(scope: Locator): Promise<Locator | null> {
    const selectors = [
      scope.getByRole("button", { name: /message/i }),
      scope.getByRole("link", { name: /message/i }),
      scope.locator('button[aria-label*="Message" i]'),
      scope.locator('a[aria-label*="Message" i]'),
      scope.locator('a[href*="/messaging/"]'),
      scope.locator("button").filter({ hasText: /^Message$/ }),
    ];

    for (const locator of selectors) {
      const target = locator.first();
      if (await target.isVisible({ timeout: 1000 }).catch(() => false)) {
        return target;
      }
    }
    return null;
  }

  private async openMoreAndFindMessage(
    page: Page,
    prospect: ProspectRow
  ): Promise<Locator | null> {
    const moreButton = await this.findInScopes(page, (s) => this.findMoreButton(s));

    if (!moreButton) {
      return null;
    }

    await this.safeClick(moreButton, page);
    await this.actionDelay();

    const menu = page
      .locator(
        '.artdeco-dropdown__content--is-open, [role="menu"], div[aria-hidden="false"].artdeco-dropdown__content'
      )
      .first();

    let messageBtn = await this.findMessageButton(menu);
    if (!messageBtn) {
      messageBtn = await this.findMessageButton(page.locator('[role="menu"]').first());
    }

    if (!messageBtn) {
      await page.keyboard.press("Escape").catch(() => undefined);
    }

    return messageBtn;
  }

  private async openMessagingViaLink(
    page: Page,
    prospect: ProspectRow
  ): Promise<boolean> {
    const link = page
      .locator(
        'main a[href*="/messaging/compose"], main a[href*="messaging/thread"], main a[href*="/messaging/"]'
      )
      .first();

    if (!(await link.isVisible({ timeout: 3000 }).catch(() => false))) {
      return false;
    }

    this.emitStatus("INFO", "Opening messaging via profile link…", prospect);
    await this.safeClick(link, page);
    await this.actionDelay();
    return true;
  }

  private async sendDirectMessage(
    page: Page,
    message: string,
    prospect: ProspectRow
  ): Promise<boolean> {
    await this.dismissOverlays(page);

    let messageBtn = await this.findInScopes(page, (s) => this.findMessageButton(s));
    if (!messageBtn) {
      messageBtn = await this.openMoreAndFindMessage(page, prospect);
    }

    if (messageBtn) {
      this.emitStatus("INFO", "Opening message composer…", prospect);
      await this.safeClick(messageBtn, page);
    } else if (!(await this.openMessagingViaLink(page, prospect))) {
      this.emitStatus("WARNING", "Message button not found on profile.", prospect);
      return false;
    }

    await this.actionDelay();

    const messagingPanel = page.locator(
      ".msg-overlay-conversation-bubble, .msg-overlay, [data-test-msg-overlay], .msg-form"
    ).first();
    await messagingPanel.waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);

    const compose = page
      .locator(
        '.msg-form__contenteditable, div.msg-form__msg-content-container div[contenteditable="true"], div[role="textbox"][contenteditable="true"]'
      )
      .first();

    await compose.waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);

    if (!(await compose.isVisible({ timeout: 4000 }).catch(() => false))) {
      this.emitStatus("WARNING", "Message compose box did not open.", prospect);
      return false;
    }

    await compose.click();
    await this.actionDelay();

    const typeDelay = randomInt(this.config.typeDelayMinMs, this.config.typeDelayMaxMs);
    await compose.pressSequentially(message, { delay: typeDelay });
    this.emitStatus("INFO", `Typed ${message.length}-char message.`, prospect);
    await this.actionDelay();

    const sendButton = page
      .locator("button.msg-form__send-button, button.msg-form__send-btn")
      .or(page.getByRole("button", { name: /^Send$/i }))
      .first();

    if (await sendButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await this.safeClick(sendButton, page);
    } else {
      await page.keyboard.press("Enter");
    }

    await this.actionDelay();
    return true;
  }
}

export type { LinkedInOutreachServiceEvents };
