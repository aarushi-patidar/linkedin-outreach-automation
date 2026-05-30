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

export interface ServiceConfig {
  profileDir?: string;
  headless?: boolean;
  browserChannel?: BrowserChannel;
}

export interface RunOptions {
  maxSuccesses?: number;
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

export const LINKEDIN_NOTE_MAX_LENGTH = 300;

export const CAMPAIGN_TYPES: readonly CampaignType[] = [
  "Discovery",
  "Sales",
  "Custom",
] as const;

export const DELAYS = {
  openProfile: 3_000,
  connectFlow: 4_000,
  messageConnected: 2_500,
  nextProfile: 5_000,
} as const;
