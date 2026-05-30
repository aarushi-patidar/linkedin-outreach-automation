import {
  LINKEDIN_NOTE_MAX_LENGTH,
  type CampaignType,
  type MessageBuildResult,
  type ProspectRow,
} from "./types";
import { sanitizeField } from "./utils";

const TEMPLATES: Record<Exclude<CampaignType, "Custom">, (n: string, c: string) => string> = {
  Discovery: (n, c) =>
    `Hi ${n}, I'm a VIT student researching how early-stage tech teams handle hiring and what's broken in the process. Building a project around this and would love to connect and follow your journey at ${c}!`,
  Sales: (n, c) =>
    `Hi ${n}, noticed ${c} is growing! I help early-stage startups find technical talent and actually have a few vetted candidates that fit your stack. Would love to connect and share a couple of profiles.`,
};

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const sp = slice.lastIndexOf(" ");
  return (sp > max * 0.7 ? slice.slice(0, sp) : slice).trimEnd();
}

export function buildOutreachMessage(prospect: ProspectRow): MessageBuildResult {
  const founderName = sanitizeField(prospect.founder_name ?? "there", 80);
  const companyName = sanitizeField(prospect.company_name, 120);

  let message: string;
  if (prospect.campaign_type === "Custom") {
    message = sanitizeField(prospect.outreach_message ?? "", LINKEDIN_NOTE_MAX_LENGTH);
    if (!message) throw new Error(`Custom message required: ${prospect.linkedin_url}`);
  } else {
    message = TEMPLATES[prospect.campaign_type](founderName, companyName);
  }

  const originalLength = message.length;
  const truncated = originalLength > LINKEDIN_NOTE_MAX_LENGTH;
  if (truncated) message = truncate(message, LINKEDIN_NOTE_MAX_LENGTH);
  return { message, truncated, originalLength };
}
