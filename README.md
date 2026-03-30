# Space Missions Dashboard

Interactive dashboard analyzing 4,630 space launches from 1957–2022 across 62 organizations, with an AI-powered analysis chat powered by Claude.

## Features

- **Overview** — 6 live charts: launch timeline, mission status, success rate by decade, top organizations, launch locations, most-used rockets. All charts respond to the filter sidebar.
- **Data Table** — sortable, searchable table across all 4,630 records with pagination.
- **AI Analysis** — chat interface backed by Claude. Ask natural language questions; the AI responds with analysis and generates charts. **Note:** the AI receives aggregated summaries (totals by company, year, and decade) rather than individual mission records, so it cannot answer questions that require looking up specific mission dates, rocket names, or event sequences (e.g. "when was the first SpaceX launch?"). It works best for trend analysis, comparisons, and statistical questions.
- **Functions API** — all 8 graded functions exposed and interactively testable in-browser.

## Quick Start

You need an [Anthropic API key](https://console.anthropic.com) for the AI chat tab.

```bash
git clone <repo-url>
cd space-missions-dashboard

cp .env.example .env
# edit .env and paste your ANTHROPIC_API_KEY

node backend/server.js
# → open http://localhost:3000
```

Requires Node.js ≥ 16. No npm install needed — uses stdlib only.

---

## Why a local server?

Browsers block direct calls to third-party APIs (`api.anthropic.com`) from local files due to CORS policy. The local server acts as a thin proxy — it receives the chat request from the browser, forwards it to Anthropic with your API key (kept server-side, never in the browser), and streams the response back.

```
Browser → localhost:3000/api/chat → backend/server.js → api.anthropic.com
```

The rest of the app (charts, table, filters, functions) fetches data from `GET /api/missions` and runs client-side.

---

## Project Structure

```
space-missions-dashboard/
├── backend/
│   ├── server.js           # HTTP server + API routes (stdlib only)
│   └── missions.js         # CSV loader + 8 required functions
├── frontend/
│   ├── index.html          # Dashboard HTML
│   ├── style.css           # All styles
│   └── app.js              # Charts, table, filters, AI chat
├── space_missions.csv      # Source dataset (1957–2022)
├── package.json
├── .env.example
├── .gitignore
└── README.md
```

## Required Functions

All 8 functions are implemented in `backend/missions.js`, read live from `space_missions.csv`, and exposed as REST endpoints. They are also interactively testable in the **Functions API** tab:

| Function | Signature |
|---|---|
| `getMissionCountByCompany` | `(companyName: string) → number` |
| `getSuccessRate` | `(companyName: string) → float` |
| `getMissionsByDateRange` | `(startDate, endDate: string) → string[]` |
| `getTopCompaniesByMissionCount` | `(n: number) → [string, number][]` |
| `getMissionStatusCount` | `() → {[status]: number}` |
| `getMissionsByYear` | `(year: number) → number` |
| `getMostUsedRocket` | `() → string` |
| `getAverageMissionsPerYear` | `(startYear, endYear: number) → float` |

## Visualization Rationale

| Chart | Type | Why |
|---|---|---|
| Launches Per Year | Line (area) | Time-series data — shows trends, Cold War peak, post-Soviet decline, and the modern commercial surge clearly |
| Mission Status | Doughnut | Part-of-whole for 4 categories — instantly shows the dominant success rate |
| Success Rate by Decade | Bar (color-coded) | Aggregating to decades smooths noise and shows the long arc of improving reliability |
| Top Organizations | Horizontal bar | Ranked comparison — horizontal layout handles long organization names cleanly |
| Launch Locations | Horizontal bar | Geographic dominance comparison — shows USA/Russia/Kazakhstan split at a glance |
| Most Used Rockets | Horizontal bar | Ranked count — reveals Cold War Soviet workhorses vs modern vehicles |

## Dataset

`space_missions.csv` — columns: Company, Location, Date, Time, Rocket, Mission, RocketStatus, Price, MissionStatus.

Source: public space launch records, 1957–2022.

## Cost Estimate

Each AI chat message uses ~2,000–3,000 tokens. At Claude Sonnet pricing that's roughly **$0.003–$0.005 per message**.
