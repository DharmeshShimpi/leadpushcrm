import { Router, Request, Response } from 'express';
import { requireSecretPath } from './dashboard.js';
import { requireAuth } from '../middleware/auth.js';
import { whatsAppService } from '../services/whatsappService.js';
import { createRateLimiter } from '../utils/rateLimiter.js';

const router = Router();

// Rate limiter: max 5 destructive actions (reconnect/reset) per minute per IP
const destructiveRateLimit = createRateLimiter(60 * 1000, 5, 'Too many requests. Please wait before trying again.');

// GET /app/:secret/whatsapp/qr
router.get('/app/:secret/whatsapp/qr', requireSecretPath, requireAuth, (req: Request, res: Response) => {
  const channelId = req.user?.channel_id;
  if (!channelId) {
    res.status(400).json({ ok: false, error: 'No channel assigned to account' });
    return;
  }

  const session = whatsAppService.getSession(channelId);
  if (!session || (!session.socket && !session.isInitializing)) {
    whatsAppService.initialize(channelId).catch(err => {
      console.error(`Failed to auto-initialize WhatsApp on QR request for channel ${channelId}:`, err);
    });
  }

  const qrDataUrl = whatsAppService.getQRDataUrl(channelId);
  if (!qrDataUrl) {
    res.status(404).json({ ok: false, error: 'QR Code not available' });
    return;
  }
  res.json({ ok: true, qr: qrDataUrl });
});

// GET /app/:secret/api/whatsapp-status
router.get('/app/:secret/api/whatsapp-status', requireSecretPath, requireAuth, (req: Request, res: Response) => {
  const channelId = req.user?.channel_id;
  if (!channelId) {
    res.status(400).json({ ok: false, error: 'No channel assigned to account' });
    return;
  }

  const session = whatsAppService.getSession(channelId);
  if (!session || (!session.socket && !session.isInitializing)) {
    whatsAppService.initialize(channelId).catch(err => {
      console.error(`Failed to auto-initialize WhatsApp on status check for channel ${channelId}:`, err);
    });
  }

  const status = whatsAppService.getStatus(channelId);
  res.json({
    ok: true,
    state: status.state,
    connectedNumber: status.connectedNumber,
    lastConnectedAt: status.lastConnectedAt,
    qrAvailable: status.qrAvailable,
    pairingCodeAvailable: status.pairingCodeAvailable,
    pairingCode: status.pairingCode || null,
    pairingPhone: status.pairingPhone || null
  });
});

// POST /app/:secret/whatsapp/pairing-code (Generate 8-char pairing code)
router.post('/app/:secret/whatsapp/pairing-code', requireSecretPath, requireAuth, destructiveRateLimit, async (req: Request, res: Response) => {
  try {
    const channelId = req.user?.channel_id;
    if (!channelId) {
      res.status(400).json({ ok: false, error: 'No channel assigned to account' });
      return;
    }
    const phone = req.body.phone || req.body.phoneNumber;
    if (!phone || typeof phone !== 'string') {
      res.status(400).json({ ok: false, error: 'Phone number is required. Please provide a phone number with country code.' });
      return;
    }

    const code = await whatsAppService.requestPairingCode(phone, channelId);
    res.json({
      ok: true,
      code,
      message: 'Pairing code generated. Enter this code in WhatsApp > Linked Devices > Link with phone number instead.'
    });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err?.message || 'Failed to generate pairing code' });
  }
});

// GET /app/:secret/whatsapp/pairing-code (Get active pairing code)
router.get('/app/:secret/whatsapp/pairing-code', requireSecretPath, requireAuth, (req: Request, res: Response) => {
  const channelId = req.user?.channel_id;
  if (!channelId) {
    res.status(400).json({ ok: false, error: 'No channel assigned to account' });
    return;
  }
  const pairingInfo = whatsAppService.getPairingCode(channelId);
  res.json({
    ok: true,
    code: pairingInfo.code,
    phoneNumber: pairingInfo.phoneNumber,
    ageSeconds: pairingInfo.ageSeconds
  });
});

// POST /app/:secret/whatsapp/reconnect
router.post('/app/:secret/whatsapp/reconnect', requireSecretPath, requireAuth, destructiveRateLimit, async (req: Request, res: Response) => {
  const channelId = req.user?.channel_id;
  if (!channelId) {
    res.status(400).json({ ok: false, error: 'No channel assigned to account' });
    return;
  }
  await whatsAppService.reconnect(channelId);
  res.json({ ok: true, message: 'Reconnect requested' });
});

// GET /app/:secret/whatsapp/reset-session (Confirmation page)
router.get('/app/:secret/whatsapp/reset-session', requireSecretPath, requireAuth, (req: Request, res: Response) => {
  const secret = req.params.secret;
  const channelId = req.user?.channel_id;
  if (!channelId) {
    res.redirect(`/app/${secret}`);
    return;
  }
  res.render('reset_confirm', {
    appTitle: 'LeadPush',
    appSecret: secret,
    whatsAppConnected: whatsAppService.getStatus(channelId).state === 'connected',
    googleSheetsConnected: false
  });
});

// POST /app/:secret/whatsapp/reset-session (Destructive action)
router.post('/app/:secret/whatsapp/reset-session', requireSecretPath, requireAuth, destructiveRateLimit, async (req: Request, res: Response) => {
  const secret = req.params.secret;
  const channelId = req.user?.channel_id;
  if (!channelId) {
    res.redirect(`/app/${secret}`);
    return;
  }
  await whatsAppService.resetSession(channelId);
  res.redirect(`/app/${secret}/onboarding?step=1`);
});

export default router;
