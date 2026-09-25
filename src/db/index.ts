import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { sseService } from '../services/sseService.js';

const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'leadpush.db');

interface StatementLike {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

interface DatabaseLike {
  exec(sql: string): void;
  pragma(sql: string): void;
  prepare(sql: string): StatementLike;
}

let dbInstance: DatabaseLike;

try {
  // Try loading better-sqlite3 (Node 20 / Render deployment target)
  const Database = require('better-sqlite3');
  dbInstance = new Database(dbPath);
  dbInstance.pragma('journal_mode = WAL');
} catch {
  // Fallback to node:sqlite (Built-in SQLite module in Node 22.5+ / Node 24)
  const { DatabaseSync } = require('node:sqlite');
  dbInstance = new DatabaseSync(dbPath);
  try {
    dbInstance.exec('PRAGMA journal_mode = WAL;');
  } catch {
    // ignore pragma if not supported
  }
}

export const db = dbInstance;

// Auto-initialize schema if missing
initDb();

export interface LeadIdentityRow {
  id: number;
  lead_id: number;
  jid: string;
  jid_type: 'pn' | 'lid' | 'other';
  created_at: string;
}

export function initDb(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NULL REFERENCES channels(id),
      lead_identity TEXT UNIQUE NOT NULL,
      whatsapp_jid TEXT NOT NULL,
      whatsapp_phone TEXT,
      customer_name TEXT,
      status TEXT NOT NULL DEFAULT 'analyzing',
      latest_message TEXT,
      first_activity_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lead_identities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      jid TEXT NOT NULL UNIQUE,
      jid_type TEXT NOT NULL CHECK(jid_type IN ('pn','lid','other')),
      created_at TEXT NOT NULL,
      FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_identities_jid ON lead_identities(jid);
    CREATE INDEX IF NOT EXISTS idx_lead_identities_lead_id ON lead_identities(lead_id);

    CREATE TABLE IF NOT EXISTS lid_phone_map (
      lid TEXT PRIMARY KEY NOT NULL,
      phone_jid TEXT NOT NULL,
      contact_name TEXT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_supabase_syncs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL UNIQUE,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pending_google_sheet_syncs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL UNIQUE,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(lead_id) REFERENCES leads(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wa_message_id TEXT UNIQUE NOT NULL,
      lead_identity TEXT NOT NULL,
      remote_jid TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('incoming','outgoing')),
      sender_name TEXT,
      message_text TEXT,
      message_type TEXT,
      sent_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      lead_id INTEGER REFERENCES leads(id)
    );

    CREATE TABLE IF NOT EXISTS contacts_cache (
      jid TEXT PRIMARY KEY NOT NULL,
      phone_digits TEXT NULL,
      name TEXT NULL,
      notify TEXT NULL,
      verified_name TEXT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_cache_phone_digits ON contacts_cache(phone_digits);
  `);

  // Safely add channel_id and Phase 7 analysis columns to leads table if missing
  const leadsColumns = db.prepare('PRAGMA table_info(leads)').all() as { name: string }[];
  if (!leadsColumns.some(col => col.name === 'channel_id')) {
    db.exec('ALTER TABLE leads ADD COLUMN channel_id TEXT;');
  }
  if (!leadsColumns.some(col => col.name === 'google_sheet_row_number')) {
    db.exec('ALTER TABLE leads ADD COLUMN google_sheet_row_number INTEGER;');
  }
  if (!leadsColumns.some(col => col.name === 'qualification_reason')) {
    db.exec('ALTER TABLE leads ADD COLUMN qualification_reason TEXT;');
  }
  if (!leadsColumns.some(col => col.name === 'confidence')) {
    db.exec('ALTER TABLE leads ADD COLUMN confidence NUMERIC;');
  }
  if (!leadsColumns.some(col => col.name === 'conversation_summary')) {
    db.exec('ALTER TABLE leads ADD COLUMN conversation_summary TEXT;');
  }
  if (!leadsColumns.some(col => col.name === 'extracted_answers')) {
    db.exec('ALTER TABLE leads ADD COLUMN extracted_answers TEXT;');
  }
  if (!leadsColumns.some(col => col.name === 'analysis_due_at')) {
    db.exec('ALTER TABLE leads ADD COLUMN analysis_due_at TEXT;');
  }
  if (!leadsColumns.some(col => col.name === 'last_analyzed_at')) {
    db.exec('ALTER TABLE leads ADD COLUMN last_analyzed_at TEXT;');
  }
  if (!leadsColumns.some(col => col.name === 'analysis_error')) {
    db.exec('ALTER TABLE leads ADD COLUMN analysis_error TEXT;');
  }
  if (!leadsColumns.some(col => col.name === 'conversion_score')) {
    db.exec('ALTER TABLE leads ADD COLUMN conversion_score TEXT;');
  }

  const lidMapColumns = db.prepare('PRAGMA table_info(lid_phone_map)').all() as { name: string }[];
  if (!lidMapColumns.some(col => col.name === 'contact_name')) {
    db.exec('ALTER TABLE lid_phone_map ADD COLUMN contact_name TEXT;');
  }

  // Safely ensure lead_id column exists on messages table if migrating older schema
  const messagesColumns = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
  const hasLeadIdColumn = messagesColumns.some(col => col.name === 'lead_id');

  if (!hasLeadIdColumn) {
    db.exec(`
      ALTER TABLE messages ADD COLUMN lead_id INTEGER REFERENCES leads(id);
    `);
  }

  // Run migration: Populate lead_identities for all existing leads
  runMigrations();

  // Retroactively resolve any lead names from cache, messages or maps
  retroactiveResolveAllLeadNames();
}

function runMigrations(): void {
  const now = new Date().toISOString();

  // 1. Insert existing leads into lead_identities (idempotent — INSERT OR IGNORE)
  const existingLeads = db.prepare('SELECT id, lead_identity, whatsapp_jid FROM leads').all() as { id: number; lead_identity: string; whatsapp_jid: string }[];

  const insertIdentityStmt = db.prepare(`
    INSERT OR IGNORE INTO lead_identities (lead_id, jid, jid_type, created_at)
    VALUES (?, ?, ?, ?)
  `);

  existingLeads.forEach(lead => {
    const jid = lead.whatsapp_jid || lead.lead_identity;
    let jidType: 'pn' | 'lid' | 'other' = 'other';
    if (jid.endsWith('@lid')) jidType = 'lid';
    else if (jid.includes('@s.whatsapp.net')) jidType = 'pn';

    insertIdentityStmt.run(lead.id, jid, jidType, now);
    if (lead.lead_identity && lead.lead_identity !== jid) {
      let type2: 'pn' | 'lid' | 'other' = 'other';
      if (lead.lead_identity.endsWith('@lid')) type2 = 'lid';
      else if (lead.lead_identity.includes('@s.whatsapp.net')) type2 = 'pn';
      insertIdentityStmt.run(lead.id, lead.lead_identity, type2, now);
    }
  });

  // 2. Link existing messages to leads via lead_id (idempotent — WHERE lead_id IS NULL)
  db.exec(`
    UPDATE messages SET lead_id = (
      SELECT leads.id FROM leads WHERE leads.lead_identity = messages.lead_identity OR leads.whatsapp_jid = messages.remote_jid LIMIT 1
    ) WHERE lead_id IS NULL;
  `);

  // Steps 3–6 are one-time data repair migrations. Gate them behind a flag so they
  // don't re-run (and scan all messages) on every subsequent server restart.
  const migrationDone = db.prepare("SELECT value FROM app_settings WHERE key = 'migration_v1_done'").get() as { value: string } | undefined;
  if (migrationDone?.value === 'true') return;

  // 3. Repair leads that have latest_message = 'unknown' (from pre-fix ingestion)
  const unknownLeads = db.prepare("SELECT id FROM leads WHERE latest_message = 'unknown'").all() as { id: number }[];
  for (const lead of unknownLeads) {
    const bestMsg = db.prepare(`
      SELECT message_text FROM messages 
      WHERE lead_id = ? AND message_text IS NOT NULL AND message_text != 'unknown' AND message_type != 'unknown'
      ORDER BY sent_at DESC LIMIT 1
    `).get(lead.id) as { message_text: string } | undefined;

    if (bestMsg) {
      db.prepare("UPDATE leads SET latest_message = ?, updated_at = ? WHERE id = ?").run(bestMsg.message_text, now, lead.id);
    } else {
      db.prepare("UPDATE leads SET latest_message = '[Media or unsupported message]', updated_at = ? WHERE id = ?").run(now, lead.id);
    }
  }

  // 4. Purge orphaned 'unknown' messages that were protocol/system events ingested before the fix
  db.exec("DELETE FROM messages WHERE message_type = 'unknown' AND message_text = 'unknown'");

  // 5. Repair fake phone numbers (LID strings) and extract customer names from incoming messages
  const allLeads = db.prepare('SELECT id, whatsapp_phone, customer_name FROM leads').all() as { id: number; whatsapp_phone: string | null; customer_name: string | null }[];
  for (const l of allLeads) {
    if (l.whatsapp_phone && (l.whatsapp_phone.includes('@lid') || (l.whatsapp_phone.length > 13 && (l.whatsapp_phone.startsWith('+100') || l.whatsapp_phone.startsWith('+10'))))) {
      db.prepare("UPDATE leads SET whatsapp_phone = NULL WHERE id = ?").run(l.id);
    }
    if (!l.customer_name || l.customer_name === 'N/A') {
      const msgWithName = db.prepare("SELECT sender_name FROM messages WHERE lead_id = ? AND direction = 'incoming' AND sender_name IS NOT NULL AND sender_name != '' LIMIT 1").get(l.id) as { sender_name: string } | undefined;
      if (msgWithName && msgWithName.sender_name.trim()) {
        db.prepare("UPDATE leads SET customer_name = ? WHERE id = ?").run(msgWithName.sender_name.trim(), l.id);
      }
    }
  }

  // 6. Scan incoming message texts for phone numbers if lead phone is still missing
  for (const l of allLeads) {
    const currentLead = db.prepare('SELECT whatsapp_phone FROM leads WHERE id = ?').get(l.id) as { whatsapp_phone: string | null } | undefined;
    if (!currentLead?.whatsapp_phone || currentLead.whatsapp_phone.includes('@lid') || currentLead.whatsapp_phone === 'WhatsApp ID unavailable') {
      const incomingMsgs = db.prepare("SELECT message_text FROM messages WHERE lead_id = ? AND direction = 'incoming' ORDER BY sent_at ASC").all(l.id) as { message_text: string }[];
      for (const msg of incomingMsgs) {
        if (!msg.message_text) continue;
        const phoneMatch = msg.message_text.match(/(?:^|\s)(?:\+?91[\s-]?)?([6-9]\d{9})(?:$|\s|\.|,)/) || msg.message_text.match(/(?:^|\s|\+)(\d{10,12})(?:$|\s|\.|,)/);
        if (phoneMatch && phoneMatch[1]) {
          const digits = phoneMatch[1].replace(/\D/g, '');
          if (digits.length === 10) {
            db.prepare("UPDATE leads SET whatsapp_phone = ? WHERE id = ?").run(`+91${digits}`, l.id);
            break;
          } else if (digits.length >= 10 && digits.length <= 12) {
            db.prepare("UPDATE leads SET whatsapp_phone = ? WHERE id = ?").run(`+${digits}`, l.id);
            break;
          }
        }
      }
    }
  }

  // Mark migration as complete — steps 3–6 will never run again
  db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('migration_v1_done', 'true', ?) ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = excluded.updated_at").run(now);
}

// Database helper functions

export interface Channel {
  id: string;
  name: string;
  status: string;
  created_at: string;
}

export function getAllChannelsWithStats(): (Channel & { lead_count: number })[] {
  const stmt = db.prepare(`
    SELECT c.id, c.name, c.status, c.created_at,
           COUNT(l.id) as lead_count
    FROM channels c
    LEFT JOIN leads l ON l.channel_id = c.id
    GROUP BY c.id, c.name, c.status, c.created_at
    ORDER BY c.created_at ASC
  `);
  return stmt.all() as (Channel & { lead_count: number })[];
}

export function countLeadsByChannelId(channelId: string): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM leads WHERE channel_id = ?').get(channelId) as { count: number } | undefined;
  return row?.count || 0;
}

/**
 * Assign all leads with NULL or empty channel_id to the given channel.
 * Returns the number of leads updated.
 */
export function backfillLeadsToChannel(channelId: string): number {
  const result = db.prepare(`
    UPDATE leads SET channel_id = ?, updated_at = datetime('now')
    WHERE channel_id IS NULL OR channel_id = ''
  `).run(channelId);
  return result.changes;
}

export function getChannelById(id: string): Channel | undefined {
  const stmt = db.prepare('SELECT id, name, status, created_at FROM channels WHERE id = ?');
  return stmt.get(id) as Channel | undefined;
}

export function createChannel(id: string, name: string, status: string = 'active'): Channel {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO channels (id, name, status, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, status = excluded.status
  `);
  stmt.run(id, name, status, now);
  const ch: Channel = { id, name, status, created_at: now };

  // Mirror channel to Supabase
  import('../services/supabaseService.js').then(m => m.supabaseService.syncChannel(ch)).catch(() => {});

  return ch;
}

export function ensureChannelExists(channelId: string, name?: string): void {
  if (!channelId) return;

  // If a real name is provided, upsert with it; otherwise only insert if the channel doesn't exist yet.
  // NEVER sync auto-generated placeholder names to Supabase — Supabase is the authoritative source.
  if (name) {
    db.prepare(`
      INSERT INTO channels (id, name, status, created_at)
      VALUES (?, ?, 'active', datetime('now'))
      ON CONFLICT(id) DO UPDATE SET name = excluded.name
    `).run(channelId, name);

    // Only mirror to Supabase when we have a real, human-provided name
    import('../services/supabaseService.js').then(m => m.supabaseService.syncChannel({
      id: channelId,
      name: name,
      status: 'active'
    })).catch(() => {});
  } else {
    // Local-only safety net: create a placeholder row if channel doesn't exist yet.
    // Uses INSERT OR IGNORE to never overwrite an existing name.
    db.prepare(`
      INSERT OR IGNORE INTO channels (id, name, status, created_at)
      VALUES (?, ?, 'active', datetime('now'))
    `).run(channelId, channelId);
  }
}

export function restoreChannelFromSupabaseBackup(channel: {
  id: string;
  name: string;
  status?: string;
  created_at?: string;
}): void {
  if (!channel.id || !channel.name) return;
  db.prepare(`
    INSERT INTO channels (id, name, status, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      status = excluded.status
  `).run(
    channel.id,
    channel.name,
    channel.status || 'active',
    channel.created_at || new Date().toISOString()
  );
}

export function deleteChannelLocal(channelId: string): void {
  if (!channelId) return;

  // 1. Delete associated messages, identities, and pending syncs for leads in this channel
  const leadIds = db.prepare('SELECT id FROM leads WHERE channel_id = ?').all(channelId) as { id: number }[];
  if (leadIds.length > 0) {
    const ids = leadIds.map(l => l.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM messages WHERE lead_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM lead_identities WHERE lead_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM pending_supabase_syncs WHERE lead_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM pending_google_sheet_syncs WHERE lead_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM leads WHERE channel_id = ?`).run(channelId);
  }

  // 2. Delete the channel itself
  db.prepare('DELETE FROM channels WHERE id = ?').run(channelId);
}

export interface AppSetting {
  key: string;
  value: string;
  updated_at: string;
}

export interface Message {
  id?: number;
  wa_message_id: string;
  lead_identity: string;
  remote_jid: string;
  direction: 'incoming' | 'outgoing';
  sender_name?: string | null;
  message_text?: string | null;
  message_type?: string | null;
  sent_at: string;
  created_at: string;
  lead_id?: number | null;
}

export interface Lead {
  id: number;
  channel_id: string;
  lead_identity: string;
  whatsapp_jid: string;
  whatsapp_phone?: string | null;
  customer_name?: string | null;
  status: string;
  latest_message?: string | null;
  first_activity_at: string;
  last_activity_at: string;
  google_sheet_row_number?: number | null;
  qualification_reason?: string | null;
  confidence?: number | null;
  conversation_summary?: string | null;
  extracted_answers?: string | null; // Stored as JSON string
  analysis_due_at?: string | null;
  last_analyzed_at?: string | null;
  analysis_error?: string | null;
  conversion_score?: string | null;
  created_at: string;
  updated_at: string;
}

export function getSetting(key: string): AppSetting | undefined {
  const stmt = db.prepare('SELECT key, value, updated_at FROM app_settings WHERE key = ?');
  return stmt.get(key) as AppSetting | undefined;
}

export function setSetting(key: string, value: string): void {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  stmt.run(key, value, now);
}

export interface OnboardingState {
  whatsapp_connection_state: string;
  google_connection_state: string;
  onboarding_completed: boolean;
  google_sheet_mode: string;
}

export function getOnboardingState(): OnboardingState {
  const waState = getSetting('whatsapp_connection_state')?.value || 'disconnected';
  const googleState = getSetting('google_connection_state')?.value || 'disconnected';
  const completed = getSetting('onboarding_completed')?.value === 'true';
  const sheetMode = getSetting('google_sheet_mode')?.value || 'new';

  return {
    whatsapp_connection_state: waState,
    google_connection_state: googleState,
    onboarding_completed: completed,
    google_sheet_mode: sheetMode
  };
}

export interface LeadStats {
  total: number;
  analyzing: number;
  interested: number;
  not_interested: number;
  undecided: number;
}

export function getLeadStats(): LeadStats {
  const rows = db.prepare('SELECT status, COUNT(*) as count FROM leads GROUP BY status').all() as { status: string; count: number }[];
  
  const stats: LeadStats = {
    total: 0,
    analyzing: 0,
    interested: 0,
    not_interested: 0,
    undecided: 0
  };

  rows.forEach(row => {
    stats.total += row.count;
    if (row.status === 'analyzing') stats.analyzing = row.count;
    else if (row.status === 'interested') stats.interested = row.count;
    else if (row.status === 'not_interested') stats.not_interested = row.count;
    else if (row.status === 'undecided') stats.undecided = row.count;
  });

  return stats;
}

export function cleanValidCustomerName(name?: string | null): string | null {
  if (!name || typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed === 'N/A' || trimmed === 'unknown') return null;

  // Maximum length for a legitimate person or business name (reject paragraphs/bios)
  if (trimmed.length > 35) return null;

  // Reject multi-line strings
  if (trimmed.includes('\n') || trimmed.includes('\r')) return null;

  const lower = trimmed.toLowerCase();

  // Reject URLs, domains, and email addresses
  if (
    lower.includes('http://') ||
    lower.includes('https://') ||
    lower.includes('www.') ||
    lower.includes('.com') ||
    lower.includes('.in') ||
    lower.includes('.org') ||
    lower.includes('.net') ||
    lower.includes('.co') ||
    lower.includes('@')
  ) {
    return null;
  }

  // Reject marketing, support, and business slogans
  if (
    lower.includes('call us') ||
    lower.includes('email us') ||
    lower.includes('help@') ||
    lower.includes('service') ||
    lower.includes('lifecycle app') ||
    lower.includes('recruitment') ||
    lower.includes('powered by') ||
    lower.includes('welcome to')
  ) {
    return null;
  }

  // Reject lead status keywords and placeholder names
  const blacklistedNames = [
    'business', 'customer', 'undefined', 'null', 'lead',
    'interested', 'not interested', 'not_interested', 'undecided', 'analyzing',
    'cold', 'warm', 'hot',
    'unsaved contact', 'whatsapp contact', 'new lead',
    'hey there! i am using whatsapp', 'hey there! i am using whatsapp.',
    'available', 'busy', 'at school', 'at the movies', 'at work',
    'battery about to die', "can't talk, whatsapp only", "cant talk, whatsapp only",
    'in a meeting', 'at the gym', 'sleeping', 'urgent calls only',
    'treat people with kindness', 'treat people with kindness 😇'
  ];

  if (blacklistedNames.includes(lower)) return null;

  // Disallow pure digit strings or phone numbers as names (e.g. 917559468033, +918329662586)
  const digitsOnly = trimmed.replace(/\D/g, '');
  if (digitsOnly.length >= 7 && trimmed.replace(/[\+\s\-\(\)]/g, '') === digitsOnly) return null;

  // Must contain at least one word character (letter or digit), not just emojis or punctuation
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return null;

  return trimmed;
}

export function getUnresolvedLeads(): Lead[] {
  const allLeads = db.prepare('SELECT * FROM leads').all() as Lead[];
  return allLeads.filter(lead => {
    // Check if phone needs resolution
    const hasValidPhone = lead.whatsapp_phone && 
      !lead.whatsapp_phone.includes('@lid') && 
      lead.whatsapp_phone !== 'WhatsApp ID unavailable' &&
      extractDigitsOnly(lead.whatsapp_phone);
    if (!hasValidPhone) return true;

    // Check if customer_name needs resolution
    const cleanName = cleanValidCustomerName(lead.customer_name);
    if (!cleanName) return true;

    return false;
  });
}

/**
 * Helper to safely extract 7-13 digit phone numbers from strings/JIDs
 */
export function extractDigitsOnly(str: string | null | undefined): string | null {
  if (!str) return null;
  if (str.includes('@lid')) return null;
  const parts = str.split('@')[0].split(':')[0];
  const digits = parts.replace(/\D/g, '');
  return (digits.length >= 7 && digits.length <= 13) ? digits : null;
}

/**
 * Retroactively update a lead's customer_name when we learn it from contacts events or business profile.
 * Finds the lead by any known JID in lead_identities table.
 */
export function updateLeadNameByJid(jid: string, name: string): void {
  const cleanName = cleanValidCustomerName(name);
  if (!jid || !cleanName) return;
  const now = new Date().toISOString();

  // Find lead by matching JID in lead_identities or leads table
  let lead = db.prepare(`
    SELECT leads.* FROM leads
    JOIN lead_identities ON leads.id = lead_identities.lead_id
    WHERE lead_identities.jid = ?
  `).get(jid) as Lead | undefined;

  if (!lead) {
    lead = db.prepare('SELECT * FROM leads WHERE lead_identity = ? OR whatsapp_jid = ?').get(jid, jid) as Lead | undefined;
  }

  if (lead) {
    const existingClean = cleanValidCustomerName(lead.customer_name);
    if (!existingClean) {
      db.prepare('UPDATE leads SET customer_name = ?, updated_at = ? WHERE id = ?').run(cleanName, now, lead.id);
      console.log(`[dev] lead_name_updated: Lead #${lead.id} name set to "${cleanName}" (via JID ${jid.substring(0, 8)}...)`);
      sseService.broadcast('dashboard_update', { leadId: lead.id, state: 'name_resolved' });

      const updated = getLeadById(lead.id);
      if (updated) {
        import('../services/supabaseService.js').then(m => m.supabaseService.syncLead(updated)).catch(() => {});
        import('../services/googleService.js').then(m => m.googleService.syncLeadToSheet(updated)).catch(() => {});
      }
    }
  }
}

/**
 * Update lead customer_name by matching phone digits
 */
export function updateLeadNameByPhone(phoneDigits: string, name: string): void {
  const cleanName = cleanValidCustomerName(name);
  if (!phoneDigits || phoneDigits.length < 7 || !cleanName) return;
  const now = new Date().toISOString();

  const leads = db.prepare(`
    SELECT * FROM leads 
    WHERE (whatsapp_phone LIKE ? OR lead_identity LIKE ? OR whatsapp_jid LIKE ?)
  `).all(`%${phoneDigits}%`, `%${phoneDigits}%`, `%${phoneDigits}%`) as Lead[];

  for (const lead of leads) {
    const existingClean = cleanValidCustomerName(lead.customer_name);
    if (!existingClean) {
      db.prepare('UPDATE leads SET customer_name = ?, updated_at = ? WHERE id = ?').run(cleanName, now, lead.id);
      console.log(`[dev] lead_name_updated_by_phone: Lead #${lead.id} name set to "${cleanName}" (matched phone ${phoneDigits})`);
      sseService.broadcast('dashboard_update', { leadId: lead.id, state: 'name_resolved' });

      const updated = getLeadById(lead.id);
      if (updated) {
        import('../services/supabaseService.js').then(m => m.supabaseService.syncLead(updated)).catch(() => {});
        import('../services/googleService.js').then(m => m.googleService.syncLeadToSheet(updated)).catch(() => {});
      }
    }
  }
}

export interface ContactCacheInput {
  jid: string;
  name?: string | null;
  notify?: string | null;
  verifiedName?: string | null;
  source?: string;
}

/**
 * Save contact to contacts_cache table and automatically update any leads with missing names
 */
export function saveContactToCache(input: ContactCacheInput): void {
  if (!input.jid) return;
  const rawJid = input.jid.trim();
  const digits = extractDigitsOnly(rawJid);
  const now = new Date().toISOString();

  const cleanName = cleanValidCustomerName(input.name);
  const cleanNotify = cleanValidCustomerName(input.notify);
  const cleanVerified = cleanValidCustomerName(input.verifiedName);

  db.prepare(`
    INSERT INTO contacts_cache (jid, phone_digits, name, notify, verified_name, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET
      phone_digits = COALESCE(excluded.phone_digits, contacts_cache.phone_digits),
      name = COALESCE(NULLIF(excluded.name, ''), contacts_cache.name),
      notify = COALESCE(NULLIF(excluded.notify, ''), contacts_cache.notify),
      verified_name = COALESCE(NULLIF(excluded.verified_name, ''), contacts_cache.verified_name),
      updated_at = excluded.updated_at
  `).run(
    rawJid,
    digits || null,
    cleanName || null,
    cleanNotify || null,
    cleanVerified || null,
    now
  );

  const bestName = cleanName || cleanNotify || cleanVerified;
  if (bestName) {
    updateLeadNameByJid(rawJid, bestName);
    if (digits) {
      updateLeadNameByPhone(digits, bestName);
    }
    if (rawJid.endsWith('@lid')) {
      saveLidPhoneMapping(rawJid, '', input.source || 'contact_cache', bestName);
    }
  }
}

/**
 * Query contacts_cache table for contact/push/business name by JIDs or phone digits
 */
export function lookupContactNameFromCache(jids: (string | null | undefined)[] | string): string | null {
  const candidateList = Array.isArray(jids) ? jids.filter(Boolean) as string[] : (jids ? [jids] : []);
  for (const jid of candidateList) {
    if (!jid) continue;
    const cleanJid = jid.trim();

    // 1. Check exact JID match
    const row = db.prepare('SELECT name, notify, verified_name FROM contacts_cache WHERE jid = ?').get(cleanJid) as {
      name: string | null;
      notify: string | null;
      verified_name: string | null;
    } | undefined;

    if (row) {
      const best = cleanValidCustomerName(row.name) || cleanValidCustomerName(row.notify) || cleanValidCustomerName(row.verified_name);
      if (best) return best;
    }

    // 2. Check phone digits match
    const digits = extractDigitsOnly(cleanJid);
    if (digits) {
      const phoneRow = db.prepare('SELECT name, notify, verified_name FROM contacts_cache WHERE phone_digits = ?').get(digits) as {
        name: string | null;
        notify: string | null;
        verified_name: string | null;
      } | undefined;
      if (phoneRow) {
        const best = cleanValidCustomerName(phoneRow.name) || cleanValidCustomerName(phoneRow.notify) || cleanValidCustomerName(phoneRow.verified_name);
        if (best) return best;
      }
    }
  }
  return null;
}


// LID → Phone Number Mapping Functions

export function normalizeLidJid(lid: string | null | undefined): string | null {
  if (!lid) return null;
  const raw = lid.trim().split('@')[0].split(':')[0];
  return raw ? `${raw}@lid` : null;
}

export function normalizePhoneJid(phoneJid: string | null | undefined): string | null {
  if (!phoneJid || phoneJid.includes('@lid')) return null;
  const digits = phoneJid.split('@')[0].split(':')[0].replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 13 ? `${digits}@s.whatsapp.net` : null;
}

export function saveLidPhoneMapping(lid: string, phoneJid: string, source: string, contactName?: string | null): void {
  const normalizedLid = normalizeLidJid(lid);
  const normalizedPhoneJid = normalizePhoneJid(phoneJid);
  if (!normalizedLid || !normalizedPhoneJid) return;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO lid_phone_map (lid, phone_jid, contact_name, source, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(lid) DO UPDATE SET
      phone_jid = excluded.phone_jid,
      contact_name = COALESCE(NULLIF(excluded.contact_name, ''), lid_phone_map.contact_name),
      source = excluded.source,
      created_at = excluded.created_at
  `).run(normalizedLid, normalizedPhoneJid, contactName?.trim() || null, source, now);

  console.log(`[dev] lid_phone_mapped: ${lid.substring(0, 6)}...@lid → phone resolved (source: ${source})`);

  // Retroactively update any existing lead that was created with this LID
  let existingLead = db.prepare(`
    SELECT leads.* FROM leads
    JOIN lead_identities ON leads.id = lead_identities.lead_id
    WHERE lead_identities.jid = ?
  `).get(normalizedLid) as Lead | undefined;

  // Fallback: also check leads table directly by lead_identity or whatsapp_jid
  if (!existingLead) {
    existingLead = db.prepare('SELECT * FROM leads WHERE lead_identity = ? OR whatsapp_jid = ?').get(normalizedLid, normalizedLid) as Lead | undefined;
  }

  if (existingLead && (!existingLead.whatsapp_phone || existingLead.whatsapp_phone.includes('@lid') || existingLead.whatsapp_phone === 'WhatsApp ID unavailable')) {
    const digits = normalizedPhoneJid.split('@')[0].replace(/\D/g, '');
    if (digits.length >= 7) {
      const displayPhone = `+${digits}`;
      db.prepare('UPDATE leads SET whatsapp_phone = ?, updated_at = ? WHERE id = ?').run(displayPhone, now, existingLead.id);

      // Also attach the PN JID alias
      db.prepare('INSERT OR IGNORE INTO lead_identities (lead_id, jid, jid_type, created_at) VALUES (?, ?, ?, ?)').run(existingLead.id, normalizedPhoneJid, 'pn', now);

      // Update canonical identity to prefer PN
      db.prepare('UPDATE leads SET lead_identity = ?, whatsapp_jid = ? WHERE id = ? AND lead_identity LIKE ?').run(normalizedPhoneJid, normalizedPhoneJid, existingLead.id, '%@lid');

      console.log(`[dev] lid_lead_phone_updated: Lead #${existingLead.id} retroactively updated with phone ${displayPhone}`);

      // Broadcast SSE update so dashboard refreshes
      sseService.broadcast('dashboard_update', { leadId: existingLead.id, state: 'phone_resolved' });
    }
  }

