import chalk from "chalk";
import dotenv from "dotenv";
import path from "path";
import { loadProspectsFromCsv } from "./csvLoader";
import { LinkedInOutreachService } from "./LinkedInOutreachService";
import type { OutreachStatusCode, OutreachStatusEvent } from "./types";

const CSV = process.argv.find((a) => a.startsWith("--csv="))?.slice(6) ?? "./prospects.csv";

dotenv.config();

const COLORS: Record<OutreachStatusCode, (t: string) => string> = {
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

function log(e: OutreachStatusEvent): void {
  const c = COLORS[e.code] ?? chalk.white;
  const who = e.prospect?.founder_name || e.prospect?.company_name;
  console.log(`${c(`[${e.code}]`)} ${e.message}${who ? chalk.gray(` (${who})`) : ""}`);
}

async function main(): Promise<void> {
  const prospects = await loadProspectsFromCsv(path.resolve(CSV));
  if (!prospects.length) process.exit(1);

  const service = new LinkedInOutreachService({
    profileDir: process.env.LINKEDIN_PROFILE_DIR ?? "./.linkedin-profile",
    headless: process.env.HEADLESS !== "false",
    browserChannel: process.env.BROWSER_CHANNEL === "msedge" ? "msedge" : "chrome",
  });

  service.on("status", log);
  service.on("progress", ({ current, total, prospect }) =>
    console.log(chalk.blue(`[PROGRESS] ${current}/${total}`) + chalk.gray(` — ${prospect.founder_name || prospect.company_name}`))
  );

  try {
    await service.initialize();
    const s = await service.run(prospects, { continueOnError: true });
    console.log(`\nTotal:${s.total} Conn:${s.success} Msg:${s.messagesSent} Skip:${s.skipped} Fail:${s.failed}`);
    process.exit(s.failed || s.halted ? 1 : 0);
  } catch (e) {
    console.error(chalk.red(String(e instanceof Error ? e.message : e)));
    process.exit(1);
  } finally {
    await service.shutdown();
  }
}

main();
