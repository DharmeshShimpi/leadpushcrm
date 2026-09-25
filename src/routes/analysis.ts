import { Router, Request, Response } from 'express';
import { requireSecretPath } from './dashboard.js';
import { requireAuth } from '../middleware/auth.js';
import { getLeadById } from '../db/index.js';
import { groqService } from '../services/groqService.js';

const router = Router();

// POST /app/:secret/leads/:id/reanalyze - Manually trigger Groq reanalysis
router.post('/app/:secret/leads/:id/reanalyze', requireSecretPath, requireAuth, async (req: Request, res: Response) => {
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
    await groqService.analyzeConversation(leadId, { force: true });
    res.redirect(`/app/${req.params.secret}/leads/${leadId}?notice=reanalyzed`);
  } catch (err) {
    console.error('Manual reanalysis failed:', err);
    res.redirect(`/app/${req.params.secret}/leads/${leadId}?error=reanalysis_failed`);
  }
});

export default router;
