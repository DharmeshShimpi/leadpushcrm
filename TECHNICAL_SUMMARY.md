# LeadPush — Technical Summary

---

## 1. Executive Overview & Tech Stack

**LeadPush** is a local-first, cloud-backed WhatsApp lead qualification engine and CRM dashboard.

* **Backend / Runtime**: Node.js (Node 20 / 22+), Express 4.21 with TypeScript (`tsx`).
* **Frontend**: Server-rendered EJS 3.1 views, Vanilla CSS, Client-side JavaScript with Server-Sent Events (SSE).
* **Primary Database**: Local SQLite (`data/leadpush.db` in `WAL` mode via `better-sqlite3` / `node:sqlite`).
* **Cloud Backup / Persistence**: Supabase PostgreSQL (`@supabase/supabase-js`) with Row Level Security (RLS) for offsite disaster recovery and server reboot persistence.
* **WhatsApp Engine**: `@whiskeysockets/baileys` (`v7.0.0-rc14`), multi-file auth state with AES-256-GCM encrypted cloud backup in Supabase.
* **AI Provider**: Groq SDK (`llama-3.1-8b-instant`) with structured JSON schema outputs.
* **Integrations**: Google Sheets & Google Drive v4 API (`googleapis`) via OAuth2.
* **Security**: AES-256-GCM encryption for credentials at rest, URL Secret Path segment authorization with timing-safe comparison.

---

## 2. Directory Structure

```text
leadpushv1/
├── data/
│   ├── leadpush.db               # Primary SQLite database (WAL mode)
│   └── baileys-auth/             # WhatsApp Baileys credentials & multi-file auth state
├── src/
│   ├── server.ts                 # Express bootstrap, workers & graceful shutdown
│   ├── db/
│   │   └── index.ts              # SQLite schemas, deduplication, LID mapping & CRUD
│   ├── services/
│   │   ├── whatsappService.ts    # Baileys socket lifecycle, QR/pairing codes, message ingest
│   │   ├── groqService.ts        # AI qualification prompt, response parsing & validation
│   │   ├── analysisWorker.ts     # 30-sec polling worker for 2-min debounced leads
│   │   ├── googleService.ts      # Google OAuth, Drive, Sheets row update & formatting
│   │   ├── supabaseService.ts    # Supabase cloud backup, startup restore & retry queue
│   │   ├── sseService.ts         # Server-Sent Events broadcaster for live UI updates
│   │   └── secretService.ts      # Timing-safe URL secret path validator
│   ├── routes/
│   │   ├── dashboard.ts          # Main dashboard view & secret auth middleware
│   │   ├── leads.ts              # Leads list, Lead Detail & Chat transcript views
│   │   ├── onboarding.ts         # 3-step setup wizard (WhatsApp, Google Sheets, Complete)
│   │   ├── whatsapp.ts           # WhatsApp status, QR, pairing code & reset endpoints
│   │   ├── googleAuth.ts         # Google OAuth start/callback & spreadsheet picker
│   │   ├── analysis.ts           # Manual Groq re-analysis trigger endpoint
│   │   ├── manualOps.ts          # Manual Google Sheet push & Supabase retry endpoints
│   │   ├── admin.ts              # Admin identity repair & lead purge endpoints
│   │   ├── api.ts                # JSON REST API for dashboard & paginated leads
│   │   ├── events.ts             # SSE stream endpoint (/app/:secret/events)
│   │   └── health.ts             # Liveness health check (/health)
│   ├── utils/
│   │   ├── crypto.ts             # AES-256-GCM secret encryption/decryption
│   │   └── rateLimiter.ts        # IP-based rate limiting helper
│   └── views/                    # Server-rendered EJS UI templates
└── supabase/
    └── migrations/               # PostgreSQL tables: lead_backups, google_connections, whatsapp_connections
```

---

## 3. End-to-End Application Flow

```text
1. Customer sends WhatsApp message
      ↓
2. Baileys Socket (`messages.upsert`) -> `whatsappService.processIncomingMessage()`
   - Filters status broadcasts, groups, business-self messages, protocol frames.
   - Resolves privacy LIDs (`...@lid`) to phone numbers.
      ↓
3. SQLite Persistence (`db/index.ts` -> `saveMessageAndUpsertCanonicalLead()`)
   - Saves message into `messages` table.
   - Upserts canonical lead in `leads` & aliases in `lead_identities`.
   - Sets `analysis_due_at = now() + 2 minutes` (inactivity debounce).
      ↓
4. Pre-Analysis Mirroring
   - `supabaseService.syncLead()` -> Mirrors lead to Supabase `lead_backups`.
   - `googleService.syncLeadToSheet()` -> Appends/updates row in Google Sheets.
      ↓
5. Inactivity Delay (2 minutes without new customer messages)
      ↓
6. Debounce Worker (`analysisWorker.ts` polls every 30s)
      ↓
7. Groq AI Qualification (`groqService.ts` -> `llama-3.1-8b-instant`)
   - Reads last 30 messages chronologically.
   - Evaluates status (`interested` | `not_interested` | `undecided`), score (`Hot` | `Warm` | `Cold`), confidence `[0.0, 1.0]`.
   - Extracts metadata: requirement, budget (in ₹), timeline, location, firm/company, CP vs Developer.
   - Generates 2-sentence summary.
      ↓
8. Post-Analysis Updates
   - Updates SQLite `leads` table.
   - Triggers `sseService.broadcast('dashboard_update')` for real-time UI refresh.
   - Mirrors updated lead to Supabase `lead_backups`.
   - Updates formatted & color-coded row in Google Sheets.
```

---

## 4. Subsystem Architectures