  // Also retroactively set customer_name if provided and currently null/N/A
  if (existingLead && (!existingLead.customer_name || existingLead.customer_name === 'N/A') && contactName && contactName.trim()) {
    db.prepare('UPDATE leads SET customer_name = ?, updated_at = ? WHERE id = ?').run(contactName.trim(), now, existingLead.id);
    console.log(`[dev] lid_lead_name_updated: Lead #${existingLead.id} name set to "${contactName.trim()}" via ${source}`);
    sseService.broadcast('dashboard_update', { leadId: existingLead.id, state: 'name_resolved' });
  }
}

export function lookupPhoneByLid(lid: string): string | null {
  const normalizedLid = normalizeLidJid(lid);
  if (!normalizedLid) return null;
  const row = db.prepare('SELECT phone_jid FROM lid_phone_map WHERE lid = ?').get(normalizedLid) as { phone_jid: string } | undefined;
  return row?.phone_jid || null;
}

export function lookupContactNameByLid(lid: string): string | null {
  const normalizedLid = normalizeLidJid(lid);
  if (!normalizedLid) return null;
  const row = db.prepare('SELECT contact_name FROM lid_phone_map WHERE lid = ?').get(normalizedLid) as { contact_name: string | null } | undefined;
  return row?.contact_name?.trim() || null;
}

