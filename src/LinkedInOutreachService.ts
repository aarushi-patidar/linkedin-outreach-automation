import { EventEmitter } from "events";
import path from "path";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import { buildOutreachMessage } from "./messageBuilder";
import type {
  LinkedInOutreachServiceEvents,
  OutreachStatusEvent,
  ProspectRow,
  RunOptions,
  RunSummary,
  ServiceConfig,
} from "./types";
import { DELAYS } from "./types";
import { sleep, STEALTH_LAUNCH_OPTIONS } from "./utils";

const FEED = "https://www.linkedin.com/feed/";
const VOYAGER = "https://www.linkedin.com/voyager/api/me";

type Result = "success" | "message_sent" | "already_connected" | "skipped" | "failed";
type ProfileState = "pending" | "connected" | "not_connected" | "unknown";

export class LinkedInOutreachService extends EventEmitter {
  private context: BrowserContext | null = null;
  private workPage: Page | null = null;
  private readonly profileDir: string;
  private readonly headless: boolean;
  private readonly browserChannel: ServiceConfig["browserChannel"];

  constructor(config: ServiceConfig = {}) {
    super();
    this.profileDir = path.resolve(config.profileDir ?? "./.linkedin-profile");
    this.headless = config.headless ?? true;
    this.browserChannel = config.browserChannel ?? "chrome";
  }

  emitStatus(code: OutreachStatusEvent["code"], message: string, prospect?: ProspectRow): void {
    this.emit("status", { code, message, prospect });
  }

  async initialize(): Promise<void> {
    await this.launchContext(this.headless);

    if (await this.verifySession()) {
      this.emitStatus("INFO", "Session ready.");
      return;
    }

    if (this.headless) {
      await this.context?.close().catch(() => undefined);
      this.context = null;
      this.emitStatus("INFO", "Login required — opening browser…");
      await this.launchContext(false);
    }

    await this.waitForManualLogin();
    this.emitStatus("INFO", "Login OK — starting outreach now.");
  }

