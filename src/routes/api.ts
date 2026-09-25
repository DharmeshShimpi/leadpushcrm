import { Router, Request, Response } from 'express';
import { requireSecretPath } from './dashboard.js';
import { requireAuth } from '../middleware/auth.js';
import {
  getLeadStats,
  getLeadStatsByChannel,
  getRecentLeads,
  getRecentLeadsByChannel,
  getPaginatedLeads,
  getPaginatedLeadsByChannel,
  getLeadById,
  getMessagesByLeadId,
  getLeadDisplayPhone,
  getLeadDisplayName,
  getLeadConversionScore
} from '../db/index.js';
import { whatsAppService } from '../services/whatsappService.js';
import { supabaseService } from '../services/supabaseService.js';

const router = Router();

// GET /app/:secret/api/health - internal health status
router.get('/app/:secret/api/health', requireSecretPath, (req: Request, res: Response) => {
  const channelId = typeof req.query.channelId === 'string' ? req.query.channelId : undefined;
  const waStatus = channelId
    ? whatsAppService.getStatus(channelId)
    : { state: 'not_connected' as const, connectedNumber: null, lastConnectedAt: null, qrAvailable: false, pairingCodeAvailable: false };
  const supabaseHealth = supabaseService.getHealth();

  res.json({
    ok: true,
    whatsapp: waStatus,
    supabase: supabaseHealth
  });
});

// GET /app/:secret/api/dashboard - Channel-isolated real-time dashboard data
router.get('/app/:secret/api/dashboard', requireSecretPath, requireAuth, (req: Request, res: Response) => {
  const user = req.user;
  const requestedChannelId = (typeof req.query.channelId === 'string' ? req.query.channelId : (typeof req.query.channel_id === 'string' ? req.query.channel_id : '')).trim();

  let activeChannelId: string | undefined;
  if (user?.role === 'operator') {
    // Operators are strictly locked to their assigned channel
    activeChannelId = user.channel_id || undefined;
    if (!activeChannelId) {
      res.json({
        ok: true,
        stats: { total: 0, analyzing: 0, interested: 0, not_interested: 0, undecided: 0 },
        recentLeads: [],
        whatsAppStatus: { state: 'not_connected', connectedNumber: null, lastConnectedAt: null, qrAvailable: false, pairingCodeAvailable: false },
        supabaseHealth: supabaseService.getHealth()
      });
      return;
    }
  } else if (user?.role === 'admin') {
    activeChannelId = requestedChannelId || undefined;
  }

  const stats = activeChannelId ? getLeadStatsByChannel(activeChannelId) : getLeadStats();
  const recentLeads = activeChannelId ? getRecentLeadsByChannel(activeChannelId, 5) : getRecentLeads(5);
  const waStatus = activeChannelId
    ? whatsAppService.getStatus(activeChannelId)
    : { state: 'not_connected' as const, connectedNumber: null, lastConnectedAt: null, qrAvailable: false, pairingCodeAvailable: false };
  const supabaseHealth = supabaseService.getHealth();

  // Format leads safely for client consumption
  const safeLeads = recentLeads.map(lead => ({
    id: lead.id,
    customer_name: getLeadDisplayName(lead),
    display_phone: getLeadDisplayPhone(lead),
    status: lead.status,
    conversion_score: getLeadConversionScore(lead),
    latest_message: lead.latest_message || '',
    last_activity_at: new Date(lead.last_activity_at).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true
    })
  }));

  res.json({
    ok: true,
    stats: stats,
    recentLeads: safeLeads,
    whatsAppStatus: waStatus,
    supabaseHealth: supabaseHealth
  });
});