// Canonical Identity Resolution & Aliasing Functions

export function findLeadByAnyJid(jids: string[], channelId?: string): Lead | undefined {
  if (!jids || jids.length === 0) return undefined;

  for (const jid of jids) {
    if (!jid) continue;
    // 1. Search in lead_identities (scoped to channel if provided)
    if (channelId) {
      const identityRow = db.prepare(`
        SELECT leads.* FROM leads
        JOIN lead_identities ON leads.id = lead_identities.lead_id
        WHERE lead_identities.jid = ? AND leads.channel_id = ?
      `).get(jid, channelId) as Lead | undefined;

      if (identityRow) return identityRow;

      // 2. Search in leads table directly (scoped to channel)
      const leadRow = db.prepare('SELECT * FROM leads WHERE (lead_identity = ? OR whatsapp_jid = ?) AND channel_id = ?').get(jid, jid, channelId) as Lead | undefined;
      if (leadRow) return leadRow;
    } else {
      const identityRow = db.prepare(`
        SELECT leads.* FROM leads
        JOIN lead_identities ON leads.id = lead_identities.lead_id
        WHERE lead_identities.jid = ?
      `).get(jid) as Lead | undefined;

      if (identityRow) return identityRow;

      // 2. Search in leads table directly
      const leadRow = db.prepare('SELECT * FROM leads WHERE lead_identity = ? OR whatsapp_jid = ?').get(jid, jid) as Lead | undefined;
      if (leadRow) return leadRow;
    }
  }

  return undefined;
}

