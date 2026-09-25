import { Router, Request, Response } from 'express';
import { requireSecretPath } from './dashboard.js';
import { requireAuth } from '../middleware/auth.js';
import { setSetting, getChannelById } from '../db/index.js';
import { whatsAppService } from '../services/whatsappService.js';
import { googleService } from '../services/googleService.js';

const router = Router();

// Render onboarding page (scoped to authenticated operator's channel)
router.get('/app/:secret/onboarding', requireSecretPath, requireAuth, async (req: Request, res: Response) => {
  const secret = req.params.secret;
  const user = req.user;

  // Admins do not belong to a channel and have no operator onboarding
  if (user?.role === 'admin') {
    res.redirect('/admin/dashboard');
    return;
  }

  const channelId = user?.channel_id;
  if (!channelId) {
    res.status(400).send('No channel assigned to this operator account. Please contact an administrator.');
    return;
  }

  const channelInfo = getChannelById(channelId);
  const waStatus = whatsAppService.getStatus(channelId);
  const googleConn = await googleService.getConnection(true, channelId);

  const isWhatsAppConnected = waStatus.state === 'connected' || whatsAppService.hasCredentials(channelId);
  const isGoogleAccountConnected = !!googleConn && googleConn.connection_status === 'connected' && !!googleConn.encrypted_refresh_token;
  const isSheetConfigured = isGoogleAccountConnected && !!googleConn.spreadsheet_id;

  const stepQuery = req.query.step;
  let currentStep: number;

  if (stepQuery) {
    currentStep = parseInt(stepQuery as string, 10);
    if (isNaN(currentStep) || currentStep < 1 || currentStep > 3) {
      currentStep = 1;
    }
  } else {
    // If setup is already complete and no specific step was requested, go to dashboard
    if (isWhatsAppConnected && isSheetConfigured) {
      res.redirect(`/app/${secret}`);
      return;
    }
    // Resume from first incomplete step
    if (!isWhatsAppConnected) {
      currentStep = 1;
    } else if (!isSheetConfigured) {
      currentStep = 2;
    } else {
      currentStep = 3;
    }
  }

  // Automatically initialize WhatsApp session on Step 1 if not already running
  if (currentStep === 1 && !isWhatsAppConnected) {
    const session = whatsAppService.getSession(channelId);
    if (!session || (!session.socket && !session.isInitializing)) {
      whatsAppService.initialize(channelId).catch(err => {
        console.error(`Failed to auto-initialize WhatsApp for channel ${channelId}:`, err);
      });
    }
  }

  res.render('onboarding', {
    appTitle: 'LeadPush',
    appSecret: secret,
    user: user,
    channelInfo: channelInfo,
    whatsAppConnected: isWhatsAppConnected,
    googleSheetsConnected: isSheetConfigured,
    googleConn: isGoogleAccountConnected ? googleConn : null,
    onboardingState: {
      whatsapp_connection_state: isWhatsAppConnected ? 'connected' : 'disconnected',
      google_connection_state: isGoogleAccountConnected ? 'connected' : 'disconnected',
      onboarding_completed: isWhatsAppConnected && isSheetConfigured
    },
    waStatus: waStatus,
    currentStep: currentStep,
    isDev: process.env.NODE_ENV !== 'production'
  });
});

// Update Google Sheet selection mode (Step 2)
router.post('/app/:secret/onboarding/update-sheet-mode', requireSecretPath, requireAuth, (req: Request, res: Response) => {
  const secret = req.params.secret;
  const mode = req.body.sheet_mode === 'existing' ? 'existing' : 'new';
  setSetting('google_sheet_mode', mode);
  res.redirect(`/app/${secret}/onboarding?step=2`);
});

// Complete onboarding (Step 3 action)
router.post('/app/:secret/onboarding/complete', requireSecretPath, requireAuth, async (req: Request, res: Response) => {
  const secret = req.params.secret;
  const user = req.user;
  const channelId = user?.channel_id;

  if (!channelId) {
    res.status(400).send('No channel assigned to this operator account.');
    return;
  }

  const waStatus = whatsAppService.getStatus(channelId);
  const googleConn = await googleService.getConnection(false, channelId);

  const isWhatsAppConnected = waStatus.state === 'connected' || whatsAppService.hasCredentials(channelId);
  const isSheetConfigured = !!googleConn && googleConn.connection_status === 'connected' && !!googleConn.spreadsheet_id;

  // "Open Dashboard" button works only when both setup states are marked connected
  if (!isWhatsAppConnected || !isSheetConfigured) {
    res.redirect(`/app/${secret}/onboarding?step=3`);
    return;
  }

  res.redirect(`/app/${secret}`);
});

// Dev-only helper endpoint to simulate completing onboarding (only when NODE_ENV is not production)
router.post('/app/:secret/dev/mock-connect', requireSecretPath, requireAuth, (req: Request, res: Response) => {
  const secret = req.params.secret;

  if (process.env.NODE_ENV === 'production') {
    res.status(403).send('Forbidden: Dev helper disabled in production environment');
    return;
  }

  setSetting('whatsapp_connection_state', 'connected');
  setSetting('google_connection_state', 'connected');
  setSetting('onboarding_completed', 'true');

  res.redirect(`/app/${secret}`);
});

export default router;
