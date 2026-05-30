import fs from "fs";
import path from "path";
import csv from "csv-parser";
import { CAMPAIGN_TYPES, type CampaignType, type ProspectRow } from "./types";
import { sanitizeField, sanitizeUrl } from "./utils";

const MAX_ROWS = 500;

function normalizeHeader(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, "_");
}

function parseCampaignType(value: string, rowIndex: number): CampaignType {
  const normalized = value.trim();
  if (!CAMPAIGN_TYPES.includes(normalized as CampaignType)) {
    throw new Error(`Row ${rowIndex}: invalid campaign_type "${value}"`);
  }
  return normalized as CampaignType;
}

function validateRow(row: ProspectRow, rowIndex: number): void {
  if (!row.company_name) throw new Error(`Row ${rowIndex}: company_name required`);
  if (!row.linkedin_url) throw new Error(`Row ${rowIndex}: linkedin_url required`);
  row.linkedin_url = sanitizeUrl(row.linkedin_url);
  if (row.campaign_type === "Custom" && !row.outreach_message) {
    throw new Error(`Row ${rowIndex}: outreach_message required for Custom`);
  }
}

export function loadProspectsFromCsv(filePath: string): Promise<ProspectRow[]> {
  const resolved = path.resolve(filePath);
  const root = path.resolve(".");
  if (!resolved.startsWith(root)) throw new Error("CSV path outside project");
  if (!fs.existsSync(resolved)) throw new Error(`CSV not found: ${resolved}`);

  return new Promise((resolve, reject) => {
    const rows: ProspectRow[] = [];
    let rowIndex = 0;

    fs.createReadStream(resolved)
      .pipe(csv({ mapHeaders: ({ header }) => normalizeHeader(header) }))
      .on("data", (raw: Record<string, string>) => {
        rowIndex += 1;
        if (rowIndex > MAX_ROWS) {
          reject(new Error(`CSV exceeds ${MAX_ROWS} rows`));
          return;
        }
        try {
          const prospect: ProspectRow = {
            founder_name: raw.founder_name ? sanitizeField(raw.founder_name, 120) : undefined,
            company_name: sanitizeField(raw.company_name ?? "", 200),
            linkedin_url: sanitizeField(raw.linkedin_url ?? "", 300),
            campaign_type: parseCampaignType(raw.campaign_type ?? "", rowIndex),
            outreach_message: raw.outreach_message
              ? sanitizeField(raw.outreach_message, 300)
              : undefined,
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
