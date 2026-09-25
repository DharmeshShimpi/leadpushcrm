import { Router, Request, Response } from 'express';
import { requireSecretPath, formatReadableTimestamp } from './dashboard.js';
import {
  getPaginatedLeads,
  getPaginatedLeadsByChannel,
  getLeadById,
  getMessagesByLeadId,
  updateLeadContactInfo,
  getLeadDisplayPhone,
  getLeadDisplayName,
  getLeadConversionScore,
  getChannelById
} from '../db/index.js';
import { whatsAppService } from '../services/whatsappService.js';
import { googleService } from '../services/googleService.js';
import { requireAuth } from '../middleware/auth.js';
import { isChannelSetupComplete } from './auth.js';

const router = Router();

// GET /app/:secret/leads
router.get('/app/:secret/leads', requireSecretPath, requireAuth, async (req: Request, res: Response) => {
  const secret = req.params.secret;
  const user = req.user;
  // Operators must have configured channel to access leads
  if (user?.role === 'operator') {
    const isComplete = await isChannelSetupComplete(user.channel_id);
    if (!isComplete) {
      res.redirect(`/app/${secret}/onboarding`);
      return;
    }
  }

  const search = typeof req.query.search === 'string' ? req.query.search : '';
  const statusFilter = typeof req.query.status === 'string' ? req.query.status : 'all';
  const page = parseInt(req.query.page as string, 10) || 1;
  const requestedChannelId = (typeof req.query.channelId === 'string' ? req.query.channelId : (typeof req.query.channel_id === 'string' ? req.query.channel_id : '')).trim();

  let activeChannelId: string | undefined;
  if (user?.role === 'operator') {
    activeChannelId = user.channel_id || undefined;
  } else if (user?.role === 'admin') {
    activeChannelId = requestedChannelId || undefined;
  }

  const channelInfo = activeChannelId ? getChannelById(activeChannelId) : null;

  const result = activeChannelId
    ? getPaginatedLeadsByChannel({
        channelId: activeChannelId,
        search: search,
        status: statusFilter,
        page: page,
        limit: 10
      })
    : (user?.role === 'admin'
        ? getPaginatedLeads({
            search: search,
            status: statusFilter,
            page: page,
            limit: 10
          })
        : { leads: [], total: 0, page: 1, limit: 10, totalPages: 0 });

  const waStatus = activeChannelId
    ? whatsAppService.getStatus(activeChannelId)
    : { state: 'not_connected' as const, connectedNumber: null, lastConnectedAt: null, qrAvailable: false, pairingCodeAvailable: false };
  const googleConn = await googleService.getConnection(false, activeChannelId);

  const safeLeads = result.leads.map(lead => ({
    ...lead,
    customer_name: getLeadDisplayName(lead),
    display_phone: getLeadDisplayPhone(lead),
    conversion_score: getLeadConversionScore(lead),
    readable_last_activity: formatReadableTimestamp(lead.last_activity_at)
  }));

  res.render('leads', {
    appTitle: 'LeadPush',
    appSecret: secret,
    activeNav: 'leads',
    user: user,
    channelInfo: channelInfo,
    channelId: activeChannelId,
    whatsAppConnected: waStatus.state === 'connected',
    googleSheetsConnected: !!(googleConn && googleConn.spreadsheet_id),
    googleConn: googleConn,
    leads: safeLeads,
    total: result.total,
    page: result.page,
    totalPages: result.totalPages,
    search: search,
    statusFilter: statusFilter
  });
});

// GET /app/:secret/leads/:id
router.get('/app/:secret/leads/:id', requireSecretPath, requireAuth, async (req: Request, res: Response) => {
  const secret = req.params.secret;
  const user = req.user;
  if (user?.role === 'operator') {
    const isComplete = await isChannelSetupComplete(user.channel_id);
    if (!isComplete) {
      res.redirect(`/app/${secret}/onboarding`);
      return;
    }
  }

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

  // Cross-channel access protection for operators
  if (user?.role === 'operator' && user.channel_id && lead.channel_id !== user.channel_id) {
    res.status(403).send('Forbidden: Lead does not belong to your assigned channel');
    return;
  }

  const messages = getMessagesByLeadId(lead.id);
  const waStatus = whatsAppService.getStatus(lead.channel_id);
  const googleConn = await googleService.getConnection(false, lead.channel_id);

  const safeLead = {
    ...lead,
    customer_name: getLeadDisplayName(lead),
    display_phone: getLeadDisplayPhone(lead),
    readable_last_activity: formatReadableTimestamp(lead.last_activity_at)
  };

  const notice = typeof req.query.notice === 'string' ? req.query.notice : undefined;
  const error = typeof req.query.error === 'string' ? req.query.error : undefined;

  res.render('lead_detail', {
    appTitle: 'LeadPush',
    appSecret: secret,
    activeNav: 'leads',
    user: user,
    whatsAppConnected: waStatus.state === 'connected',
    googleSheetsConnected: !!(googleConn && googleConn.spreadsheet_id),
    googleConn: googleConn,
    lead: safeLead,
    messages: messages,
    notice: notice,
    error: error
  });
});

// GET /app/:secret/leads/:id/conversation
router.get('/app/:secret/leads/:id/conversation', requireSecretPath, requireAuth, async (req: Request, res: Response) => {
  const secret = req.params.secret;
  const user = req.user;
  if (user?.role === 'operator') {
    const isComplete = await isChannelSetupComplete(user.channel_id);
    if (!isComplete) {
      res.redirect(`/app/${secret}/onboarding`);
      return;
    }
  }

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

  // Cross-channel access protection for operators
  if (user?.role === 'operator' && user.channel_id && lead.channel_id !== user.channel_id) {
    res.status(403).send('Forbidden: Lead does not belong to your assigned channel');
    return;
  }

  const messages = getMessagesByLeadId(lead.id);
  const waStatus = whatsAppService.getStatus(lead.channel_id);
  const googleConn = await googleService.getConnection(false, lead.channel_id);

  const safeLead = {
    ...lead,
    customer_name: getLeadDisplayName(lead),
    display_phone: getLeadDisplayPhone(lead),
    conversion_score: getLeadConversionScore(lead),
    readable_last_activity: formatReadableTimestamp(lead.last_activity_at)
  };

  res.render('lead_conversation', {
    appTitle: 'LeadPush',
    appSecret: secret,
    activeNav: 'leads',
    user: user,
    whatsAppConnected: waStatus.state === 'connected',
    googleSheetsConnected: !!(googleConn && googleConn.spreadsheet_id),
    googleConn: googleConn,
    lead: safeLead,
    messages: messages
  });
});

// POST /app/:secret/leads/:id/update-contact
router.post('/app/:secret/leads/:id/update-contact', requireSecretPath, requireAuth, (req: Request, res: Response) => {
  const secret = req.params.secret;
  const user = req.user;
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

  // Cross-channel update protection for operators
  if (user?.role === 'operator' && user.channel_id && lead.channel_id !== user.channel_id) {
    res.status(403).send('Forbidden: Cannot edit lead from another channel');
    return;
  }

  const { customer_name, whatsapp_phone, status } = req.body || {};
  const updated = updateLeadContactInfo(leadId, customer_name, whatsapp_phone, status);

  if (!updated) {
    res.redirect(`/app/${secret}/leads/${leadId}?error=1`);
    return;
  }

  res.redirect(`/app/${secret}/leads/${leadId}?notice=contact_updated`);
});

export default router;
