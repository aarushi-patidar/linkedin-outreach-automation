# LinkedIn Outreach Automation

Production-oriented LinkedIn connection outreach with a **standalone CLI** and an embeddable **`LinkedInOutreachService`** class for your backend later.

## Prerequisites

- Node.js 18+
- Google Chrome installed

## Setup

```bash
cd C:\Users\Aarushi\Projects\linkedin-outreach
npm install
copy .env.example .env
```

## Run (recommended — CDP mode)

LinkedIn often blocks Playwright-launched browsers and loops back to login. **CDP mode** attaches to your real Chrome instead.

**Terminal 1** — start Chrome with debugging:

```powershell
npm run chrome
```

Log into LinkedIn in the Chrome window that opens. Complete any 2FA / security checks.

**Terminal 2** — run outreach:

```powershell
npx ts-node src/index.ts --csv=./prospects.csv
```

Keep the Chrome window from Terminal 1 open while the script runs.

`.env` defaults:

```env
AUTH_MODE=cdp
CDP_URL=http://127.0.0.1:9222
```

## CSV schema

| Column | Required | Description |
|--------|----------|-------------|
| `founder_name` | No | Used in Discovery/Sales templates |
| `company_name` | Yes | Company name for templates |
| `linkedin_url` | Yes | Full LinkedIn profile URL |
| `campaign_type` | Yes | `Discovery`, `Sales`, or `Custom` |
| `outreach_message` | Custom only | Note body when type is Custom |

Messages are capped at **300 characters** (LinkedIn limit). Overlong notes are truncated with a `[WARNING]` log/event.

## Other auth modes

| Mode | When to use |
|------|-------------|
| `cdp` | **Default.** Most reliable — uses your Chrome |
| `profile` | Playwright-managed profile (LinkedIn may block) |
| `cookies` | Inject `li_at` / JSON file (least reliable) |

## Embedding in your backend

```typescript
import { LinkedInOutreachService } from "./LinkedInOutreachService";

const service = new LinkedInOutreachService({
  authMode: "cdp",
  cdpUrl: "http://127.0.0.1:9222",
});

service.on("status", (event) => {
  // Persist event.code, event.message, event.prospect to your DB
});

await service.initialize();
await service.run(prospectsFromDatabase);
await service.shutdown();
```

## Compliance

Automated LinkedIn activity may violate LinkedIn’s User Agreement. Use low volume, human-like delays, and monitor `[RATE_LIMITED]` events. You are responsible for lawful, consent-based outreach.