export function attachAliasToLead(leadId: number, jid: string, jidType: 'pn' | 'lid' | 'other'): void {
  if (!jid) return;
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO lead_identities (lead_id, jid, jid_type, created_at)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(leadId, jid, jidType, now);
}

export function mergeLeads(canonicalLeadId: number, duplicateLeadId: number): void {
  if (canonicalLeadId === duplicateLeadId) return;

  const now = new Date().toISOString();

  // Reassign messages
  db.prepare('UPDATE messages SET lead_id = ? WHERE lead_id = ?').run(canonicalLeadId, duplicateLeadId);

  // Reassign lead_identities
  db.prepare('UPDATE OR IGNORE lead_identities SET lead_id = ? WHERE lead_id = ?').run(canonicalLeadId, duplicateLeadId);
  db.prepare('DELETE FROM lead_identities WHERE lead_id = ?').run(duplicateLeadId);

  // Recompute timestamps & latest message
  const msgStats = db.prepare(`
    SELECT
      MIN(sent_at) as first_act,
      MAX(sent_at) as last_act
    FROM messages WHERE lead_id = ?
  `).get(canonicalLeadId) as { first_act: string; last_act: string } | undefined;

  const latestMsg = db.prepare(`
    SELECT message_text FROM messages WHERE lead_id = ? ORDER BY sent_at DESC LIMIT 1
  `).get(canonicalLeadId) as { message_text: string } | undefined;

  db.prepare(`
    UPDATE leads SET
      first_activity_at = COALESCE(?, first_activity_at),
      last_activity_at = COALESCE(?, last_activity_at),
      latest_message = COALESCE(?, latest_message),
      updated_at = ?
    WHERE id = ?
  `).run(
    msgStats?.first_act || null,
    msgStats?.last_act || null,
    latestMsg?.message_text || null,
    now,
    canonicalLeadId
  );

  // Delete duplicate lead
  db.prepare('DELETE FROM leads WHERE id = ?').run(duplicateLeadId);
}

export interface IngestMessageCanonicalInput {
  channel_id?: string;
  wa_message_id: string;
  canonicalJid: string;
  candidateJids: string[];
  direction: 'incoming' | 'outgoing';
  sender_name?: string | null;
  message_text: string;
  message_type: string;
  displayPhone: string | null;
  isBusinessSelf: boolean;
  sent_at: string;
}

export function saveMessageAndUpsertCanonicalLead(input: IngestMessageCanonicalInput): {
  skippedBusinessSelf: boolean;
  messageInserted: boolean;
  leadId: number | null;
} {
  // Rule C: Skip business self messages
  if (input.isBusinessSelf) {
    console.log('[dev] skipped_business_self_message: message belongs to connected business number');
    return { skippedBusinessSelf: true, messageInserted: false, leadId: null };
  }

  const channelId = input.channel_id;
  if (channelId) {
    ensureChannelExists(channelId);
  }
  const now = new Date().toISOString();

  // 1. Find existing lead by candidate JIDs scoped to channel
  let lead = findLeadByAnyJid(input.candidateJids, channelId);
  let leadId: number;

  if (!lead) {
    // Create new lead with channel_id
    const insertLeadStmt = db.prepare(`
      INSERT INTO leads (
        channel_id, lead_identity, whatsapp_jid, whatsapp_phone, customer_name, status, latest_message, first_activity_at, last_activity_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'analyzing', ?, ?, ?, ?, ?)
    `);

    const res = insertLeadStmt.run(
      channelId,
      input.canonicalJid,
      input.canonicalJid,
      input.displayPhone || null,
      input.sender_name || null,
      input.message_text,
      input.sent_at,
      input.sent_at,
      now,
      now
    );

    leadId = Number(res.lastInsertRowid);
  } else {
    leadId = lead.id;
  }

  // 2. Attach all candidate JIDs to lead_identities
  input.candidateJids.forEach(jid => {
    let type: 'pn' | 'lid' | 'other' = 'other';
    if (jid.endsWith('@lid')) type = 'lid';
    else if (jid.includes('@s.whatsapp.net')) type = 'pn';
    attachAliasToLead(leadId, jid, type);
  });

  // 3. Idempotently insert message
  const msgStmt = db.prepare(`
    INSERT INTO messages (
      wa_message_id, lead_identity, remote_jid, direction, sender_name, message_text, message_type, sent_at, created_at, lead_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(wa_message_id) DO UPDATE SET
      lead_id = COALESCE(messages.lead_id, excluded.lead_id),
      sender_name = COALESCE(excluded.sender_name, messages.sender_name),
      message_text = COALESCE(excluded.message_text, messages.message_text)
  `);

  const msgResult = msgStmt.run(
    input.wa_message_id,
    input.canonicalJid,
    input.canonicalJid,
    input.direction,
    input.sender_name || null,
    input.message_text,
    input.message_type,
    input.sent_at,
    now,
    leadId
  );

  const messageInserted = msgResult.changes > 0;

  if (messageInserted) {
    const cleanSenderName = cleanValidCustomerName(input.sender_name);

    db.prepare(`
      UPDATE leads SET
        latest_message = ?,
        last_activity_at = ?,
        updated_at = ?,
        customer_name = CASE 
          WHEN ? IS NOT NULL AND (customer_name IS NULL OR customer_name = '' OR customer_name = 'N/A' OR LOWER(customer_name) = 'business' OR LOWER(customer_name) = 'customer' OR LOWER(customer_name) = 'interested') 
          THEN ? 
          ELSE customer_name 
        END,
        whatsapp_phone = CASE 
          WHEN NULLIF(?, '') IS NOT NULL AND (whatsapp_phone IS NULL OR whatsapp_phone = '' OR whatsapp_phone LIKE '%@lid' OR whatsapp_phone = 'WhatsApp ID unavailable') 
          THEN ? 
          ELSE whatsapp_phone 
        END
      WHERE id = ?
    `).run(
      input.message_text,
      input.sent_at,
      now,
      cleanSenderName,
      cleanSenderName,
      input.displayPhone || '',
      input.displayPhone || '',
      leadId
    );

    // Broadcast SSE live update
    sseService.broadcast('dashboard_update', { leadId, channelId, state: 'message_inserted' });
    sseService.broadcast('chat_update', { leadId, channelId, state: 'message_inserted' });
  }

  return { skippedBusinessSelf: false, messageInserted, leadId };
}

