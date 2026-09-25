import { Router, Request, Response } from 'express';
import crypto from 'node:crypto';
import { requireSecretPath, formatReadableTimestamp } from './dashboard.js';
import {
  getAllChannelsWithStats,
  getChannelById,
  createChannel,
  countLeadsByChannelId,
  getAllLeadsByChannel,
  getLeadDisplayName,
  getLeadDisplayPhone,
  getLeadConversionScore,
  deleteChannelLocal
} from '../db/index.js';
import { requireAdmin } from '../middleware/auth.js';
import { whatsAppService } from '../services/whatsappService.js';
import { googleService } from '../services/googleService.js';
import { supabaseService } from '../services/supabaseService.js';
import { authService } from '../services/authService.js';

const router = Router();

// GET /app/:secret/channels - List all channels
router.get('/app/:secret/channels', requireSecretPath, requireAdmin, (_req: Request, res: Response) => {
  const secret = _req.params.secret;
  const rawChannels = getAllChannelsWithStats();

  const channels = rawChannels.map(c => ({
    ...c,
    created_at_formatted: formatReadableTimestamp(c.created_at)
  }));

  res.render('channels', {
    appTitle: 'LeadPush',
    appSecret: secret,
    activeNav: 'channels',
    user: _req.user,
    channels: channels,
    error: _req.query.error as string || null,
    notice: _req.query.notice as string || null
  });
});

// POST /app/:secret/channels - Create new channel
router.post('/app/:secret/channels', requireSecretPath, requireAdmin, (req: Request, res: Response) => {
  const secret = req.params.secret;
  const rawName = req.body?.name;
  const name = typeof rawName === 'string' ? rawName.trim() : '';

  if (!name) {
    res.redirect(`/app/${secret}/channels?error=name_required`);
    return;
  }

  // Generate clean, deterministic/random channel ID e.g. ch_a1b2c3d4
  const channelId = `ch_${crypto.randomBytes(4).toString('hex')}`;

  try {
    createChannel(channelId, name, 'active');
    res.redirect(`/app/${secret}/channels?notice=channel_created`);
  } catch (err) {
    console.error('Failed to create channel:', err);
    res.redirect(`/app/${secret}/channels?error=create_failed`);
  }
});

// GET /app/:secret/channels/:channelId/export-leads - Export channel leads as CSV
router.get('/app/:secret/channels/:channelId/export-leads', requireSecretPath, requireAdmin, (req: Request, res: Response) => {
  const rawChannelId = Array.isArray(req.params.channelId) ? req.params.channelId[0] : req.params.channelId;
  const channel = getChannelById(rawChannelId);
  if (!channel) {
    res.status(404).send('Channel Not Found');
    return;
  }

  const leads = getAllLeadsByChannel(channel.id);

  // Helper to escape CSV values
  const escapeCsv = (val: string | null | undefined): string => {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };

  const headers = [
    'ID',
    'Customer Name',
    'Phone Number',
    'Status',
    'Conversion Score',
    'Latest Message',
    'AI Conversation Summary',
    'Extracted Answers',
    'Qualification Reason',
    'First Activity At',
    'Last Activity At',
    'Created At'
  ];

  const rows = leads.map(l => {
    const dispName = getLeadDisplayName(l);
    const dispPhone = getLeadDisplayPhone(l);
    const score = getLeadConversionScore(l);

    let answersText = '';
    if (l.extracted_answers) {
      try {
        const parsed = typeof l.extracted_answers === 'string' ? JSON.parse(l.extracted_answers) : l.extracted_answers;
        answersText = Object.entries(parsed)
          .filter(([_, v]) => v != null)
          .map(([k, v]) => `${k}: ${v}`)
          .join('; ');
      } catch {
        answersText = String(l.extracted_answers);
      }
    }

    return [
      escapeCsv(String(l.id)),
      escapeCsv(dispName),
      escapeCsv(dispPhone),
      escapeCsv(l.status),
      escapeCsv(score),
      escapeCsv(l.latest_message || ''),
      escapeCsv(l.conversation_summary || ''),
      escapeCsv(answersText),
      escapeCsv(l.qualification_reason || ''),
      escapeCsv(l.first_activity_at || ''),
      escapeCsv(l.last_activity_at || ''),
      escapeCsv(l.created_at || '')
    ].join(',');
  });

  const csvContent = [headers.join(','), ...rows].join('\r\n');
  const safeChannelName = channel.name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `leads_backup_${safeChannelName}_${channel.id}_${dateStr}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csvContent);
});

// POST /app/:secret/channels/:channelId/delete - Delete channel and cascade disconnect
router.post('/app/:secret/channels/:channelId/delete', requireSecretPath, requireAdmin, async (req: Request, res: Response) => {
  const secret = req.params.secret;
  const rawChannelId = Array.isArray(req.params.channelId) ? req.params.channelId[0] : req.params.channelId;

  if (!rawChannelId) {
    res.redirect(`/app/${secret}/channels?error=channel_not_found`);
    return;
  }

  const channel = getChannelById(rawChannelId);
  if (!channel) {
    res.redirect(`/app/${secret}/channels?error=channel_not_found`);
    return;
  }

  try {
    console.log(`[admin] Deleting channel ${channel.id} (${channel.name})...`);

    // 1. Disconnect and wipe WhatsApp session (closes socket, removes disk auth folder, wipes Supabase whatsapp_connections)
    await whatsAppService.deleteSession(channel.id);

    // 2. Disconnect Google account and remove tokens from Supabase google_connections
    await googleService.disconnectGoogle(channel.id);

    // 3. Unassign any operator linked to this channel (operators are NOT deleted, channel_id set to null)
    await authService.unassignOperatorsFromChannel(channel.id);

    // 4. Delete channel and its leads from local SQLite
    deleteChannelLocal(channel.id);

    // 5. Delete channel from Supabase channels table
    await supabaseService.deleteChannel(channel.id);

    console.log(`[admin] Channel ${channel.id} successfully deleted.`);
    res.redirect(`/app/${secret}/channels?notice=channel_deleted`);
  } catch (err: any) {
    console.error(`[admin] Failed to delete channel ${channel.id}:`, err);
    res.redirect(`/app/${secret}/channels?error=delete_failed`);
  }
});

// GET /app/:secret/channels/:channelId - Channel Details View
router.get('/app/:secret/channels/:channelId', requireSecretPath, requireAdmin, (req: Request, res: Response) => {
  const secret = req.params.secret;
  const rawChannelId = Array.isArray(req.params.channelId) ? req.params.channelId[0] : req.params.channelId;

  if (!rawChannelId) {
    res.status(404).send('Channel Not Found');
    return;
  }

  const channel = getChannelById(rawChannelId);
  if (!channel) {
    res.status(404).send('Channel Not Found');
    return;
  }

  const leadCount = countLeadsByChannelId(channel.id);

  res.render('channel_detail', {
    appTitle: 'LeadPush',
    appSecret: secret,
    activeNav: 'channels',
    user: req.user,
    channel: {
      ...channel,
      lead_count: leadCount,
      created_at_formatted: formatReadableTimestamp(channel.created_at)
    }
  });
});

export default router;
