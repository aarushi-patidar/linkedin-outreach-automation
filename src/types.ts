import type { EventEmitter } from "events";

export type CampaignType = "Discovery" | "Sales" | "Custom";

export type OutreachStatusCode =
  | "SUCCESS"
  | "MESSAGE_SENT"
  | "ALREADY_CONNECTED"
  | "SKIP_NO_CONNECT"
  | "RATE_LIMITED"
  | "AUTH_FAILED"
  | "ERROR"
  | "WARNING"
  | "INFO"
  | "PROGRESS"
  | "HALTED";

export interface ProspectRow {
  founder_name?: string;
  company_name: string;
  linkedin_url: string;
  campaign_type: CampaignType;
  outreach_message?: string;
}

export interface MessageBuildResult {
  message: string;
  truncated: boolean;
  originalLength: number;
}

export type BrowserChannel = "chrome" | "msedge";

export type AuthMode = "cdp" | "profile" | "cookies";

export interface ServiceConfig {
  /** cdp = attach to your Chrome (most reliable); profile = Playwright profile dir; cookies = inject li_at */
  authMode?: AuthMode;
  /** Chrome DevTools endpoint when authMode is cdp (default http://127.0.0.1:9222). */
  cdpUrl?: string;
  /** Directory for persistent Chrome profile (used when authMode is profile). */
  profileDir?: string;
  /** How long to wait for manual login on first profile run (ms). */
  manualLoginTimeoutMs?: number;
  liAtCookie?: string;
  /** JSON file with all linkedin.com cookies (Cookie-Editor export). */
  cookiesPath?: string;
  /** Playwright storageState JSON saved from an authenticated session. */
  storageStatePath?: string;
  headless?: boolean;
  /** Use installed Chrome/Edge instead of Playwright-bundled Chromium. */
  browserChannel?: BrowserChannel;
  actionDelayMinMs?: number;
  actionDelayMaxMs?: number;
  profileDelayMinMs?: number;
  profileDelayMaxMs?: number;
  typeDelayMinMs?: number;
  typeDelayMaxMs?: number;
}

export interface RunOptions {
  /** Stop after N successful sends (optional cap for testing). */
  maxSuccesses?: number;
  /** Continue on per-row errors (default true). */
  continueOnError?: boolean;
}

export interface RunSummary {
  total: number;
  success: number;
  messagesSent: number;
  alreadyConnected: number;
  skipped: number;
  failed: number;
  halted: boolean;
  haltReason?: string;
}

export interface OutreachStatusEvent {
  code: OutreachStatusCode;
  message: string;
  prospect?: ProspectRow;
  error?: Error;
  meta?: Record<string, unknown>;
}

export interface OutreachProgressEvent {
  current: number;
  total: number;
  prospect: ProspectRow;
}

export interface LinkedInOutreachServiceEvents {
  status: (event: OutreachStatusEvent) => void;
  progress: (event: OutreachProgressEvent) => void;
  complete: (summary: RunSummary) => void;
  error: (error: Error) => void;
}

export type LinkedInOutreachEmitter = EventEmitter & {
  on<U extends keyof LinkedInOutreachServiceEvents>(
    event: U,
    listener: LinkedInOutreachServiceEvents[U]
  ): LinkedInOutreachEmitter;
  emit<U extends keyof LinkedInOutreachServiceEvents>(
    event: U,
    ...args: Parameters<LinkedInOutreachServiceEvents[U]>
  ): boolean;
};

export const LINKEDIN_NOTE_MAX_LENGTH = 300;

export const CAMPAIGN_TYPES: readonly CampaignType[] = [
  "Discovery",
  "Sales",
  "Custom",
] as const;