export function getAllLeads(): Lead[] {
  const stmt = db.prepare('SELECT * FROM leads ORDER BY updated_at DESC');
  return stmt.all() as Lead[];
}

export function getAllLeadsByChannel(channelId: string): Lead[] {
  const stmt = db.prepare('SELECT * FROM leads WHERE channel_id = ? ORDER BY updated_at DESC');
  return stmt.all(channelId) as Lead[];
}

export function getRecentLeads(limit: number = 5): Lead[] {
  const stmt = db.prepare('SELECT * FROM leads ORDER BY updated_at DESC LIMIT ?');
  return stmt.all(limit) as Lead[];
}

export function getLeadById(id: number): Lead | undefined {
  const stmt = db.prepare('SELECT * FROM leads WHERE id = ?');
  return stmt.get(id) as Lead | undefined;
}

export function getMessagesByLeadId(leadId: number): Message[] {
  let msgs = db.prepare('SELECT * FROM messages WHERE lead_id = ? ORDER BY sent_at ASC').all(leadId) as Message[];
  if (msgs.length === 0) {
    // Fallback: recover messages by lead's known JID identities
    const lead = getLeadById(leadId);
    if (lead) {
      const identityRows = db.prepare('SELECT jid FROM lead_identities WHERE lead_id = ?').all(leadId) as { jid: string }[];
      const candidateJids = Array.from(new Set([lead.lead_identity, lead.whatsapp_jid, ...identityRows.map(r => r.jid)].filter(Boolean))) as string[];
      if (candidateJids.length > 0) {
        const placeholders = candidateJids.map(() => '?').join(',');
        msgs = db.prepare(`
          SELECT * FROM messages 
          WHERE lead_identity IN (${placeholders}) OR remote_jid IN (${placeholders})
          ORDER BY sent_at ASC
        `).all(...candidateJids, ...candidateJids) as Message[];

        // Backfill lead_id on recovered messages
        if (msgs.length > 0) {
          for (const m of msgs) {
            if (!m.lead_id) {
              db.prepare('UPDATE messages SET lead_id = ? WHERE id = ?').run(leadId, m.id);
            }
          }
        }
      }

      // Fallback 2: Even on server restart / clean disk, if msgs is empty but lead has latest_message,
      // synthesize and persist the message row so chats are NEVER missing!
      if (msgs.length === 0 && lead.latest_message && lead.latest_message.trim()) {
        const sentTime = lead.last_activity_at || lead.first_activity_at || lead.created_at || new Date().toISOString();
        const synthWaId = `synth_${lead.id}`;
        db.prepare(`
          INSERT OR IGNORE INTO messages (
            wa_message_id, lead_identity, remote_jid, direction, sender_name, message_text, message_type, sent_at, created_at, lead_id
          ) VALUES (?, ?, ?, 'incoming', ?, ?, 'text', ?, ?, ?)
        `).run(
          synthWaId,
          lead.lead_identity || lead.whatsapp_jid || '',
          lead.whatsapp_jid || lead.lead_identity || '',
          lead.customer_name && lead.customer_name !== 'N/A' ? lead.customer_name : 'Customer',
          lead.latest_message.trim(),
          sentTime,
          lead.created_at || new Date().toISOString(),
          lead.id
        );
        msgs = db.prepare('SELECT * FROM messages WHERE lead_id = ? ORDER BY sent_at ASC').all(leadId) as Message[];
      }
    }
  }
  return msgs;
}

export interface PaginatedLeadsResult {
  leads: Lead[];
  total: number;
  page: number;
  totalPages: number;
}

