import chalk from "chalk";
import dotenv from "dotenv";
import path from "path";
import { loadProspectsFromCsv } from "./csvLoader";
import { LinkedInOutreachService } from "./LinkedInOutreachService";
import type {
  AuthMode,
  BrowserChannel,
  OutreachStatusCode,
  OutreachStatusEvent,
  ServiceConfig,
} from "./types";

dotenv.config();

const STATUS_COLORS: Record<OutreachStatusCode, (text: string) => string> = {
  SUCCESS: chalk.green,
  MESSAGE_SENT: chalk.green,
  ALREADY_CONNECTED: chalk.yellow,
  SKIP_NO_CONNECT: chalk.yellow,
  RATE_LIMITED: chalk.red.bold,
  AUTH_FAILED: chalk.red.bold,
  ERROR: chalk.red,
  WARNING: chalk.hex("#FFA500"),
  INFO: chalk.cyan,
  PROGRESS: chalk.blue,
  HALTED: chalk.magenta,
};

function logStatus(event: OutreachStatusEvent): void {
  const colorize = STATUS_COLORS[event.code] ?? chalk.white;
  const prefix = colorize(`[${event.code}]`);
  const who = event.prospect?.founder_name || event.prospect?.company_name;
  const suffix = who ? ` ${chalk.gray(`(${who})`)}` : "";
  console.log(`${prefix} ${event.message}${suffix}`);
}

function parseArgs(argv: string[]): { csvPath: string } {
  let csvPath = "./prospects.csv";

  for (const arg of argv) {
    if (arg.startsWith("--csv=")) {
      csvPath = arg.slice("--csv=".length);
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
LinkedIn Outreach — standalone runner

Usage:
  npx ts-node src/index.ts [--csv=./prospects.csv]

Environment (.env):
  AUTH_MODE                 cdp (recommended) | profile | cookies
  CDP_URL                   Chrome DevTools URL (default: http://127.0.0.1:9222)
  LINKEDIN_PROFILE_DIR      Browser profile dir (profile mode)
  LI_AT                     li_at cookie (cookies mode only)
  LINKEDIN_COOKIES_PATH     Full cookie JSON export (cookies mode)
  LINKEDIN_STORAGE_STATE    Playwright storageState JSON
  HEADLESS                  true|false (ignored for profile mode)
  ACTION_DELAY_MIN_MS   Default: 1000
  ACTION_DELAY_MAX_MS   Default: 3000
  PROFILE_DELAY_MIN_MS  Default: 9000
  PROFILE_DELAY_MAX_MS  Default: 9000
  TYPE_DELAY_MIN_MS     Default: 50
  TYPE_DELAY_MAX_MS     Default: 150
  BROWSER_CHANNEL       chrome|msedge — use installed browser (skips playwright install)
`);
      process.exit(0);
    }
  }

  return { csvPath };
}

function parseAuthMode(): AuthMode {
  const raw = process.env.AUTH_MODE?.trim().toLowerCase();
  if (raw === "cookies") return "cookies";
  if (raw === "profile") return "profile";
  return "cdp";
}

function buildConfigFromEnv(): ServiceConfig {
  const authMode = parseAuthMode();
  const profileDir =
    process.env.LINKEDIN_PROFILE_DIR?.trim() || "./.linkedin-profile";
  const cdpUrl = process.env.CDP_URL?.trim() || "http://127.0.0.1:9222";
  const liAt = process.env.LI_AT?.trim();
  const cookiesPath = process.env.LINKEDIN_COOKIES_PATH?.trim();
  const storageStatePath = process.env.LINKEDIN_STORAGE_STATE?.trim();

  if (authMode === "cookies" && !liAt && !cookiesPath && !storageStatePath) {
    console.error(
      chalk.red(
        "[AUTH_FAILED] cookies mode requires LI_AT, LINKEDIN_COOKIES_PATH, or LINKEDIN_STORAGE_STATE"
      )
    );
    process.exit(1);
  }

  const bool = (v: string | undefined, fallback: boolean) =>
    v === undefined ? fallback : v.toLowerCase() === "true";

  const num = (v: string | undefined, fallback: number) => {
    const n = v !== undefined ? Number(v) : fallback;
    return Number.isFinite(n) ? n : fallback;
  };

  const channel = process.env.BROWSER_CHANNEL?.trim().toLowerCase();
  const browserChannel: BrowserChannel | undefined =
    channel === "chrome" || channel === "msedge" ? channel : undefined;

  return {
    authMode,
    cdpUrl,
    profileDir,
    manualLoginTimeoutMs: num(process.env.MANUAL_LOGIN_TIMEOUT_MS, 300_000),
    liAtCookie: liAt,
    cookiesPath,
    storageStatePath,
    headless: bool(process.env.HEADLESS, false),
    browserChannel,
    actionDelayMinMs: num(process.env.ACTION_DELAY_MIN_MS, 1000),
    actionDelayMaxMs: num(process.env.ACTION_DELAY_MAX_MS, 3000),
    profileDelayMinMs: num(process.env.PROFILE_DELAY_MIN_MS, 9_000),
    profileDelayMaxMs: num(process.env.PROFILE_DELAY_MAX_MS, 9_000),
    typeDelayMinMs: num(process.env.TYPE_DELAY_MIN_MS, 50),
    typeDelayMaxMs: num(process.env.TYPE_DELAY_MAX_MS, 150),
  };
}

async function main(): Promise<void> {
  const { csvPath } = parseArgs(process.argv.slice(2));
  const resolvedCsv = path.resolve(csvPath);

  console.log(chalk.bold("\nLinkedIn Outreach Automation\n"));
  console.log(chalk.gray(`CSV: ${resolvedCsv}\n`));

  const prospects = await loadProspectsFromCsv(resolvedCsv);
  if (prospects.length === 0) {
    console.error(chalk.red("[ERROR] No valid rows found in CSV."));
    process.exit(1);
  }

  console.log(chalk.cyan(`[INFO] Loaded ${prospects.length} prospect(s).\n`));

  const config = buildConfigFromEnv();
  const authLabel =
    config.authMode === "cdp"
      ? `cdp (${config.cdpUrl})`
      : config.authMode === "profile"
        ? `profile (${path.resolve(config.profileDir!)})`
        : "cookies";
  console.log(chalk.cyan(`[INFO] Auth mode: ${authLabel}\n`));

  const service = new LinkedInOutreachService(config);

  service.on("status", logStatus);
  service.on("progress", ({ current, total, prospect }) => {
    const label = prospect.founder_name || prospect.company_name;
    console.log(
      chalk.blue(`[PROGRESS] ${current}/${total}`) + chalk.gray(` — ${label}`)
    );
  });

  let exitCode = 0;

  try {
    await service.initialize();
    const summary = await service.run(prospects);

    console.log(chalk.bold("\n--- Run summary ---"));
    console.log(`  Total:              ${summary.total}`);
    console.log(chalk.green(`  Connections sent:   ${summary.success}`));
    console.log(chalk.green(`  Messages sent:      ${summary.messagesSent}`));
    console.log(chalk.yellow(`  Already connected:  ${summary.alreadyConnected}`));
    console.log(chalk.yellow(`  Skipped:            ${summary.skipped}`));
    console.log(chalk.red(`  Failed:             ${summary.failed}`));
    if (summary.halted) {
      console.log(chalk.magenta(`  Halted:             yes (${summary.haltReason ?? "unknown"})`));
      exitCode = 2;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red.bold(`[ERROR] ${message}`));
    exitCode = 1;
  } finally {
    await service.shutdown();
  }

  process.exit(exitCode);
}

main();
