# LeadPush (WA Lead Capture & Automated Classification)

LeadPush is a production-ready, lightweight SaaS backend and dashboard that captures WhatsApp messages via Baileys, categorizes lead purchase intent using Groq LLM after a 2-minute inactivity period, mirrors lead records to Supabase, and maintains a synchronized Google Sheet.

---

## 1. Production Deployment on Render (Free Tier)

### Environment Variables
Configure the following environment variables in your Render Dashboard (**Settings > Environment Variables**):

```env
PORT=3000
APP_SECRET_PATH=your_secret_path_key_here

# Supabase Configuration
SUPABASE_URL=https://<your-project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key

# AES-256-GCM Encryption Key (32 bytes)
DATA_ENCRYPTION_KEY=your_32_byte_secret_key_here

# Google OAuth Setup
GOOGLE_CLIENT_ID=your_google_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_REDIRECT_URI=https://<your-render-app>.onrender.com/oauth/google/callback

# Groq LLM Setup
GROQ_API_KEY=gsk_your_groq_api_key
GROQ_MODEL=llama-3.1-8b-instant
```

### Build & Start Commands
- **Build Command**: `npm run build`
- **Start Command**: `npm start`

---

## 2. External Cron Job Setup (Keep-Alive & Monitoring)

Render Free Tier spins down after 15 minutes of inactivity. Set up a free external cron job using [cron-job.org](https://cron-job.org) or UptimeRobot:

- **Target URL**: `https://<your-render-app>.onrender.com/health`
- **Interval**: Every 5 minutes (`*/5 * * * *`)
- **HTTP Method**: `GET`
- **Expected Response**: `200 OK` with JSON `{"ok": true, "service": "wa-lead-capture", ...}`

---

## 3. Data Persistence Architecture

| Data Tier | Storage Target | What Persists | Ephemeral Behavior / Recovery |
| :--- | :--- | :--- | :--- |
| **Local SQLite** | `./data/leadpush.db` | Raw WhatsApp chat messages, lead metadata, pending sync queues | Reset on Render restart/redeploy. Restores lead metadata automatically from Supabase on boot. |
| **Baileys Auth** | `./data/baileys-auth` | Local WhatsApp multi-file credentials | Reset on Render restart. Triggers red QR reconnect banner on dashboard. |
| **Supabase** | `lead_backups` table | Lead metadata, status, confidence, summary, answers | Permanent cloud backup. Restores SQLite leads on fresh boot. |
| **Google Sheets** | User Spreadsheet | 14-column spreadsheet row per WhatsApp lead | Permanent cloud document. Updated continually per lead identity. |

> [!NOTE]
> Render restarts clear local disk (`./data/`). On boot, LeadPush automatically restores lead metadata from Supabase `lead_backups`. Raw WhatsApp messages are stored only locally during active chat sessions and will show a clean empty-chat notice for restored leads.

---

## 4. WhatsApp Reconnection Procedure

If your WhatsApp session logs out or Render restarts:
1. Open your LeadPush dashboard at `/app/:secret`.
2. Look for the **Red Banner**: `"WhatsApp needs QR reconnect"`.
3. Click **Reconnect WhatsApp** to open Onboarding Step 1.
4. Open WhatsApp on your phone > **Linked Devices** > **Link a Device**.
5. Scan the QR code rendered in the LeadPush UI.
6. The UI will automatically transition to **Connected** status. Existing leads and Google Sheet configurations remain intact.
