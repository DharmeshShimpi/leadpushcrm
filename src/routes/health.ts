import { Router, Request, Response } from 'express';
import { whatsAppService } from '../services/whatsappService.js';
import { db } from '../db/index.js';

const router = Router();

router.get('/health', (_req: Request, res: Response) => {
  const waStatus = whatsAppService.getStatus();
  let dbState = 'ok';

  try {
    db.prepare('SELECT 1').get();
  } catch {
    dbState = 'error';
  }

  res.status(200).json({
    ok: dbState === 'ok',
    service: 'wa-lead-capture',
    timestamp: new Date().toISOString(),
    whatsappState: waStatus.state,
    database: dbState
  });
});

export default router;