export function getPaginatedLeads(params: {
  search?: string;
  status?: string;
  page?: number;
  limit?: number;
}): PaginatedLeadsResult {
  const page = Math.max(1, params.page || 1);
  const limit = Math.max(1, params.limit || 10);
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const queryParams: (string | number)[] = [];

  if (params.search && params.search.trim() !== '') {
    const searchPattern = `%${params.search.trim()}%`;
    conditions.push(`
      (leads.customer_name LIKE ? OR leads.whatsapp_phone LIKE ? OR leads.lead_identity LIKE ? OR leads.id IN (
        SELECT lead_id FROM lead_identities WHERE jid LIKE ?
      ))
    `);
    queryParams.push(searchPattern, searchPattern, searchPattern, searchPattern);
  }

  if (params.status && params.status !== 'all') {
    conditions.push('leads.status = ?');
    queryParams.push(params.status);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Count total records
  const countStmt = db.prepare(`SELECT COUNT(DISTINCT leads.id) as count FROM leads ${whereClause}`);
  const total = (countStmt.get(...queryParams) as { count: number }).count;

  // Fetch paginated leads
  const dataStmt = db.prepare(`SELECT DISTINCT leads.* FROM leads ${whereClause} ORDER BY leads.updated_at DESC LIMIT ? OFFSET ?`);
  const leads = dataStmt.all(...queryParams, limit, offset) as Lead[];

  return {
    leads,
    total,
    page,
    totalPages: Math.ceil(total / limit)
  };
}

export function getLeadStatsByChannel(channelId: string): LeadStats {
  const rows = db.prepare('SELECT status, COUNT(*) as count FROM leads WHERE channel_id = ? GROUP BY status').all(channelId) as { status: string; count: number }[];

  const stats: LeadStats = {
    total: 0,
    analyzing: 0,
    interested: 0,
    not_interested: 0,
    undecided: 0
  };

  rows.forEach(row => {
    stats.total += row.count;
    if (row.status === 'analyzing') stats.analyzing = row.count;
    else if (row.status === 'interested') stats.interested = row.count;
    else if (row.status === 'not_interested') stats.not_interested = row.count;
    else if (row.status === 'undecided') stats.undecided = row.count;
  });

  return stats;
}

export function getRecentLeadsByChannel(channelId: string, limit: number = 5): Lead[] {
  const stmt = db.prepare('SELECT * FROM leads WHERE channel_id = ? ORDER BY updated_at DESC LIMIT ?');
  return stmt.all(channelId, limit) as Lead[];
}

export function getPaginatedLeadsByChannel(params: {
  channelId: string;
  search?: string;
  status?: string;
  page?: number;
  limit?: number;
}): PaginatedLeadsResult {
  const page = Math.max(1, params.page || 1);
  const limit = Math.max(1, params.limit || 10);
  const offset = (page - 1) * limit;

  const conditions: string[] = ['leads.channel_id = ?'];
  const queryParams: (string | number)[] = [params.channelId];

  if (params.search && params.search.trim() !== '') {
    const searchPattern = `%${params.search.trim()}%`;
    conditions.push(`
      (leads.customer_name LIKE ? OR leads.whatsapp_phone LIKE ? OR leads.lead_identity LIKE ? OR leads.id IN (
        SELECT lead_id FROM lead_identities WHERE jid LIKE ?
      ))
    `);
    queryParams.push(searchPattern, searchPattern, searchPattern, searchPattern);
  }

  if (params.status && params.status !== 'all') {
    conditions.push('leads.status = ?');
    queryParams.push(params.status);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const countStmt = db.prepare(`SELECT COUNT(DISTINCT leads.id) as count FROM leads ${whereClause}`);
  const total = (countStmt.get(...queryParams) as { count: number }).count;

  const dataStmt = db.prepare(`SELECT DISTINCT leads.* FROM leads ${whereClause} ORDER BY leads.updated_at DESC LIMIT ? OFFSET ?`);
  const leads = dataStmt.all(...queryParams, limit, offset) as Lead[];

  return {
    leads,
    total,
    page,
    totalPages: Math.ceil(total / limit)
  };
}

// Pending Supabase Sync Queue Helpers

export interface PendingSyncRow {
  id: number;
  lead_id: number;
  attempts: number;
  last_error?: string | null;
  created_at: string;
  updated_at: string;
}

export function enqueuePendingSync(leadId: number, errorMsg?: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO pending_supabase_syncs (lead_id, attempts, last_error, created_at, updated_at)
    VALUES (?, 1, ?, ?, ?)
    ON CONFLICT(lead_id) DO UPDATE SET
      attempts = pending_supabase_syncs.attempts + 1,
      last_error = excluded.last_error,
      updated_at = excluded.updated_at
  `).run(leadId, errorMsg || null, now, now);
}

export function removePendingSync(leadId: number): void {
  db.prepare('DELETE FROM pending_supabase_syncs WHERE lead_id = ?').run(leadId);
}

export function getPendingSyncs(): (PendingSyncRow & { lead: Lead })[] {
  const rows = db.prepare(`
    SELECT p.*, l.channel_id, l.lead_identity, l.whatsapp_jid, l.whatsapp_phone, l.customer_name, l.status,
           l.latest_message, l.first_activity_at, l.last_activity_at, l.created_at as lead_created_at, l.updated_at as lead_updated_at
    FROM pending_supabase_syncs p
    JOIN leads l ON p.lead_id = l.id
    ORDER BY p.updated_at ASC
  `).all() as (PendingSyncRow & {
    channel_id: string;
    lead_identity: string;
    whatsapp_jid: string;
    whatsapp_phone: string | null;
    customer_name: string | null;
    status: string;
    latest_message: string | null;
    first_activity_at: string;
    last_activity_at: string;
    lead_created_at: string;
    lead_updated_at: string;
  })[];

  return rows.map(r => ({
    id: r.id,
    lead_id: r.lead_id,
    attempts: r.attempts,
    last_error: r.last_error,
    created_at: r.created_at,
    updated_at: r.updated_at,
    lead: {
      id: r.lead_id,
      channel_id: r.channel_id || '',
      lead_identity: r.lead_identity,
      whatsapp_jid: r.whatsapp_jid,
      whatsapp_phone: r.whatsapp_phone,
      customer_name: r.customer_name,
      status: r.status,
      latest_message: r.latest_message,
      first_activity_at: r.first_activity_at,
      last_activity_at: r.last_activity_at,
      created_at: r.lead_created_at,
      updated_at: r.lead_updated_at
    }
  }));
}

export function getPendingSyncCount(): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM pending_supabase_syncs').get() as { count: number };
  return row?.count || 0;
}

export function countLocalLeads(): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM leads').get() as { count: number };
  return row?.count || 0;
}

export function restoreLeadFromSupabaseBackup(data: {
  channel_id?: string;
  lead_identity: string;
  whatsapp_jid: string;
  whatsapp_phone?: string | null;
  customer_name?: string | null;
  status: string;
  latest_message?: string | null;
  first_activity_at: string;
  last_activity_at: string;
  qualification_reason?: string | null;
  confidence?: number | null;
  conversation_summary?: string | null;
  extracted_answers?: unknown;
  google_sheet_row_number?: number | null;
  created_at: string;
  updated_at: string;
}): void {
  const extractedAnswersStr = data.extracted_answers != null
    ? (typeof data.extracted_answers === 'string' ? data.extracted_answers : JSON.stringify(data.extracted_answers))
    : null;
  const channelId = data.channel_id || null;

  // Ensure referenced channel exists in local SQLite channels table if channel_id is present
  // Uses INSERT OR IGNORE to avoid overwriting real names restored from Supabase
  if (channelId) {
    db.prepare(`
      INSERT OR IGNORE INTO channels (id, name, status, created_at)
      VALUES (?, ?, 'active', datetime('now'))
    `).run(channelId, channelId);
  }

  const stmt = db.prepare(`
    INSERT INTO leads (
      channel_id, lead_identity, whatsapp_jid, whatsapp_phone, customer_name, status, latest_message,
      first_activity_at, last_activity_at, qualification_reason, confidence,
      conversation_summary, extracted_answers, google_sheet_row_number, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(lead_identity) DO UPDATE SET
      channel_id = COALESCE(excluded.channel_id, leads.channel_id),
      whatsapp_jid = excluded.whatsapp_jid,
      whatsapp_phone = COALESCE(excluded.whatsapp_phone, leads.whatsapp_phone),
      customer_name = COALESCE(excluded.customer_name, leads.customer_name),
      status = excluded.status,
      latest_message = COALESCE(excluded.latest_message, leads.latest_message),
      last_activity_at = excluded.last_activity_at,
      qualification_reason = COALESCE(excluded.qualification_reason, leads.qualification_reason),
      confidence = COALESCE(excluded.confidence, leads.confidence),
      conversation_summary = COALESCE(excluded.conversation_summary, leads.conversation_summary),
      extracted_answers = COALESCE(excluded.extracted_answers, leads.extracted_answers),
      google_sheet_row_number = COALESCE(excluded.google_sheet_row_number, leads.google_sheet_row_number),
      updated_at = excluded.updated_at
  `);
  stmt.run(
    channelId,
    data.lead_identity,
    data.whatsapp_jid,
    data.whatsapp_phone || null,
    data.customer_name || null,
    data.status,
    data.latest_message || null,
    data.first_activity_at,
    data.last_activity_at,
    data.qualification_reason || null,
    data.confidence != null ? data.confidence : null,
    data.conversation_summary || null,
    extractedAnswersStr,
    data.google_sheet_row_number != null ? data.google_sheet_row_number : null,
    data.created_at,
    data.updated_at
  );

  const leadRow = db.prepare('SELECT id FROM leads WHERE lead_identity = ?').get(data.lead_identity) as { id: number } | undefined;
  if (leadRow) {
    let jidType: 'pn' | 'lid' | 'other' = 'other';
    if (data.whatsapp_jid.endsWith('@lid')) jidType = 'lid';
    else if (data.whatsapp_jid.includes('@s.whatsapp.net')) jidType = 'pn';

    db.prepare(`
      INSERT OR IGNORE INTO lead_identities (lead_id, jid, jid_type, created_at)
      VALUES (?, ?, ?, ?)
    `).run(leadRow.id, data.whatsapp_jid, jidType, data.created_at);

    // Ensure at least the latest message is inserted in messages table so chats are never empty
    if (data.latest_message && data.latest_message.trim()) {
      const sentTime = data.last_activity_at || data.first_activity_at || data.created_at || new Date().toISOString();
      db.prepare(`
        INSERT OR IGNORE INTO messages (
          wa_message_id, lead_identity, remote_jid, direction, sender_name, message_text, message_type, sent_at, created_at, lead_id
        ) VALUES (?, ?, ?, 'incoming', ?, ?, 'text', ?, ?, ?)
      `).run(
        `restored_${leadRow.id}`,
        data.lead_identity,
        data.whatsapp_jid || data.lead_identity,
        data.customer_name && data.customer_name !== 'N/A' ? data.customer_name : 'Customer',
        data.latest_message.trim(),
        sentTime,
        data.created_at,
        leadRow.id
      );
    }
  }
}

export function updateLeadSheetRowNumber(leadId: number, rowNumber: number): void {
  const now = new Date().toISOString();
  db.prepare('UPDATE leads SET google_sheet_row_number = ?, updated_at = ? WHERE id = ?').run(rowNumber, now, leadId);
}

// Pending Google Sheet Sync Queue Helpers

export function enqueuePendingSheetSync(leadId: number, errorMsg?: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO pending_google_sheet_syncs (lead_id, attempts, last_error, created_at, updated_at)
    VALUES (?, 1, ?, ?, ?)
    ON CONFLICT(lead_id) DO UPDATE SET
      attempts = pending_google_sheet_syncs.attempts + 1,
      last_error = excluded.last_error,
      updated_at = excluded.updated_at
  `).run(leadId, errorMsg || null, now, now);
}

export function removePendingSheetSync(leadId: number): void {
  db.prepare('DELETE FROM pending_google_sheet_syncs WHERE lead_id = ?').run(leadId);
}

export function getPendingSheetSyncs(): (PendingSyncRow & { lead: Lead })[] {
  const rows = db.prepare(`
    SELECT p.*, l.channel_id, l.lead_identity, l.whatsapp_jid, l.whatsapp_phone, l.customer_name, l.status,
           l.latest_message, l.first_activity_at, l.last_activity_at, l.google_sheet_row_number,
           l.created_at as lead_created_at, l.updated_at as lead_updated_at
    FROM pending_google_sheet_syncs p
    JOIN leads l ON p.lead_id = l.id
    ORDER BY p.updated_at ASC
  `).all() as (PendingSyncRow & {
    channel_id: string;
    lead_identity: string;
    whatsapp_jid: string;
    whatsapp_phone: string | null;
    customer_name: string | null;
    status: string;
    latest_message: string | null;
    first_activity_at: string;
    last_activity_at: string;
    google_sheet_row_number: number | null;
    lead_created_at: string;
    lead_updated_at: string;
  })[];

  return rows.map(r => ({
    id: r.id,
    lead_id: r.lead_id,
    attempts: r.attempts,
    last_error: r.last_error,
    created_at: r.created_at,
    updated_at: r.updated_at,
    lead: {
      id: r.lead_id,
      channel_id: r.channel_id || '',
      lead_identity: r.lead_identity,
      whatsapp_jid: r.whatsapp_jid,
      whatsapp_phone: r.whatsapp_phone,
      customer_name: r.customer_name,
      status: r.status,
      latest_message: r.latest_message,
      first_activity_at: r.first_activity_at,
      last_activity_at: r.last_activity_at,
      google_sheet_row_number: r.google_sheet_row_number,
      created_at: r.lead_created_at,
      updated_at: r.lead_updated_at
    }
  }));
}

export function getPendingSheetSyncCount(channelId?: string): number {
  if (channelId) {
    const row = db.prepare(`
      SELECT COUNT(*) as count 
      FROM pending_google_sheet_syncs p
      JOIN leads l ON p.lead_id = l.id
      WHERE l.channel_id = ?
    `).get(channelId) as { count: number };
    return row?.count || 0;
  }
  const row = db.prepare('SELECT COUNT(*) as count FROM pending_google_sheet_syncs').get() as { count: number };
  return row?.count || 0;
}

// Phase 7: Groq Debounce & Analysis Helpers

export function updateLeadInactivityDebounce(leadId: number, lastActivityIso: string): void {
  // Set analysis_due_at = last_activity_at + 2 minutes (120,000 ms)
  const actDate = new Date(lastActivityIso);
  const dueIso = new Date(actDate.getTime() + 2 * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE leads SET
      last_activity_at = ?,
      analysis_due_at = ?,
      updated_at = ?
    WHERE id = ?
  `).run(lastActivityIso, dueIso, now, leadId);

  console.log(`[analysis_scheduled] lead_id=${leadId} due_at=${dueIso}`);
}

export function getLeadsDueForAnalysis(): Lead[] {
  const now = new Date().toISOString();
  const rows = db.prepare(`
    SELECT * FROM leads
    WHERE analysis_due_at IS NOT NULL
      AND analysis_due_at <= ?
    ORDER BY analysis_due_at ASC
  `).all(now) as Lead[];

  return rows;
}

export function saveLeadAnalysisResult(leadId: number, result: {
  status: 'interested' | 'not_interested' | 'undecided';
  conversion_score?: 'Hot' | 'Warm' | 'Cold' | string;
  confidence: number;
  qualification_reason: string;
  customer_name?: string | null;
  answers: Record<string, string | null>;
  conversation_summary: string;
}): Lead | undefined {
  const now = new Date().toISOString();
  const existingLead = getLeadById(leadId);

  // Merge new non-null answers with previously extracted answers
  let mergedAnswers: Record<string, string | null> = {};
  if (existingLead && existingLead.extracted_answers) {
    try {
      mergedAnswers = typeof existingLead.extracted_answers === 'string'
        ? JSON.parse(existingLead.extracted_answers)
        : (existingLead.extracted_answers || {});
    } catch {
      mergedAnswers = {};
    }
  }

  if (result.answers) {
    for (const [key, val] of Object.entries(result.answers)) {
      if (val !== null && val !== undefined && val !== '') {
        mergedAnswers[key] = val;
      }
    }
  }

    const cleanCustomerName = cleanValidCustomerName(result.customer_name);

    db.prepare(`
      UPDATE leads SET
        status = ?,
        conversion_score = ?,
        confidence = ?,
        qualification_reason = ?,
        conversation_summary = ?,
        extracted_answers = ?,
        customer_name = CASE
          WHEN ? IS NOT NULL AND (customer_name IS NULL OR customer_name = '' OR customer_name = 'N/A' OR LOWER(customer_name) = 'business' OR LOWER(customer_name) = 'customer' OR LOWER(customer_name) = 'interested')
          THEN ?
          ELSE customer_name
        END,
        last_analyzed_at = ?,
        analysis_due_at = NULL,
        analysis_error = NULL,
        updated_at = ?
      WHERE id = ?
    `).run(
      result.status,
      result.conversion_score || null,
      result.confidence,
      result.qualification_reason,
      result.conversation_summary,
      JSON.stringify(mergedAnswers),
      cleanCustomerName,
      cleanCustomerName,
      now,
      now,
      leadId
    );

  return getLeadById(leadId);
}

export function getLeadConversionScore(lead: { conversion_score?: string | null; status?: string | null; confidence?: number | null }): 'Hot' | 'Warm' | 'Cold' {
  if (lead.conversion_score === 'Hot' || lead.conversion_score === 'Warm' || lead.conversion_score === 'Cold') {
    return lead.conversion_score;
  }
  if (lead.status === 'interested') {
    return (lead.confidence || 0) >= 0.7 ? 'Hot' : 'Warm';
  }
  if (lead.status === 'not_interested') {
    return 'Cold';
  }
  return 'Warm';
}

export function setLeadAnalysisError(leadId: number, errorMsg: string): void {
  const now = new Date().toISOString();
  // Set retry due_at for 1 minute in future to avoid tight loops on API failure
  const retryDue = new Date(Date.now() + 60 * 1000).toISOString();

  db.prepare(`
    UPDATE leads SET
      analysis_error = ?,
      analysis_due_at = ?,
      updated_at = ?
    WHERE id = ?
  `).run(errorMsg, retryDue, now, leadId);
}

export function updateLeadContactInfo(leadId: number, name?: string | null, phone?: string | null, status?: string | null): Lead | undefined {
  const lead = getLeadById(leadId);
  if (!lead) return undefined;

  const now = new Date().toISOString();
  let cleanName = name !== undefined && name !== null ? name.trim() : lead.customer_name;
  if (cleanName === '') cleanName = null;

  let cleanPhone = lead.whatsapp_phone;
  if (phone !== undefined && phone !== null && phone.trim() !== '') {
    const raw = phone.trim();
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 7) {
      cleanPhone = `+${digits}`;
    } else {
      cleanPhone = raw;
    }
  }

  const validStatuses = ['analyzing', 'interested', 'not_interested', 'undecided'];
  let cleanStatus = lead.status;
  if (status && validStatuses.includes(status)) {
    cleanStatus = status;
  }

  db.prepare(`
    UPDATE leads SET
      customer_name = ?,
      whatsapp_phone = ?,
      status = ?,
      updated_at = ?
    WHERE id = ?
  `).run(cleanName, cleanPhone, cleanStatus, now, leadId);

  const updatedLead = getLeadById(leadId);
  console.log(`[dev] lead_contact_updated: Lead #${leadId} name="${cleanName}" phone="${cleanPhone}"`);
  sseService.broadcast('dashboard_update', { leadId, channelId: updatedLead?.channel_id, state: 'contact_updated' });
  sseService.broadcast('chat_update', { leadId, channelId: updatedLead?.channel_id, state: 'contact_updated' });

  if (updatedLead) {
    import('../services/supabaseService.js').then(m => m.supabaseService.syncLead(updatedLead)).catch(() => {});
    import('../services/googleService.js').then(m => m.googleService.syncLeadToSheet(updatedLead)).catch(() => {});
  }

  return updatedLead;
}

export function updateLeadFromGoogleSheet(input: {
  leadId: number;
  name?: string | null;
  phone?: string | null;
  status?: string | null;
  firmCompany?: string | null;
  cpDeveloper?: string | null;
  location?: string | null;
  requirement?: string | null;
  budget?: string | null;
  summary?: string | null;
}): Lead | undefined {
  const lead = getLeadById(input.leadId);
  if (!lead) return undefined;

  const now = new Date().toISOString();

  let cleanName = input.name !== undefined && input.name !== null && input.name !== 'unknown' ? input.name.trim() : lead.customer_name;
  if (cleanName === '' || cleanName === 'unknown') cleanName = null;

  let cleanPhone = lead.whatsapp_phone;
  if (input.phone !== undefined && input.phone !== null && input.phone !== 'unknown' && input.phone.trim() !== '') {
    const raw = input.phone.trim();
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 7) {
      cleanPhone = `+${digits}`;
    } else {
      cleanPhone = raw;
    }
  }

  const validStatuses = ['analyzing', 'interested', 'not_interested', 'undecided'];
  let cleanStatus = lead.status;
  if (input.status && validStatuses.includes(input.status.toLowerCase())) {
    cleanStatus = input.status.toLowerCase() as 'analyzing' | 'interested' | 'not_interested' | 'undecided';
  }

  // Merge extracted answers
  let existingAnswers: Record<string, string | null> = {};
  if (lead.extracted_answers) {
    try {
      existingAnswers = typeof lead.extracted_answers === 'string'
        ? JSON.parse(lead.extracted_answers)
        : (lead.extracted_answers || {});
    } catch {}
  }

  if (input.firmCompany !== undefined && input.firmCompany !== 'unknown') existingAnswers.firm_company = input.firmCompany;
  if (input.cpDeveloper !== undefined && input.cpDeveloper !== 'unknown') existingAnswers.cp_developer = input.cpDeveloper;
  if (input.location !== undefined && input.location !== 'unknown') existingAnswers.location = input.location;
  if (input.requirement !== undefined && input.requirement !== 'unknown') existingAnswers.requirement = input.requirement;
  if (input.budget !== undefined && input.budget !== 'unknown') existingAnswers.budget = input.budget;

  let cleanSummary = lead.conversation_summary;
  if (input.summary !== undefined && input.summary !== null && input.summary !== 'unknown') {
    cleanSummary = input.summary.trim();
  }

  const isSameName = (cleanName || null) === (lead.customer_name || null);
  const isSamePhone = (cleanPhone || null) === (lead.whatsapp_phone || null);
  const isSameStatus = cleanStatus === lead.status;
  const isSameSummary = (cleanSummary || null) === (lead.conversation_summary || null);
  const isSameAnswers = JSON.stringify(existingAnswers) === JSON.stringify(lead.extracted_answers ? (typeof lead.extracted_answers === 'string' ? JSON.parse(lead.extracted_answers) : lead.extracted_answers) : {});

  if (isSameName && isSamePhone && isSameStatus && isSameSummary && isSameAnswers) {
    return lead;
  }

  db.prepare(`
    UPDATE leads SET
      customer_name = ?,
      whatsapp_phone = ?,
      status = ?,
      extracted_answers = ?,
      conversation_summary = ?,
      updated_at = ?
    WHERE id = ?
  `).run(cleanName, cleanPhone, cleanStatus, JSON.stringify(existingAnswers), cleanSummary, now, input.leadId);

  console.log(`[dev] google_sheet_reverse_sync: Lead #${input.leadId} status="${cleanStatus}" updated from Sheet`);
  sseService.broadcast('dashboard_update', { leadId: input.leadId, channelId: lead.channel_id, state: 'sheet_synced_to_db' });
  sseService.broadcast('chat_update', { leadId: input.leadId, channelId: lead.channel_id, state: 'sheet_synced_to_db' });

  const updatedLead = getLeadById(input.leadId);
  if (updatedLead) {
    import('../services/supabaseService.js').then(m => m.supabaseService.syncLead(updatedLead)).catch(() => {});
  }

  return updatedLead;
}

export function getLeadDisplayPhone(lead: { id?: number; whatsapp_phone?: string | null; whatsapp_jid?: string | null; lead_identity?: string | null }): string {
  // 1. If whatsapp_phone is set with a valid real phone number (7-13 digits), return +<digits>
  if (lead.whatsapp_phone && lead.whatsapp_phone.trim() !== '' && !lead.whatsapp_phone.includes('@lid')) {
    const digits = lead.whatsapp_phone.replace(/\D/g, '');
    if (digits.length >= 7 && digits.length <= 13) {
      if (digits.length === 10) return `+91${digits}`;
      return `+${digits}`;
    }
  }

  // 2. Check lid_phone_map table for resolved phone number
  const lidCandidates = [lead.lead_identity, lead.whatsapp_jid].filter(
    (jid): jid is string => !!jid && jid.endsWith('@lid')
  );

  for (const lid of lidCandidates) {
    const phoneJid = lookupPhoneByLid(lid);
    if (phoneJid) {
      const digits = phoneJid.split('@')[0].replace(/\D/g, '');
      if (digits.length >= 7 && digits.length <= 13) {
        const displayPhone = digits.length === 10 ? `+91${digits}` : `+${digits}`;
        if (lead.id) {
          const now = new Date().toISOString();
          db.prepare('UPDATE leads SET whatsapp_phone = ?, updated_at = ? WHERE id = ?').run(displayPhone, now, lead.id);
        }
        return displayPhone;
      }
    }
  }

  // 3. Check lead_identities table for any PN-type alias
  if (lead.id) {
    const pnAlias = db.prepare(`
      SELECT jid FROM lead_identities 
      WHERE lead_id = ? AND jid_type = 'pn' AND jid LIKE '%@s.whatsapp.net'
      LIMIT 1
    `).get(lead.id) as { jid: string } | undefined;

    if (pnAlias) {
      const digits = pnAlias.jid.split('@')[0].replace(/\D/g, '');
      if (digits.length >= 7 && digits.length <= 13) {
        const displayPhone = digits.length === 10 ? `+91${digits}` : `+${digits}`;
        const now = new Date().toISOString();
        db.prepare('UPDATE leads SET whatsapp_phone = ?, updated_at = ? WHERE id = ?').run(displayPhone, now, lead.id);
        return displayPhone;
      }
    }
  }

  // 4. Check if whatsapp_jid or lead_identity is a real phone JID (@s.whatsapp.net)
  const jidCandidates = [lead.whatsapp_jid, lead.lead_identity].filter(Boolean) as string[];
  for (const jid of jidCandidates) {
    if (jid.includes('@s.whatsapp.net') || !jid.endsWith('@lid')) {
      const clean = jid.split('@')[0].split(':')[0];
      const digits = clean.replace(/\D/g, '');
      if (digits.length >= 7 && digits.length <= 13) {
        const displayPhone = digits.length === 10 ? `+91${digits}` : `+${digits}`;
        if (lead.id) {
          const now = new Date().toISOString();
          db.prepare('UPDATE leads SET whatsapp_phone = ?, updated_at = ? WHERE id = ?').run(displayPhone, now, lead.id);
        }
        return displayPhone;
      }
    }
  }

  // 5. Scan messages table for phone numbers sent in conversation text
  if (lead.id) {
    const incomingMsgs = db.prepare("SELECT message_text FROM messages WHERE lead_id = ? AND direction = 'incoming' ORDER BY sent_at ASC").all(lead.id) as { message_text: string }[];
    for (const msg of incomingMsgs) {
      if (!msg.message_text) continue;
      const match = msg.message_text.match(/(?:^|\s)(?:\+?91[\s-]?)?([6-9]\d{9})(?:$|\s|\.|\,)/) || msg.message_text.match(/(?:^|\s|\+)(\d{10,13})(?:$|\s|\.|\,)/);
      if (match && match[1]) {
        const digits = match[1].replace(/\D/g, '');
        if (digits.length >= 7 && digits.length <= 13) {
          const displayPhone = digits.length === 10 ? `+91${digits}` : `+${digits}`;
          const now = new Date().toISOString();
          db.prepare('UPDATE leads SET whatsapp_phone = ?, updated_at = ? WHERE id = ?').run(displayPhone, now, lead.id);
          return displayPhone;
        }
      }
    }
  }

  return 'Pending Phone Sync';
}

export function getLeadDisplayName(lead: {
  id?: number | string;
  customer_name?: string | null;
  lead_identity?: string | null;
  whatsapp_jid?: string | null;
  whatsapp_phone?: string | null;
  extracted_answers?: string | Record<string, unknown> | null;
}): string {
  // 1. Direct customer_name if valid
  const directClean = cleanValidCustomerName(lead.customer_name);
  if (directClean) {
    return directClean;
  }

  // 2. Check contacts_cache table by candidate JIDs and phone digits
  const candidateJids = [lead.lead_identity, lead.whatsapp_jid, lead.whatsapp_phone].filter(Boolean) as string[];
  const cachedContactName = lookupContactNameFromCache(candidateJids);
  if (cachedContactName) {
    if (lead.id && typeof lead.id === 'number') {
      const now = new Date().toISOString();
      db.prepare('UPDATE leads SET customer_name = ?, updated_at = ? WHERE id = ?').run(cachedContactName, now, lead.id);
    }
    return cachedContactName;
  }

  // 3. Check lid_phone_map table for contact name
  const lidCandidates = [lead.lead_identity, lead.whatsapp_jid].filter(
    (jid): jid is string => !!jid && jid.endsWith('@lid')
  );

  for (const lid of lidCandidates) {
    const contactName = lookupContactNameByLid(lid);
    const cleanLidName = cleanValidCustomerName(contactName);
    if (cleanLidName) {
      if (lead.id && typeof lead.id === 'number') {
        const now = new Date().toISOString();
        db.prepare('UPDATE leads SET customer_name = ?, updated_at = ? WHERE id = ?').run(cleanLidName, now, lead.id);
      }
      return cleanLidName;
    }
  }

  // 4. Check messages table for incoming or latest sender_name
  if (lead.id && typeof lead.id === 'number') {
    const msg = db.prepare(`
      SELECT sender_name FROM messages 
      WHERE lead_id = ? AND sender_name IS NOT NULL AND sender_name != ''
      ORDER BY CASE WHEN direction = 'incoming' THEN 1 ELSE 2 END, sent_at DESC LIMIT 1
    `).get(lead.id) as { sender_name: string } | undefined;

    const cleanMsgName = cleanValidCustomerName(msg?.sender_name);
    if (cleanMsgName) {
      const now = new Date().toISOString();
      db.prepare('UPDATE leads SET customer_name = ?, updated_at = ? WHERE id = ?').run(cleanMsgName, now, lead.id);
      return cleanMsgName;
    }
  }

  // 5. Check extracted answers for customer_name or firm_company
  if (lead.extracted_answers) {
    try {
      const answers = typeof lead.extracted_answers === 'string' ? JSON.parse(lead.extracted_answers) : lead.extracted_answers;
      const cleanFirm = cleanValidCustomerName(answers?.customer_name || answers?.name || answers?.firm_company);
      if (cleanFirm) {
        if (lead.id && typeof lead.id === 'number') {
          const now = new Date().toISOString();
          db.prepare('UPDATE leads SET customer_name = ?, updated_at = ? WHERE id = ?').run(cleanFirm, now, lead.id);
        }
        return cleanFirm;
      }
    } catch {}
  }

  // 6. Never show 'N/A' to the user! Fall back to clean phone number or WhatsApp Contact
  if (lead.whatsapp_phone && lead.whatsapp_phone !== 'WhatsApp ID unavailable' && !lead.whatsapp_phone.includes('@lid')) {
    return lead.whatsapp_phone;
  }

  return 'WhatsApp Contact';
}

/**
 * Scan all leads in SQLite and retroactively resolve names from contacts cache, LID map, messages, or profile
 */
export function retroactiveResolveAllLeadNames(): void {
  try {
    const allLeads = db.prepare('SELECT * FROM leads').all() as Lead[];
    const unresolvedLeads = allLeads.filter(lead => !cleanValidCustomerName(lead.customer_name));

    for (const lead of unresolvedLeads) {
      const resolvedName = getLeadDisplayName(lead);
      if (resolvedName && resolvedName !== 'WhatsApp Contact' && resolvedName !== lead.whatsapp_phone) {
        db.prepare('UPDATE leads SET customer_name = ?, updated_at = ? WHERE id = ?').run(resolvedName, new Date().toISOString(), lead.id);
        console.log(`[dev] retroactive_name_resolved: Lead #${lead.id} resolved name to "${resolvedName}"`);
        const updated = getLeadById(lead.id);
        if (updated) {
          import('../services/supabaseService.js').then(m => m.supabaseService.syncLead(updated)).catch(() => {});
          import('../services/googleService.js').then(m => m.googleService.syncLeadToSheet(updated)).catch(() => {});
        }
      }
    }
  } catch (err) {
    console.error('Error in retroactiveResolveAllLeadNames:', err);
  }
}

export function clearAllLeadsAndMessages(): { deletedLeads: number; deletedMessages: number } {
  const msgCount = (db.prepare('SELECT count(*) as c FROM messages').get() as { c: number }).c;
  const leadCount = (db.prepare('SELECT count(*) as c FROM leads').get() as { c: number }).c;

  db.exec(`
    DELETE FROM messages;
    DELETE FROM lead_identities;
    DELETE FROM pending_supabase_syncs;
    DELETE FROM pending_google_sheet_syncs;
    DELETE FROM leads;
  `);

  console.log(`[dev] db_cleared: Removed ${leadCount} leads and ${msgCount} messages.`);
  return { deletedLeads: leadCount, deletedMessages: msgCount };
}

export function closeDb(): void {
  try {
    const dbAny = db as unknown as { close?: () => void };
    if (typeof dbAny.close === 'function') {
      dbAny.close();
      console.log('[dev] db_closed: SQLite database connection closed safely.');
    }
  } catch (err) {
    console.error('Error closing SQLite DB:', err);
  }
}
