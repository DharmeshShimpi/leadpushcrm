import path from 'path';
import fs from 'fs';
import { db } from '../src/db/index.js';

console.log('[reset] Starting complete wipe of local SQLite database and cache...');

try {
  // Disable foreign keys temporarily for clean truncation
  db.exec('PRAGMA foreign_keys = OFF;');

  const tables = [
    'messages',
    'lead_identities',
    'lid_phone_map',
    'contacts_cache',
    'pending_supabase_syncs',
    'pending_google_sheet_syncs',
    'lead_analysis',
    'leads',
    'channels',
    'app_settings'
  ];

  for (const table of tables) {
    try {
      db.exec(`DELETE FROM ${table};`);
      console.log(`[reset] Cleared table: ${table}`);
    } catch (e: any) {
      console.log(`[reset] Table ${table} skip/error: ${e?.message}`);
    }
  }

  // Reset SQLite autoincrement sequences
  try {
    db.exec('DELETE FROM sqlite_sequence;');
  } catch {}

  db.exec('PRAGMA foreign_keys = ON;');
  
  try {
    db.exec('VACUUM;');
  } catch {}

  console.log('[reset] ✅ SQLite database completely wiped and compacted.');

  // Clean baileys-auth session data for a 100% fresh start if present
  const authDir = path.join(process.cwd(), 'data', 'baileys-auth');
  if (fs.existsSync(authDir)) {
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.mkdirSync(authDir, { recursive: true });
    console.log('[reset] ✅ WhatsApp auth session files cleared from data/baileys-auth.');
  }

} catch (err) {
  console.error('[reset] Error wiping SQLite:', err);
  process.exit(1);
}

process.exit(0);
