const path = require('path');
const fs = require('fs');

const dbPath = path.join(process.cwd(), 'data', 'leadpush.db');
console.log('[fast-wipe] Target database:', dbPath);

let db;
try {
  const Database = require('better-sqlite3');
  db = new Database(dbPath);
} catch {
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(dbPath);
}

try {
  db.exec('PRAGMA foreign_keys = OFF;');

  // Clear message, lead, and channel data for fresh start
  const tablesToClear = [
    'messages',
    'leads',
    'lead_identities',
    'lid_phone_map',
    'contacts_cache',
    'pending_supabase_syncs',
    'pending_google_sheet_syncs',
    'channels'
  ];

  for (const t of tablesToClear) {
    try {
      db.exec(`DELETE FROM ${t};`);
      console.log(`[fast-wipe] Cleared table: ${t}`);
    } catch (e) {
      console.log(`[fast-wipe] ${t} skipped (${e.message})`);
    }
  }

  try {
    db.exec("DELETE FROM sqlite_sequence WHERE name IN ('messages', 'leads', 'lead_identities', 'contacts_cache', 'pending_supabase_syncs', 'pending_google_sheet_syncs');");
  } catch {}

  db.exec('PRAGMA foreign_keys = ON;');

  try {
    db.exec('VACUUM;');
  } catch {}

  console.log('[fast-wipe] Preserved: channels, operators, settings, and WhatsApp connections.');
  console.log('[fast-wipe] Cleared: WhatsApp messages table.');

  try {
    if (typeof db.close === 'function') {
      db.close();
    }
  } catch {}

  console.log('[fast-wipe] Ready for fresh messages!');
} catch (err) {
  console.error('[fast-wipe] Error wiping messages:', err);
  process.exit(1);
}

process.exit(0);
