import { Router, Request, Response } from 'express';
import { requireSecretPath } from './dashboard.js';
import { requireAuth } from '../middleware/auth.js';
import { getLeadById } from '../db/index.js';
import { googleService } from '../services/googleService.js';
import { supabaseService } from '../services/supabaseService.js';

const router = Router();

// POST /app/:secret/leads/:id/sync-sheets - Manual Google Sheets sync trigger
router.post('/app/:secret/leads/:id/sync-sheets', requireSecretPath, requireAuth, async (req: Request, res: Response) => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const leadId = parseInt(rawId, 10);
  if (isNaN(leadId)) {
    res.status(404).send('Lead Not Found');
    return;
  }

  const lead = getLeadById(leadId);
  if (!lead) {
    res.status(404).send('Lead Not Found');
    return;
  }

  try {
    const success = await googleService.syncLeadToSheet(lead);
    if (success) {
      res.redirect(`/app/${req.params.secret}/leads/${leadId}?notice=sheets_synced`);
    } else {
      res.redirect(`/app/${req.params.secret}/leads/${leadId}?error=sheets_sync_failed`);
    }
  } catch (err) {
    console.error('Manual Google Sheets sync failed:', err);
    res.redirect(`/app/${req.params.secret}/leads/${leadId}?error=sheets_sync_failed`);
  }
});

// POST /app/:secret/leads/:id/retry-supabase - Manual Supabase backup trigger
router.post('/app/:secret/leads/:id/retry-supabase', requireSecretPath, requireAuth, async (req: Request, res: Response) => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const leadId = parseInt(rawId, 10);
  if (isNaN(leadId)) {
    res.status(404).send('Lead Not Found');
    return;
  }

  const lead = getLeadById(leadId);
  if (!lead) {
    res.status(404).send('Lead Not Found');
    return;
  }

  try {
    const success = await supabaseService.syncLead(lead);
    if (success) {
      res.redirect(`/app/${req.params.secret}/leads/${leadId}?notice=supabase_synced`);
    } else {
      res.redirect(`/app/${req.params.secret}/leads/${leadId}?error=supabase_sync_failed`);
    }
  } catch (err) {
    console.error('Manual Supabase backup failed:', err);
    res.redirect(`/app/${req.params.secret}/leads/${leadId}?error=supabase_sync_failed`);
  }
});

export default router;
