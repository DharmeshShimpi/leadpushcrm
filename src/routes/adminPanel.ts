import { Router, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { authService } from '../services/authService.js';
import {
  getAllChannelsWithStats,
  getLeadStats,
  getRecentLeads,
  getPaginatedLeads,
  getLeadDisplayName,
  getLeadDisplayPhone,
  getLeadConversionScore
} from '../db/index.js';
import { formatReadableTimestamp } from './dashboard.js';

const router = Router();

// GET /admin/dashboard - Admin landing page
router.get('/admin/dashboard', requireAdmin, async (req: Request, res: Response) => {
  const channels = getAllChannelsWithStats();
  const operators = await authService.getAllOperators();
  const leadStats = getLeadStats();
  const appSecret = process.env.APP_SECRET_PATH || '';

  // Channel lookup map
  const channelMap = new Map<string, string>();
  channels.forEach(ch => channelMap.set(ch.id, ch.name));

  const recentLeadsRaw = getRecentLeads(5);
  const recentLeads = recentLeadsRaw.map(lead => ({
    ...lead,
    customer_name: getLeadDisplayName(lead),
    display_phone: getLeadDisplayPhone(lead),
    conversion_score: getLeadConversionScore(lead),
    channel_name: lead.channel_id ? (channelMap.get(lead.channel_id) || lead.channel_id) : 'Unassigned',
    readable_last_activity: formatReadableTimestamp(lead.last_activity_at)
  }));

  res.render('admin_dashboard', {
    appTitle: 'LeadPush',
    appSecret: appSecret,
    user: req.user,
    channelCount: channels.length,
    operatorCount: operators.length,
    leadCount: leadStats.total,
    recentLeads: recentLeads,
    activeNav: 'admin_dashboard'
  });
});

// GET /admin/leads - All leads across all channels with pagination (10 per page)
router.get('/admin/leads', requireAdmin, async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string, 10) || 1;
  const limit = 10;
  const search = (req.query.search as string) || '';
  const status = (req.query.status as string) || 'all';
  const appSecret = process.env.APP_SECRET_PATH || '';

  const channels = getAllChannelsWithStats();
  const channelMap = new Map<string, string>();
  channels.forEach(ch => channelMap.set(ch.id, ch.name));

  const { leads: rawLeads, total, totalPages } = getPaginatedLeads({
    page,
    limit,
    search,
    status
  });

  const leads = rawLeads.map(lead => ({
    ...lead,
    customer_name: getLeadDisplayName(lead),
    display_phone: getLeadDisplayPhone(lead),
    conversion_score: getLeadConversionScore(lead),
    channel_name: lead.channel_id ? (channelMap.get(lead.channel_id) || lead.channel_id) : 'Unassigned',
    readable_last_activity: formatReadableTimestamp(lead.last_activity_at)
  }));

  res.render('admin_leads', {
    appTitle: 'LeadPush',
    appSecret: appSecret,
    user: req.user,
    leads: leads,
    total: total,
    page: page,
    limit: limit,
    totalPages: totalPages,
    search: search,
    status: status,
    activeNav: 'admin_leads'
  });
});

// GET /admin/operators - List all operators
router.get('/admin/operators', requireAdmin, async (_req: Request, res: Response) => {
  const operators = await authService.getAllOperators();
  const channels = getAllChannelsWithStats();
  const appSecret = process.env.APP_SECRET_PATH || '';

  // Create a channel lookup map
  const channelMap = new Map<string, string>();
  channels.forEach(ch => channelMap.set(ch.id, ch.name));

  // Find which channels are currently assigned to an operator
  const assignedChannelIds = new Set<string>();
  operators.forEach(op => {
    if (op.channel_id) assignedChannelIds.add(op.channel_id);
  });

  const operatorsWithChannelNames = operators.map(op => ({
    ...op,
    channel_name: op.channel_id ? (channelMap.get(op.channel_id) || op.channel_id) : 'Not Assigned',
    created_at_formatted: formatReadableTimestamp(op.created_at)
  }));

  res.render('operators', {
    appTitle: 'LeadPush',
    appSecret: appSecret,
    user: _req.user,
    operators: operatorsWithChannelNames,
    channels: channels,
    assignedChannelIds: Array.from(assignedChannelIds),
    activeNav: 'operators',
    notice: _req.query.notice as string || null,
    error: _req.query.error as string || null
  });
});

// GET /admin/operators/create - Create operator form
router.get('/admin/operators/create', requireAdmin, async (_req: Request, res: Response) => {
  const channels = getAllChannelsWithStats();
  const operators = await authService.getAllOperators();
  const appSecret = process.env.APP_SECRET_PATH || '';

  const assignedChannelMap = new Map<string, string>();
  operators.forEach(op => {
    if (op.channel_id) {
      assignedChannelMap.set(op.channel_id, op.name);
    }
  });

  res.render('create_operator', {
    appTitle: 'LeadPush',
    appSecret: appSecret,
    user: _req.user,
    channels: channels,
    assignedChannelMap: assignedChannelMap,
    activeNav: 'operators',
    error: _req.query.error as string || null,
    formData: null
  });
});

// POST /admin/operators - Create operator
router.post('/admin/operators', requireAdmin, async (req: Request, res: Response) => {
  const { name, phone, password, channel_id } = req.body || {};

  if (!name || !phone || !password || !channel_id) {
    res.redirect('/admin/operators/create?error=missing_fields');
    return;
  }

  try {
    await authService.createOperator(name, phone, password, channel_id);
    res.redirect('/admin/operators?notice=operator_created');
  } catch (err: any) {
    const errorMsg = err?.message || 'create_failed';
    console.error('[admin] Failed to create operator:', errorMsg);

    if (errorMsg.includes('already assigned')) {
      res.redirect('/admin/operators/create?error=channel_already_assigned');
    } else if (errorMsg.includes('already exists')) {
      res.redirect('/admin/operators/create?error=phone_exists');
    } else if (errorMsg.includes('Invalid phone')) {
      res.redirect('/admin/operators/create?error=invalid_phone');
    } else if (errorMsg.includes('Password must')) {
      res.redirect('/admin/operators/create?error=weak_password');
    } else {
      res.redirect('/admin/operators/create?error=create_failed');
    }
  }
});

// POST /admin/operators/:id/reassign - Reassign or deassign operator
router.post('/admin/operators/:id/reassign', requireAdmin, async (req: Request, res: Response) => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const rawChannelId = req.body?.channel_id;
  const newChannelId = rawChannelId && String(rawChannelId).trim() !== '' ? String(rawChannelId).trim() : null;

  try {
    await authService.reassignOperator(rawId, newChannelId);
    const notice = newChannelId ? 'operator_reassigned' : 'operator_deassigned';
    res.redirect(`/admin/operators?notice=${notice}`);
  } catch (err: any) {
    console.error(`[admin] Failed to reassign operator ${rawId}:`, err);
    const msg = err?.message || '';
    if (msg.includes('already assigned')) {
      res.redirect('/admin/operators?error=channel_already_assigned');
    } else {
      res.redirect('/admin/operators?error=reassign_failed');
    }
  }
});

// POST /admin/operators/:id/delete - Delete operator
router.post('/admin/operators/:id/delete', requireAdmin, async (req: Request, res: Response) => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  try {
    await authService.deleteOperator(rawId);
    res.redirect('/admin/operators?notice=operator_deleted');
  } catch (err: any) {
    console.error(`[admin] Failed to delete operator ${rawId}:`, err);
    res.redirect('/admin/operators?error=delete_failed');
  }
});

export default router;
