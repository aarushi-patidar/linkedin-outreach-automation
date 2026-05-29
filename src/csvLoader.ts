import fs from "fs";
import path from "path";
import csv from "csv-parser";
import {
  CAMPAIGN_TYPES,
  type CampaignType,
  type ProspectRow,
} from "./types";

function normalizeHeader(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, "_");
}

function parseCampaignType(value: string, rowIndex: number): CampaignType {
  const normalized = value.trim();
  if (!CAMPAIGN_TYPES.includes(normalized as CampaignType)) {
    throw new Error(
      `Row ${rowIndex}: invalid campaign_type "${value}". Must be Discovery, Sales, or Custom.`
    );
  }
  return normalized as CampaignType;
}

function validateRow(row: ProspectRow, rowIndex: number): void {
  if (!row.company_name?.trim()) {
    throw new Error(`Row ${rowIndex}: company_name is required.`);
  }
  if (!row.linkedin_url?.trim()) {
    throw new Error(`Row ${rowIndex}: linkedin_url is required.`);
  }
  if (!row.linkedin_url.includes("linkedin.com")) {
    throw new Error(`Row ${rowIndex}: linkedin_url must be a LinkedIn URL.`);
  }
  if (row.campaign_type === "Custom" && !row.outreach_message?.trim()) {
    throw new Error(
      `Row ${rowIndex}: outreach_message is required when campaign_type is Custom.`
    );
  }
}

export function loadProspectsFromCsv(filePath: string): Promise<ProspectRow[]> {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`CSV file not found: ${resolved}`);
  }

  return new Promise((resolve, reject) => {
    const rows: ProspectRow[] = [];
    let rowIndex = 0;

    fs.createReadStream(resolved)
      .pipe(csv({ mapHeaders: ({ header }) => normalizeHeader(header) }))
      .on("data", (raw: Record<string, string>) => {
        rowIndex += 1;
        try {
          const prospect: ProspectRow = {
            founder_name: raw.founder_name?.trim() || undefined,
            company_name: raw.company_name?.trim() ?? "",
            linkedin_url: raw.linkedin_url?.trim() ?? "",
            campaign_type: parseCampaignType(raw.campaign_type ?? "", rowIndex),
            outreach_message: raw.outreach_message?.trim() || undefined,
          };
          validateRow(prospect, rowIndex);
          rows.push(prospect);
        } catch (err) {
          reject(err);
        }
      })
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
}
