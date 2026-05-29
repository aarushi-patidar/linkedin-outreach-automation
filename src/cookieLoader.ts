import fs from "fs";
import path from "path";
import type { Cookie } from "playwright";

type RawCookie = Record<string, unknown>;

function normalizeSameSite(value: unknown): "Strict" | "Lax" | "None" | undefined {
  if (value === "Strict" || value === "Lax" || value === "None") return value;
  if (value === "no_restriction") return "None";
  if (value === "lax") return "Lax";
  if (value === "strict") return "Strict";
  return undefined;
}

function normalizeCookie(raw: RawCookie): Cookie | null {
  const name = raw.name;
  const value = raw.value;
  if (typeof name !== "string" || typeof value !== "string" || !name) {
    return null;
  }

  const domain =
    typeof raw.domain === "string" && raw.domain.includes("linkedin")
      ? raw.domain
      : ".linkedin.com";

  const expires =
    typeof raw.expires === "number"
      ? raw.expires
      : typeof raw.expirationDate === "number"
        ? raw.expirationDate
        : undefined;

  return {
    name,
    value,
    domain,
    path: typeof raw.path === "string" ? raw.path : "/",
    httpOnly: typeof raw.httpOnly === "boolean" ? raw.httpOnly : true,
    secure: typeof raw.secure === "boolean" ? raw.secure : true,
    sameSite: normalizeSameSite(raw.sameSite) ?? "Lax",
    expires: expires ?? -1,
  };
}

function detectInvalidExportFormat(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.data === "string" && "version" in obj) {
    return (
      "linkedin-cookies.json is in Hot Cleaner Cookie Editor format (encrypted blob), not a plain cookie list. " +
      "Re-export from linkedin.com using Cookie-Editor → Export → JSON. " +
      "The file must start with [ and contain objects with name/value fields. " +
      "Or remove LINKEDIN_COOKIES_PATH from .env to use LI_AT only."
    );
  }

  return null;
}

function parseCookieArray(raw: unknown): Cookie[] {
  const invalidFormat = detectInvalidExportFormat(raw);
  if (invalidFormat) {
    throw new Error(invalidFormat);
  }

  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "object" &&
        raw !== null &&
        Array.isArray((raw as { cookies?: unknown }).cookies)
      ? (raw as { cookies: RawCookie[] }).cookies
      : null;

  if (!list) {
    throw new Error(
      "Cookie file must be a JSON array like [{\"name\":\"li_at\",\"value\":\"...\"}, ...]. " +
        "Export from linkedin.com via Cookie-Editor (Export → JSON), not Hot Cleaner."
    );
  }

  return list
    .map((item) => normalizeCookie(item as RawCookie))
    .filter((cookie): cookie is Cookie => cookie !== null);
}

export function loadCookiesFromFile(filePath: string): Cookie[] {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Cookie file not found: ${resolved}`);
  }

  const raw = JSON.parse(fs.readFileSync(resolved, "utf-8")) as unknown;
  const cookies = parseCookieArray(raw);
  if (cookies.length === 0) {
    throw new Error(`No LinkedIn cookies found in ${resolved}`);
  }
  return cookies;
}

export function buildLiAtCookie(liAt: string): Cookie {
  return {
    name: "li_at",
    value: liAt.trim(),
    domain: ".linkedin.com",
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    expires: -1,
  };
}

export function resolveSessionCookies(options: {
  liAtCookie?: string;
  cookiesPath?: string;
}): Cookie[] {
  if (options.cookiesPath) {
    try {
      const fromFile = loadCookiesFromFile(options.cookiesPath);
      if (options.liAtCookie?.trim()) {
        const withoutLiAt = fromFile.filter((c) => c.name !== "li_at");
        return [...withoutLiAt, buildLiAtCookie(options.liAtCookie)];
      }
      return fromFile;
    } catch (err) {
      if (options.liAtCookie?.trim()) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `${message}\n\nFalling back disabled — fix linkedin-cookies.json or remove LINKEDIN_COOKIES_PATH from .env to use LI_AT only.`
        );
      }
      throw err;
    }
  }

  if (options.liAtCookie?.trim()) {
    return [buildLiAtCookie(options.liAtCookie)];
  }

  throw new Error("Provide LI_AT, LINKEDIN_COOKIES_PATH, or LINKEDIN_STORAGE_STATE.");
}
