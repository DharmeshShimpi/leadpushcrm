# LeadPush Final Verification Checklist

This checklist provides manual and automated verification procedures for all 13 core operational requirements of LeadPush.

---

## 1. First-Run Onboarding Flow
- [ ] Visit protected route `/app/:secret` when `onboarding_completed = false`.
- [ ] Verify automatic redirection to `/app/:secret/onboarding`.
- [ ] Verify exactly 3 steps are present:
  - Step 1: Connect WhatsApp
  - Step 2: Connect Google Sheets
  - Step 3: Go to Dashboard

## 2. WhatsApp QR Scan & Linked-Device Connection
- [ ] On Step 1, verify QR code renders when unlinked.
- [ ] Scan QR code using WhatsApp mobile app (Linked Devices).
- [ ] Verify automatic transition to `connected` status without page refresh.
- [ ] Verify credentials stored securely in `./data/baileys-auth`.

## 3. Google OAuth & Account Connection
- [ ] On Step 2, click **Connect Google Account**.
- [ ] Verify redirect to Google OAuth consent screen with CSRF state token.
- [ ] Authorize requested scopes (`userinfo.email`, `drive.file`, `spreadsheets`).
- [ ] Verify callback redirects back to Onboarding with connected email displayed.
- [ ] Verify encrypted refresh token saved in Supabase `google_connections`.

## 4. Existing Spreadsheet Selection
- [ ] Select **Option B: Select existing Google Sheet**.
- [ ] Choose an existing spreadsheet from your Google Drive.
- [ ] Select worksheet tab name (or create tab).
- [ ] Submit and verify settings saved to Supabase and SQLite.

## 5. New Spreadsheet Creation
- [ ] Select **Option A: Create New "WhatsApp Leads" Spreadsheet**.
- [ ] Verify automatic creation of "WhatsApp Leads" in Google Drive with "Leads" tab.
- [ ] Verify 14 required header columns written in exact order:
  `Created At | Updated At | Name | WhatsApp Number | Status | Confidence | Qualification Reason | Summary | Requirement | Budget | Timeline | Location | Firm/Company | Other Details`

## 6. Inbound First Message
- [ ] Send a message from a customer WhatsApp phone to the connected business number.
- [ ] Verify lead created immediately in SQLite with `status = analyzing`.
- [ ] Verify raw message stored in SQLite `messages` table.
- [ ] Verify dashboard updates live via SSE without page refresh.

## 7. Outbound First Message
- [ ] Send a message from business WhatsApp (or linked device) to a new customer number.
- [ ] Verify customer lead created immediately (direction = outgoing).
- [ ] Verify business self-account is NEVER created as a lead.

## 8. 2-Minute Inactivity Groq Analysis
- [ ] Send incoming messages to a lead.
- [ ] Wait for 2 minutes of conversation inactivity.
- [ ] Verify background worker processes lead via Groq LLM after 2-minute window.
- [ ] Verify status updates from `analyzing` to `interested`, `not_interested`, or `undecided`.
- [ ] Verify confidence score, qualification reason, summary, and extracted answers displayed on lead detail.

## 9. No Duplicate Lead Records
- [ ] Send multiple incoming and outgoing messages across 10 minutes.
- [ ] Verify only 1 canonical lead record exists per customer identity.
- [ ] Verify LID identities map to real phone numbers seamlessly when available.

## 10. Google Sheet Row Synchronization
- [ ] Verify exactly 1 row is appended per lead.
- [ ] Verify subsequent updates edit the exact same row index without creating duplicate rows.
- [ ] Verify raw LIDs are NEVER written to the WhatsApp Number column.

## 11. Supabase Backup Mirroring
- [ ] Check Supabase `lead_backups` table.
- [ ] Verify lead metadata (identity, JID, phone, status, latest message, qualification fields) mirrored accurately.

## 12. Render Restart & Ephemeral Disk Recovery
- [ ] Simulate server restart (or clear `./data/leadpush.db`).
- [ ] Restart server and verify startup recovery restores lead records from Supabase `lead_backups`.
- [ ] Open lead detail page and verify clean empty-chat notice displayed ("No local message history — restored from Supabase").

## 13. WhatsApp QR Re-Link Behavior
- [ ] Log out WhatsApp linked device.
- [ ] Verify Red Banner displayed on dashboard (`WhatsApp needs QR reconnect`).
- [ ] Click **Reconnect WhatsApp**, scan new QR code, and verify connection restored while preserving all leads and Google Sheet settings.