### WhatsApp / Baileys (`whatsappService.ts`)
* **Session Lifecycle**: Single socket instance (`private socket: WASocket | null`). Credentials saved locally to `data/baileys-auth/` and backed up encrypted (AES-256-GCM) to Supabase table `whatsapp_connections` on every `creds.update`.
* **Disaster Recovery**: On boot, if local `baileys-auth/` is empty, credentials are automatically fetched and restored from Supabase before socket initialization.
* **Authentication**: Supports both QR Code Data URLs (`/whatsapp/qr`) and 8-digit Pairing Codes (`/whatsapp/pairing-code`).
* **LID Resolution**: Maps WhatsApp Privacy IDs (`...@lid`) to phone numbers using Baileys signal repository and persistent SQLite `lid_phone_map`.

### Database Architecture
* **Local SQLite (`leadpush.db`)**:
  * `leads`: Canonical lead record with status, qualification metadata, Google Sheet row index, and analysis timestamps.
  * `lead_identities`: `1:N` table mapping multiple JIDs/LIDs to a single canonical `lead_id`.
  * `messages`: Full conversation transcript linked by `lead_id`.
  * `pending_supabase_syncs` & `pending_google_sheet_syncs`: Retry queues with 10-minute automated background retry workers.
* **Supabase PostgreSQL**:
  * `lead_backups`: Mirror of `leads` keyed by `lead_identity UNIQUE`.
  * `whatsapp_connections`: Single-row encrypted session storage (`connection_key = 'default'`).
  * `google_connections`: Single-row encrypted OAuth tokens and active spreadsheet configuration (`connection_key = 'default'`).
  * All tables secured with Row Level Security (RLS) accessible only by `service_role`.

### Google Sheets Integration (`googleService.ts`)
* **OAuth2**: Refresh tokens stored encrypted in Supabase.
* **Row Mapping**: Uses `leads.google_sheet_row_number` to append new rows or update existing rows in-place (`'Leads'!A{row}:K{row}`).
* **Styling**: Dynamically applies header formatting and background row coloring based on status (Green for `interested`, Yellow for `undecided`, Red for `not_interested`, Gray for `analyzing`).

### Authentication & Security (`dashboard.ts`, `secretService.ts`)
* **URL Secret Path**: Authenticated using `APP_SECRET_PATH` via route prefix `/app/:secret/...`.
* **No Database Users**: No user logins, passwords, sessions, or role tables exist. Possessing the secret path grants full admin privileges.
* **Timing-Safe Comparison**: Requests are validated against `process.env.APP_SECRET_PATH` using `crypto.timingSafeEqual` to prevent timing attacks.

---

## 5. Summary of API Routes

| Endpoint | Method | Purpose |
| :--- | :--- | :--- |
| `/health` | `GET` | Service liveness probe (public) |
| `/oauth/google/connect` & `/callback` | `GET` | Google OAuth initiate & callback |
| `/app/:secret` | `GET` | Main KPI Dashboard UI |
| `/app/:secret/leads` | `GET` | Paginated leads UI with search & status filters |
| `/app/:secret/leads/:id` | `GET` | Lead details & qualification metadata UI |
| `/app/:secret/leads/:id/conversation` | `GET` | WhatsApp conversation transcript UI |
| `/app/:secret/onboarding` | `GET` | 3-step setup wizard |
| `/app/:secret/api/dashboard` | `GET` | JSON dashboard metrics & recent leads |
| `/app/:secret/api/leads` | `GET` | JSON paginated leads query |
| `/app/:secret/api/leads/:id/messages` | `GET` | JSON chat messages for lead |
| `/app/:secret/whatsapp/qr` | `GET` | Base64 QR Code image data |
| `/app/:secret/whatsapp/pairing-code` | `POST` | Generate 8-digit phone pairing code |
| `/app/:secret/whatsapp/reset-session` | `POST` | Wipe session & disconnect WhatsApp |
| `/app/:secret/leads/:id/reanalyze` | `POST` | Force immediate Groq AI re-analysis |
| `/app/:secret/leads/:id/sync-sheets` | `POST` | Manual trigger to push lead to Google Sheets |
| `/app/:secret/events` | `GET` | Server-Sent Events (SSE) live data stream |

---

## 6. Multi-WhatsApp MVP Blockers & Affected Areas

To transition from single-tenant to multi-WhatsApp connections:

1. **Singleton Socket Service**: `WhatsAppService` maintains a single `WASocket` and single `data/baileys-auth` folder. Needs a multi-session manager (`Map<string, WASocket>`).
2. **Database Schema Scoping**: `leads`, `messages`, `lead_identities`, and sync queues in SQLite (and `lead_backups` in Supabase) lack a `connection_id` or `channel_id` column.
3. **Hardcoded Backup Keys**: Supabase `whatsapp_connections` and `google_connections` tables enforce `connection_key = 'default'`.
4. **Google Sheets Routing**: `googleService.ts` directs all leads to one spreadsheet ID rather than routing per connection/channel.
5. **No Role/User Access Model**: Master admin vs individual channel operators cannot be segregated without introducing authentication identities.

### Priority Files for Multi-WhatsApp Implementation
1. `src/db/index.ts` — Add `connection_id` / `channel_id` foreign keys and connection registry tables.
2. `src/services/whatsappService.ts` — Refactor singleton socket into a multi-session instance manager.
3. `src/services/supabaseService.ts` — Update session backup/restore to handle discrete connection keys.
4. `src/services/googleService.ts` — Support per-connection spreadsheet mappings.
5. `src/routes/whatsapp.ts` & `src/routes/api.ts` — Scope WhatsApp endpoints by connection ID.
6. `src/views/` (`dashboard.ejs`, `leads.ejs`, `onboarding.ejs`) — Add connection selector, channel badges, and multi-connection status.
7. `supabase/migrations/` — Update schemas for multi-row WhatsApp and Google connections.
