import { Router, Request, Response, NextFunction } from 'express';
import { validateSecret } from '../services/secretService.js';
import {
  getRecentLeads,
  getRecentLeadsByChannel,
  getOnboardingState,
  getLeadStats,
  getLeadStatsByChannel,
  getLeadDisplayPhone,
  getLeadDisplayName,
  getPendingSheetSyncCount,
  getPendingSyncCount,
  getLeadConversionScore,
  setSetting,
  getChannelById
} from '../db/index.js';
import { whatsAppService } from '../services/whatsappService.js';
import { googleService } from '../services/googleService.js';
import { requireAuth } from '../middleware/auth.js';
import { isChannelSetupComplete } from './auth.js';

const router = Router();

// Middleware to validate `:secret` parameter
export function requireSecretPath(req: Request, res: Response, next: NextFunction): void {
  const secret = req.params.secret;
  if (!secret || typeof secret !== 'string' || !validateSecret(secret)) {
    // Return 404 cleanly to avoid revealing valid route structure or secret expectations
    res.status(404).send('Not Found');
    return;
  }
  next();
}

export function formatReadableTimestamp(isoString: string): string {
  try {
    const d = new Date(isoString);
    return d.toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true
    });
  } catch {
    return isoString;
  }
}

router.get('/app/:secret', requireSecretPath, requireAuth, async (req: Request, res: Response) => {
  const secret = req.params.secret;
  const user = req.user;
  const state = getOnboardingState();

  const requestedChannelId = (typeof req.query.channelId === 'string' ? req.query.channelId : (typeof req.query.channel_id === 'string' ? req.query.channel_id : '')).trim();

  // Admin does NOT land on a default/global operator dashboard. Redirect to /admin/dashboard unless viewing a specific channel
  if (user?.role === 'admin' && !requestedChannelId) {
    res.redirect('/admin/dashboard');
    return;
  }

  let activeChannelId: string | undefined;
  if (user?.role === 'operator') {
    activeChannelId = user.channel_id || undefined;
  } else if (user?.role === 'admin') {
    activeChannelId = requestedChannelId || undefined;
  }

  let channelInfo = null;
  if (activeChannelId) {
    channelInfo = getChannelById(activeChannelId);
    if (!channelInfo && user?.role === 'admin') {
      res.status(404).send('Channel Not Found');
      return;
    }
  }

  // If operator's channel is not fully configured, redirect them to onboarding
  if (user?.role === 'operator') {
    const isComplete = await isChannelSetupComplete(activeChannelId);
    if (!isComplete) {
      res.redirect(`/app/${secret}/onboarding`);
      return;
    }
  }

  const recentLeads = activeChannelId
    ? getRecentLeadsByChannel(activeChannelId, 5)
    : (user?.role === 'admin' ? getRecentLeads(5) : []);

  const stats = activeChannelId
    ? getLeadStatsByChannel(activeChannelId)
    : (user?.role === 'admin' ? getLeadStats() : { total: 0, analyzing: 0, interested: 0, not_interested: 0, undecided: 0 });

  const waStatus = activeChannelId
    ? whatsAppService.getStatus(activeChannelId)
    : { state: 'not_connected' as const, connectedNumber: null, lastConnectedAt: null, qrAvailable: false, pairingCodeAvailable: false };
  const googleConn = await googleService.getConnection(false, activeChannelId);
  const pendingSheetCount = getPendingSheetSyncCount(activeChannelId);
  const pendingSupabaseCount = getPendingSyncCount();

  const safeLeads = recentLeads.map(lead => ({
    ...lead,
    customer_name: getLeadDisplayName(lead),
    display_phone: getLeadDisplayPhone(lead),
    conversion_score: getLeadConversionScore(lead),
    readable_last_activity: formatReadableTimestamp(lead.last_activity_at)
  }));

  const isGoogleConnected = !!googleConn && googleConn.connection_status === 'connected' && !!googleConn.encrypted_refresh_token && !!googleConn.spreadsheet_id;
  if (!isGoogleConnected && state.google_connection_state !== 'disconnected') {
    setSetting('google_connection_state', 'disconnected');
    setSetting('google_account_email', '');
  }

  res.render('dashboard', {
    appTitle: 'LeadPush',
    appSecret: secret,
    activeNav: 'dashboard',
    user: user,
    channelInfo: channelInfo,
    whatsAppConnected: waStatus.state === 'connected',
    googleSheetsConnected: isGoogleConnected,
    googleConn: isGoogleConnected ? googleConn : null,
    waStatus: waStatus,
    pendingSheetCount: pendingSheetCount,
    pendingSupabaseCount: pendingSupabaseCount,
    leads: safeLeads,
    stats: stats
  });
});

export default router;