  private async launchContext(headless: boolean): Promise<void> {
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      headless,
      channel: this.browserChannel,
      viewport: { width: 1280, height: 720 },
      locale: "en-US",
      ...STEALTH_LAUNCH_OPTIONS,
    });
  }

  private async waitForManualLogin(): Promise<void> {
    const page = this.context!.pages()[0] ?? (await this.context!.newPage());
    this.workPage = page;
    await page.goto(FEED, { waitUntil: "domcontentloaded", timeout: 60_000 });

    this.emitStatus("INFO", "Log into LinkedIn — outreach starts automatically when detected.");

    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      if (await this.verifySession() || (await this.isLoggedInOnPage(page))) {
        return;
      }
      await sleep(1000);
    }

    this.emitStatus("AUTH_FAILED", "Login timed out after 5 minutes.");
    throw new Error("LinkedIn manual login timed out");
  }

  private async isLoggedInOnPage(page: Page): Promise<boolean> {
    if (page.isClosed()) return false;
    const url = page.url();
    if (url.includes("/login") || url.includes("flagship-web/login")) return false;
    if (url.includes("/feed") || url.includes("/mynetwork")) return true;
    return page.locator('nav[aria-label="Primary"], .global-nav').first().isVisible({ timeout: 500 }).catch(() => false);
  }

  async run(prospects: ProspectRow[], options: RunOptions = {}): Promise<RunSummary> {
    if (!this.context) throw new Error("Call initialize() first");
    const summary: RunSummary = {
      total: prospects.length,
      success: 0,
      messagesSent: 0,
      alreadyConnected: 0,
      skipped: 0,
      failed: 0,
      halted: false,
    };

    for (let i = 0; i < prospects.length; i++) {
      const p = prospects[i]!;
      this.emit("progress", { current: i + 1, total: prospects.length, prospect: p });
      const name = p.founder_name || p.company_name;

      try {
        const r = await this.processProspect(p);
        if (r === "success") {
          summary.success++;
          this.emitStatus("SUCCESS", `Connection sent to ${name}`, p);
        } else if (r === "message_sent") {
          summary.messagesSent++;
          this.emitStatus("MESSAGE_SENT", `Message sent to ${name}`, p);
        } else if (r === "already_connected") {
          summary.alreadyConnected++;
          this.emitStatus("ALREADY_CONNECTED", `Message failed for ${name}`, p);
        } else if (r === "skipped") {
          summary.skipped++;
          this.emitStatus("SKIP_NO_CONNECT", `Skipped (pending) ${name}`, p);
        } else {
          summary.failed++;
          this.emitStatus("ERROR", `Failed ${name}`, p);
        }
        if (options.maxSuccesses && summary.success + summary.messagesSent >= options.maxSuccesses) break;
      } catch (e) {
        summary.failed++;
        this.emitStatus("ERROR", `${name}: ${e instanceof Error ? e.message : e}`, p);
        if (!options.continueOnError) break;
      }

      if (i < prospects.length - 1) {
        this.emitStatus("INFO", `Wait ${DELAYS.nextProfile / 1000}s…`, p);
        await sleep(DELAYS.nextProfile);
      }
    }
    this.emit("complete", summary);
    return summary;
  }

  async shutdown(): Promise<void> {
    this.workPage = null;
    await this.context?.close().catch(() => undefined);
    this.context = null;
  }

  private async verifySession(): Promise<boolean> {
    if (!this.context) return false;
    try {
      const r = await this.context.request.get(VOYAGER, {
        failOnStatusCode: false,
        timeout: 15_000,
        headers: { Accept: "application/vnd.linkedin.normalized+json+2.1" },
      });
      return r.status() === 200;
    } catch {
      return false;
    }
  }

  private async getWorkPage(): Promise<Page> {
    if (!this.context) throw new Error("Browser not initialized — call initialize() first");

    if (this.workPage && !this.workPage.isClosed()) {
      try {
        await this.workPage.title();
        return this.workPage;
      } catch {
        this.workPage = null;
      }
    }

    const open = this.context.pages().find((p) => !p.isClosed());
    if (open) {
      this.workPage = open;
      return open;
    }

    this.workPage = await this.context.newPage();
    return this.workPage;
  }

  private profileScopes(page: Page): Locator[] {
    const main = page.locator("main").first();
    return [
      main.locator(".pv-top-card"),
      main.locator(".pvs-profile-actions"),
      main.locator(".pv-top-card-v2-ctas"),
      main.locator(".ph5").first(),
      main.locator("section.artdeco-card").first(),
      main,
    ];
  }

  private async findInProfile(page: Page, fn: (scope: Locator) => Promise<Locator | null>): Promise<Locator | null> {
    for (const scope of this.profileScopes(page)) {
      if (!(await scope.count())) continue;
      const found = await fn(scope);
      if (found && (await found.isVisible().catch(() => false))) return found;
    }
    return null;
  }

  private async findConnectButton(page: Page): Promise<Locator | null> {
    return this.findInProfile(page, async (scope) => {
      const byRole = scope.getByRole("button", { name: /^Connect$/i }).first();
      if (await byRole.isVisible().catch(() => false)) return byRole;

      const byLabel = scope.locator('button[aria-label*="Invite"][aria-label*="connect" i]').first();
      if (await byLabel.isVisible().catch(() => false)) return byLabel;

      const byText = scope.locator("button").filter({ hasText: /^Connect$/ }).first();
      return (await byText.isVisible().catch(() => false)) ? byText : null;
    });
  }

  private async findMessageButton(page: Page): Promise<Locator | null> {
    return this.findInProfile(page, async (scope) => {
      const byRole = scope.getByRole("button", { name: /^Message$/i }).first();
      if (await byRole.isVisible().catch(() => false)) return byRole;

      const byLabel = scope
        .locator('button[aria-label*="Message" i]:not([aria-label*="messages" i])')
        .first();
      if (await byLabel.isVisible().catch(() => false)) return byLabel;

      const byText = scope.locator("button").filter({ hasText: /^Message$/ }).first();
      return (await byText.isVisible().catch(() => false)) ? byText : null;
    });
  }

  private async findPendingButton(page: Page): Promise<Locator | null> {
    return this.findInProfile(page, async (scope) => {
      const byRole = scope.getByRole("button", { name: /^Pending$/i }).first();
      if (await byRole.isVisible().catch(() => false)) return byRole;

      const byText = scope.locator("button").filter({ hasText: /^Pending$/ }).first();
      return (await byText.isVisible().catch(() => false)) ? byText : null;
    });
  }

  private async findMoreButton(page: Page): Promise<Locator | null> {
    return this.findInProfile(page, async (scope) => {
      const byRole = scope.getByRole("button", { name: /more/i }).first();
      if (await byRole.isVisible().catch(() => false)) return byRole;

      const byLabel = scope.locator('button[aria-label*="More actions" i]').first();
      return (await byLabel.isVisible().catch(() => false)) ? byLabel : null;
    });
  }

  private async scanProfileButtons(page: Page): Promise<{ connect: boolean; message: boolean; pending: boolean }> {
    return {
      connect: (await this.findConnectButton(page)) !== null,
      message: (await this.findMessageButton(page)) !== null,
      pending: (await this.findPendingButton(page)) !== null,
    };
  }

  private async processProspect(prospect: ProspectRow): Promise<Result> {
    const page = await this.getWorkPage();
    const { message, truncated } = buildOutreachMessage(prospect);
    if (truncated) this.emitStatus("WARNING", "Message truncated", prospect);

    await this.dismissOverlays(page);
    await page.goto(prospect.linkedin_url, { waitUntil: "load", timeout: 60_000 });
    await page.bringToFront();
    await this.waitProfile(page);
    await this.scrollProfileTop(page);
    await sleep(DELAYS.openProfile);

    const state = await this.getProfileState(page);

    if (state === "pending") {
      this.emitStatus("INFO", "Pending — skipping", prospect);
      return "skipped";
    }

    if (state === "connected") {
      this.emitStatus("INFO", "Connected — clicking Message", prospect);
      return (await this.sendMessageFromProfile(page, message, prospect)) ? "message_sent" : "failed";
    }

    if (state === "not_connected") {
      this.emitStatus("INFO", "Not connected — clicking Connect", prospect);
      if (!(await this.clickProfileConnect(page, prospect))) {
        this.emitStatus("ERROR", "Connect button not found on profile", prospect);
        return "failed";
      }
      await sleep(DELAYS.connectFlow);
      if (await this.sendInviteNote(page, message, prospect)) return "success";
      this.emitStatus("ERROR", "Invite note/send failed", prospect);
      return "failed";
    }

    this.emitStatus("WARNING", "Could not determine connection status", prospect);
    const buttons = await this.scanProfileButtons(page);
    this.emitStatus(
      "INFO",
      `Profile buttons — connect:${buttons.connect} message:${buttons.message} pending:${buttons.pending}`,
      prospect
    );
    return "failed";
  }

  private async getProfileState(page: Page): Promise<ProfileState> {
    const buttons = await this.scanProfileButtons(page);

    if (buttons.pending) return "pending";
    if (buttons.message && !buttons.connect) return "connected";
    if (buttons.connect) return "not_connected";

    const moreSignal = await this.inspectMoreMenu(page);
    if (moreSignal === "remove_connection") return "connected";
    if (moreSignal === "pending") return "pending";
    if (moreSignal === "connect") return "not_connected";

    return "unknown";
  }

  private async inspectMoreMenu(page: Page): Promise<"remove_connection" | "connect" | "pending" | "none"> {
    const more = await this.findMoreButton(page);
    if (!more) return "none";

    await more.click();
    await sleep(500);

    const items = page.locator(
      '[role="menu"] button, [role="menuitem"], .artdeco-dropdown__content button, .artdeco-dropdown__content span'
    );

    if (await items.filter({ hasText: /remove.*connection/i }).first().isVisible({ timeout: 2000 }).catch(() => false)) {
      await this.closeMoreMenu(page);
      return "remove_connection";
    }
    if (await items.filter({ hasText: /^Pending$/i }).first().isVisible({ timeout: 1000 }).catch(() => false)) {
      await this.closeMoreMenu(page);
      return "pending";
    }
    if (await items.filter({ hasText: /^Connect$/i }).first().isVisible({ timeout: 1000 }).catch(() => false)) {
      await this.closeMoreMenu(page);
      return "connect";
    }
    if (
      await items
        .locator('button[aria-label*="Invite"][aria-label*="connect" i]')
        .first()
        .isVisible({ timeout: 1000 })
        .catch(() => false)
    ) {
      await this.closeMoreMenu(page);
      return "connect";
    }

    await this.closeMoreMenu(page);
    return "none";
  }

  private async clickProfileConnect(page: Page, prospect: ProspectRow): Promise<boolean> {
    await this.scrollProfileTop(page);

    const connect = await this.findConnectButton(page);
    if (connect) {
      this.emitStatus("INFO", "Clicking Connect on profile", prospect);
      await connect.scrollIntoViewIfNeeded();
      await connect.click();
      return true;
    }

    return this.clickFromMoreMenu(page, /^Connect$/i);
  }

  private async clickProfileMessage(page: Page): Promise<boolean> {
    await this.scrollProfileTop(page);

    const message = await this.findMessageButton(page);
    if (message) {
      await message.scrollIntoViewIfNeeded();
      await message.click();
      return true;
    }

    return this.clickFromMoreMenu(page, /^Message$/i);
  }

  private async clickFromMoreMenu(page: Page, label: RegExp): Promise<boolean> {
    const more = await this.findMoreButton(page);
    if (!more) return false;

    await more.click();
    await sleep(500);

    const item = page
      .locator('[role="menu"] button, [role="menuitem"], .artdeco-dropdown__content button')
      .filter({ hasText: label })
      .first();

    if (!(await item.isVisible({ timeout: 4000 }).catch(() => false))) {
      await this.closeMoreMenu(page);
      return false;
    }

    await item.click();
    return true;
  }

  private async sendInviteNote(page: Page, message: string, prospect: ProspectRow): Promise<boolean> {
    if (await this.isPendingOnProfile(page)) return true;

    const addNote = page.getByRole("button", { name: /add a note/i }).first();
    if (await addNote.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await addNote.click();
      await sleep(600);
    }

    const textbox = page
      .getByRole("textbox", { name: /message|note|invitation/i })
      .or(page.locator('textarea[name="message"], textarea#custom-message, textarea'))
      .first();

    if (!(await textbox.waitFor({ state: "visible", timeout: 10_000 }).catch(() => null))) {
      if (await this.isPendingOnProfile(page)) return true;
      this.emitStatus("ERROR", "Invite textbox not found", prospect);
      return false;
    }

    await textbox.click();
    await textbox.fill(message);

    const send = page
      .getByRole("button", { name: /send invitation/i })
      .or(page.locator('button[aria-label*="Send invitation" i]'))
      .first();

    if (!(await send.isVisible({ timeout: 8000 }).catch(() => false))) {
      this.emitStatus("ERROR", "Send invitation button not found", prospect);
      return false;
    }

    await send.click();
    await sleep(2000);

    const sent =
      (await this.isPendingOnProfile(page)) ||
      !(await page.locator('[role="dialog"], .artdeco-modal').first().isVisible().catch(() => false));

    await this.dismissOverlays(page);
    return sent;
  }

  private async sendMessageFromProfile(page: Page, message: string, prospect: ProspectRow): Promise<boolean> {
    if (!(await this.clickProfileMessage(page))) {
      this.emitStatus("ERROR", "Message button not found on profile", prospect);
      return false;
    }

    await sleep(1500);

    const compose = page
      .locator(
        '.msg-form__contenteditable[contenteditable="true"], div.msg-form__contenteditable, div[contenteditable="true"][role="textbox"]'
      )
      .first();

    if (!(await compose.waitFor({ state: "visible", timeout: 12_000 }).catch(() => null))) {
      this.emitStatus("ERROR", "Message compose box not found", prospect);
      return false;
    }

    await compose.click();
    await compose.evaluate((el, value) => {
      const node = el as { focus(): void; innerText: string; dispatchEvent(e: Event): boolean };
      node.focus();
      node.innerText = value;
      node.dispatchEvent(new Event("input", { bubbles: true }));
    }, message);

    const send = page
      .locator('button.msg-form__send-button:not([disabled]), button[aria-label="Send"]:not([disabled])')
      .first();

    if (await send.isVisible({ timeout: 5000 }).catch(() => false)) {
      await send.click();
    } else {
      await page.keyboard.press("Control+Enter");
    }

    await sleep(DELAYS.messageConnected);
    await this.dismissOverlays(page);
    return true;
  }

  private async isPendingOnProfile(page: Page): Promise<boolean> {
    return (await this.findPendingButton(page)) !== null;
  }

  private async closeMoreMenu(page: Page): Promise<void> {
    if (page.isClosed()) return;
    await page.keyboard.press("Escape").catch(() => undefined);
    await sleep(200);
  }

  private async dismissOverlays(page: Page): Promise<void> {
    if (page.isClosed()) return;
    await page.keyboard.press("Escape").catch(() => undefined);
    await sleep(150);
    const dismiss = page.locator('button[aria-label="Dismiss"], button.artdeco-modal__dismiss').first();
    if (await dismiss.isVisible({ timeout: 400 }).catch(() => false)) {
      await dismiss.click().catch(() => undefined);
    }
  }

  private async scrollProfileTop(page: Page): Promise<void> {
    if (page.isClosed()) return;
    await page.locator("main").first().scrollIntoViewIfNeeded().catch(() => undefined);
    await page.keyboard.press("Home").catch(() => undefined);
  }

  private async waitProfile(page: Page): Promise<void> {
    await page.locator("main h1, .pv-top-card").first().waitFor({ timeout: 20_000 }).catch(() => undefined);

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const buttons = await this.scanProfileButtons(page);
      if (buttons.connect || buttons.message || buttons.pending) return;
      if (await this.findMoreButton(page)) return;
      await sleep(500);
    }
  }
}

export type { LinkedInOutreachServiceEvents };
