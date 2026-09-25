import { Router, Request, Response } from 'express';
import { requireSecretPath } from './dashboard.js';
import { sseService } from '../services/sseService.js';

const router = Router();

// GET /app/:secret/events (Server-Sent Events Endpoint)
router.get('/app/:secret/events', requireSecretPath, (req: Request, res: Response) => {
  const secret = Array.isArray(req.params.secret) ? req.params.secret[0] : req.params.secret;
  const clientId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  sseService.addClient(clientId, secret, res);
});

export default router;
