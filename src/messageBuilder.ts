import {
  LINKEDIN_NOTE_MAX_LENGTH,
  type MessageBuildResult,
  type ProspectRow,
} from "./types";

function discoveryTemplate(founderName: string, companyName: string): string {
  return `Hi ${founderName}, I'm a VIT student researching how early-stage tech teams handle hiring and what's broken in the process. Building a project around this and would love to connect and follow your journey at ${companyName}!`;
}

function salesTemplate(founderName: string, companyName: string): string {
  return `Hi ${founderName}, noticed ${companyName} is growing! I help early-stage startups find technical talent and actually have a few vetted candidates that fit your stack. Would love to connect and share a couple of profiles.`;
}

function truncateToLimit(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  const slice = text.slice(0, maxLength);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > maxLength * 0.7) {
    return slice.slice(0, lastSpace).trimEnd();
  }
  return slice.trimEnd();
}

export function buildOutreachMessage(prospect: ProspectRow): MessageBuildResult {
  const founderName = prospect.founder_name?.trim() || "there";
  const companyName = prospect.company_name.trim();

  let message: string;

  switch (prospect.campaign_type) {
    case "Discovery":
      message = discoveryTemplate(founderName, companyName);
      break;
    case "Sales":
      message = salesTemplate(founderName, companyName);
      break;
    case "Custom": {
      const custom = prospect.outreach_message?.trim();
      if (!custom) {
        throw new Error(
          `outreach_message is required when campaign_type is Custom (${prospect.linkedin_url})`
        );
      }
      message = custom;
      break;
    }
    default:
      throw new Error(`Unknown campaign_type: ${(prospect as ProspectRow).campaign_type}`);
  }

  const originalLength = message.length;
  const truncated = originalLength > LINKEDIN_NOTE_MAX_LENGTH;

  if (truncated) {
    message = truncateToLimit(message, LINKEDIN_NOTE_MAX_LENGTH);
  }

  return { message, truncated, originalLength };
}
