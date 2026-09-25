import { Router, Request, Response } from 'express';
import { requireSecretPath } from './dashboard.js';
import { requireAdmin } from '../middleware/auth.js';
import { db, mergeLeads, getAllLeads, getSetting } from '../db/index.js';
import { extractPhoneDigits } from '../services/whatsappService.js';
import { createRateLimiter } from '../utils/rateLimiter.js';

const router = Router();

// Rate limiter: max 3 destructive admin actions per 5 minutes per IP
const adminRateLimit = createRateLimiter(5 * 60 * 1000, 3, 'Too many admin requests. Please wait before trying again.');

// GET /app/:secret/admin/repair-identities (Confirmation page)
router.get('/app/:secret/admin/repair-identities', requireSecretPath, requireAdmin, (req: Request, res: Response) => {
  const secret = req.params.secret;
  res.render('repair_confirm', {
    appTitle: 'LeadPush',
    appSecret: secret,
    whatsAppConnected: true,
    googleSheetsConnected: false
  });
});

// POST /app/:secret/admin/repair-identities (Idempotent repair execution)
router.post('/app/:secret/admin/repair-identities', requireSecretPath, requireAdmin, adminRateLimit, (_req: Request, res: Response) => {
  const connectedBusinessPhone = getSetting('whatsapp_phone')?.value || null;
  const businessDigits = extractPhoneDigits(connectedBusinessPhone);

  let mergedLeadsCount = 0;
  let selfAccountLeadsRemoved = 0;
  let aliasesAttached = 0;
  let messagesReassigned = 0;
  let skippedRecords = 0;

  // Run inside a transaction when available (better-sqlite3)
  const runRepair = () => {
    // 1. Remove false leads representing the connected business number
    if (businessDigits) {
      const allLeads = getAllLeads();
      allLeads.forEach(lead => {
        const phoneDigits = extractPhoneDigits(lead.whatsapp_phone || lead.whatsapp_jid || lead.lead_identity);
        if (phoneDigits && phoneDigits === businessDigits) {
          db.prepare('DELETE FROM messages WHERE lead_id = ? OR lead_identity = ?').run(lead.id, lead.lead_identity);
          db.prepare('DELETE FROM lead_identities WHERE lead_id = ?').run(lead.id);
          db.prepare('DELETE FROM leads WHERE id = ?').run(lead.id);
          selfAccountLeadsRemoved++;
        }
      });
    }

    // 2. Scan and merge duplicate leads with matching phone digits or aliases
    const remainingLeads = getAllLeads();
    const phoneMap = new Map<string, number>();

    remainingLeads.forEach(lead => {
      const phoneDigits = extractPhoneDigits(lead.whatsapp_phone || lead.whatsapp_jid);
      if (phoneDigits) {
        if (phoneMap.has(phoneDigits)) {
          const canonicalLeadId = phoneMap.get(phoneDigits)!;
          if (canonicalLeadId !== lead.id) {
            mergeLeads(canonicalLeadId, lead.id);
            mergedLeadsCount++;
            messagesReassigned++;
          }
        } else {
          phoneMap.set(phoneDigits, lead.id);
        }
      } else {
        skippedRecords++;
      }
    });

    // 3. Re-sync identities
    const finalLeads = getAllLeads();
    finalLeads.forEach(lead => {
      const jid = lead.whatsapp_jid || lead.lead_identity;
      const type: 'pn' | 'lid' | 'other' = jid.endsWith('@lid') ? 'lid' : (jid.includes('@s.whatsapp.net') ? 'pn' : 'other');
      const result = db.prepare('INSERT OR IGNORE INTO lead_identities (lead_id, jid, jid_type, created_at) VALUES (?, ?, ?, ?)').run(lead.id, jid, type, new Date().toISOString());
      if (result.changes > 0) aliasesAttached++;
    });
  };

  try {
    const dbWithTx = db as unknown as { transaction: (fn: () => void) => () => void };
    if (typeof dbWithTx.transaction === 'function') {
      dbWithTx.transaction(runRepair)();
    } else {
      runRepair();
    }

    res.json({
      ok: true,
      result: {
        mergedLeadsCount,
        selfAccountLeadsRemoved,
        aliasesAttached,
        messagesReassigned,
        skippedRecords
      }
    });
  } catch (err) {
    console.error('[admin] repair-identities failed:', err);
    res.status(500).json({ ok: false, error: 'Repair operation failed. Database may be unchanged due to transaction rollback.' });
  }
});

// POST /app/:secret/admin/clear-leads (Clear all leads data)
router.post('/app/:secret/admin/clear-leads', requireSecretPath, adminRateLimit, async (_req: Request, res: Response) => {
  const { clearAllLeadsAndMessages } = await import('../db/index.js');
  const result = clearAllLeadsAndMessages();
  res.json({ ok: true, message: 'Leads and messages cleared successfully', result });
});

export default router;