// GET /app/:secret/api/leads - Paginated real-time leads query strictly scoped by channel
router.get('/app/:secret/api/leads', requireSecretPath, requireAuth, (req: Request, res: Response) => {
  const user = req.user;
  const requestedChannelId = (typeof req.query.channelId === 'string' ? req.query.channelId : (typeof req.query.channel_id === 'string' ? req.query.channel_id : '')).trim();

  let activeChannelId: string | undefined;
  if (user?.role === 'operator') {
    activeChannelId = user.channel_id || undefined;
    if (!activeChannelId) {
      res.json({ ok: true, leads: [], total: 0, page: 1, totalPages: 0 });
      return;
    }
  } else if (user?.role === 'admin') {
    activeChannelId = requestedChannelId || undefined;
  }

  const search = typeof req.query.search === 'string' ? req.query.search : '';
  const statusFilter = typeof req.query.status === 'string' ? req.query.status : 'all';
  const page = parseInt(req.query.page as string, 10) || 1;
  const limit = parseInt(req.query.limit as string, 10) || 10;

  const result = activeChannelId
    ? getPaginatedLeadsByChannel({
        channelId: activeChannelId,
        search: search,
        status: statusFilter,
        page: page,
        limit: limit
      })
    : (user?.role === 'admin'
        ? getPaginatedLeads({
            search: search,
            status: statusFilter,
            page: page,
            limit: limit
          })
        : { leads: [], total: 0, page: 1, limit: limit, totalPages: 0 });

  const safeLeads = result.leads.map(lead => ({
    id: lead.id,
    customer_name: getLeadDisplayName(lead),
    display_phone: getLeadDisplayPhone(lead),
    status: lead.status,
    conversion_score: getLeadConversionScore(lead),
    latest_message: lead.latest_message || '',
    last_activity_at: new Date(lead.last_activity_at).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true
    })
  }));

  res.json({
    ok: true,
    leads: safeLeads,
    total: result.total,
    page: result.page,
    totalPages: result.totalPages
  });
});

// GET /app/:secret/api/leads/:id - Single lead query with channel authorization
router.get('/app/:secret/api/leads/:id', requireSecretPath, requireAuth, (req: Request, res: Response) => {
  const user = req.user;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const leadId = parseInt(rawId, 10);
  if (isNaN(leadId)) {
    res.status(404).json({ ok: false, error: 'Lead Not Found' });
    return;
  }

  const lead = getLeadById(leadId);
  if (!lead) {
    res.status(404).json({ ok: false, error: 'Lead Not Found' });
    return;
  }

  // Strict cross-channel authorization for operators
  if (user?.role === 'operator' && user.channel_id && lead.channel_id !== user.channel_id) {
    res.status(403).json({ ok: false, error: 'Forbidden: Lead does not belong to your assigned channel' });
    return;
  }

  res.json({
    ok: true,
    lead: {
      id: lead.id,
      customer_name: getLeadDisplayName(lead),
      display_phone: getLeadDisplayPhone(lead),
      status: lead.status,
      latest_message: lead.latest_message || '',
      last_activity_at: new Date(lead.last_activity_at).toLocaleString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true
      })
    }
  });
});

// GET /app/:secret/api/leads/:id/messages - Message history with channel authorization
router.get('/app/:secret/api/leads/:id/messages', requireSecretPath, requireAuth, (req: Request, res: Response) => {
  const user = req.user;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const leadId = parseInt(rawId, 10);
  if (isNaN(leadId)) {
    res.status(404).json({ ok: false, error: 'Lead Not Found' });
    return;
  }

  const lead = getLeadById(leadId);
  if (!lead) {
    res.status(404).json({ ok: false, error: 'Lead Not Found' });
    return;
  }

  // Strict cross-channel authorization for operators
  if (user?.role === 'operator' && user.channel_id && lead.channel_id !== user.channel_id) {
    res.status(403).json({ ok: false, error: 'Forbidden: Lead does not belong to your assigned channel' });
    return;
  }

  const messages = getMessagesByLeadId(leadId);
  const safeMessages = messages.map(msg => {
    const d = new Date(msg.sent_at);
    return {
      id: msg.id,
      direction: msg.direction,
      sender_name: msg.direction === 'outgoing' ? 'Business Account' : (msg.sender_name || 'Customer'),
      message_text: msg.message_text || '',
      message_type: msg.message_type || 'text',
      sent_at_date: d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
      sent_at_time: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
  });

  res.json({
    ok: true,
    messages: safeMessages
  });
});

// GET /app/:secret/api/debug/resolve
router.get('/app/:secret/api/debug/resolve', requireSecretPath, async (_req: Request, res: Response) => {
  res.json({ ok: true, message: 'Resolution is handled live on message events' });
});

export default router;
