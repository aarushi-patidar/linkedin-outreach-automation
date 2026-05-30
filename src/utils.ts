export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const STEALTH_LAUNCH_OPTIONS = {
  args: ["--disable-blink-features=AutomationControlled"],
  ignoreDefaultArgs: ["--enable-automation", "--no-sandbox"],
};

export function sanitizeField(value: string, maxLen = 500): string {
  return value.replace(/^[\s=+\-@]+/, "").trim().slice(0, maxLen);
}

export function sanitizeUrl(url: string): string {
  const clean = url.trim();
  if (!/^https:\/\/(www\.)?linkedin\.com\//i.test(clean)) {
    throw new Error("Invalid LinkedIn URL");
  }
  return clean.split(/[?#]/)[0]!;
}
