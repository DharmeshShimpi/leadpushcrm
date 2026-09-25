import path from 'path';
import fs from 'fs';
import QRCode from 'qrcode';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  WASocket,
  proto,
  WAMessage
} from '@whiskeysockets/baileys';
import pino from 'pino';
import {
  saveMessageAndUpsertCanonicalLead,
  saveLidPhoneMapping,
  lookupPhoneByLid,
  lookupContactNameByLid,
  getLeadById,
  updateLeadInactivityDebounce,
  getUnresolvedLeads,
  saveContactToCache,
  lookupContactNameFromCache,
  updateLeadNameByJid,
  cleanValidCustomerName,
  ensureChannelExists,
  findLeadByAnyJid,
  updateLeadNameByPhone,
  extractDigitsOnly
} from '../db/index.js';
import { supabaseService } from './supabaseService.js';
import { googleService } from './googleService.js';

export type WhatsAppState =
  | 'not_connected'
  | 'waiting_for_qr'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'logged_out';

export interface WhatsAppStatus {
  state: WhatsAppState;
  connectedNumber: string | null;
  lastConnectedAt: string | null;
  qrAvailable: boolean;
  pairingCodeAvailable: boolean;
  pairingCode?: string | null;
  pairingPhone?: string | null;
}

export interface ResolvedLeadIdentity {
  canonicalJid: string;
  knownAliases: string[];
  displayPhone: string | null;
  jidType: 'pn' | 'lid' | 'other';
  isBusinessSelf: boolean;
  customerName: string | null;
}

export interface WhatsAppSession {
  channelId: string;
  socket: WASocket | null;
  state: WhatsAppState;
  qrDataUrl: string | null;
  pairingCode: string | null;
  pairingCodePhoneNumber: string | null;
  pairingCodeGeneratedAt: number;
  connectedNumber: string | null;
  lastConnectedAt: string | null;
  authDir: string;
  isInitializing: boolean;
  reconnectTimeout: NodeJS.Timeout | null;
  reconnectAttempts: number;
  backupDebounceTimer: NodeJS.Timeout | null;
}

class WhatsAppService {
  private sessions: Map<string, WhatsAppSession> = new Map();

  constructor() {
    // Note: session instances are initialized lazily or via initialize(channelId)
  }

  public getConnectedSessions(): WhatsAppSession[] {
    return Array.from(this.sessions.values()).filter(s => s.socket && s.state === 'connected');
  }

  /**
   * Resolve dedicated disk path for session credentials per channel
   */
  public getAuthPath(channelId: string): string {
    return path.join(process.cwd(), 'data', 'baileys-auth', channelId || 'unassigned');
  }

  /**
   * Get or create in-memory session object for a channel
   */
  public getOrCreateSession(channelId: string): WhatsAppSession {
    const key = channelId || 'unassigned';
    let session = this.sessions.get(key);
    if (!session) {
      const authDir = this.getAuthPath(key);
      if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
      }

      session = {
        channelId: key,
        socket: null,
        state: 'not_connected',
        qrDataUrl: null,
        pairingCode: null,
        pairingCodePhoneNumber: null,
        pairingCodeGeneratedAt: 0,
        connectedNumber: null,
        lastConnectedAt: null,
        authDir,
        isInitializing: false,
        reconnectTimeout: null,
        reconnectAttempts: 0,
        backupDebounceTimer: null
      };

      this.sessions.set(key, session);
    }
    return session;
  }

  public getSession(channelId?: string): WhatsAppSession | undefined {
    return channelId ? this.sessions.get(channelId) : undefined;
  }

  /**
   * Disconnect and wipe WhatsApp session completely for a channel
   */
  public async deleteSession(channelId: string): Promise<void> {
    if (!channelId) return;
    const session = this.sessions.get(channelId);
    if (session) {
      if (session.reconnectTimeout) {
        clearTimeout(session.reconnectTimeout);
        session.reconnectTimeout = null;
      }
      if (session.backupDebounceTimer) {
        clearTimeout(session.backupDebounceTimer);
        session.backupDebounceTimer = null;
      }
      try {
        if (session.socket) {
          session.socket.end(new Error('Channel deleted by admin'));
          session.socket = null;
        }
      } catch (sockErr) {
        console.warn(`[whatsapp] Error ending socket for channel ${channelId}:`, sockErr);
      }
      this.sessions.delete(channelId);
    }

    // Delete local auth directory on disk
    const authDir = this.getAuthPath(channelId);
    if (fs.existsSync(authDir)) {
      try {
        fs.rmSync(authDir, { recursive: true, force: true });
        console.log(`[whatsapp] Deleted auth folder on disk for channel ${channelId}`);
      } catch (rmErr) {
        console.warn(`[whatsapp] Failed removing auth folder for ${channelId}:`, rmErr);
      }
    }

    // Clear cloud credentials row from Supabase
    try {
      await supabaseService.clearWhatsAppConnection(channelId);
    } catch (clearErr) {
      console.warn(`[whatsapp] Failed clearing Supabase WhatsApp connection for ${channelId}:`, clearErr);
    }
  }

  /**
   * Check if registered WhatsApp credentials exist on disk for this channel
   */
  public hasCredentials(channelId: string): boolean {
    if (!channelId) return false;
    const authDir = this.getAuthPath(channelId);
    const credsPath = path.join(authDir, 'creds.json');
    if (!fs.existsSync(credsPath)) return false;
    try {
      const content = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      return !!(content && (content.registered === true || content.me));
    } catch {
      return false;
    }
  }

  private scheduleCloudBackup(session: WhatsAppSession): void {
    if (session.backupDebounceTimer) {
      clearTimeout(session.backupDebounceTimer);
    }
    session.backupDebounceTimer = setTimeout(async () => {
      try {
        if (fs.existsSync(session.authDir)) {
          const files = fs.readdirSync(session.authDir);
          const bundle: Record<string, string> = {};
          for (const file of files) {
            if (file.startsWith('lid-mapping-')) continue;
            const fullPath = path.join(session.authDir, file);
            if (fs.statSync(fullPath).isFile()) {
              bundle[file] = fs.readFileSync(fullPath, 'utf8');
            }
          }
          if (Object.keys(bundle).length > 0) {
            const rawJid = session.socket?.user?.id || null;
            const phone = rawJid ? (extractPhoneDigits(rawJid) || rawJid) : session.connectedNumber;
            await supabaseService.saveWhatsAppSession(
              bundle,
              {
                phoneNumber: phone,
                jid: rawJid,
                connectionStatus: session.state
              },
              session.channelId
            );
          }
        }
      } catch (backupErr) {
        console.warn(`[dev] whatsapp_cloud_backup_error for channel ${session.channelId}:`, backupErr);
      }
    }, 1500);
  }

  public async initialize(channelId: string): Promise<void> {
    if (!channelId) return;
    ensureChannelExists(channelId);
    const session = this.getOrCreateSession(channelId);

    // Prevent duplicate sockets for the same channel
    if (session.isInitializing || session.socket) return;
    session.isInitializing = true;
    this.updateState(session, 'connecting');

    try {
      // 1. If local auth dir is empty, restore credentials from encrypted Supabase single-row cloud backup
      const localFiles = fs.existsSync(session.authDir) ? fs.readdirSync(session.authDir) : [];
      if (localFiles.length === 0) {
        await supabaseService.restoreWhatsAppSession(session.authDir, session.channelId);
      }

      const { state: authState, saveCreds } = await useMultiFileAuthState(session.authDir);

      // Silent logger to avoid cluttering standard output and leaking credentials
      const logger = pino({ level: 'silent' });

      session.socket = makeWASocket({
        auth: authState,
        printQRInTerminal: false,
        logger: logger,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        syncFullHistory: false
      });

      session.socket.ev.on('creds.update', async () => {
        await saveCreds();
        this.scheduleCloudBackup(session);
      });

      // Subscribe to all Baileys events
      this.setupSocketEvents(session, session.socket, saveCreds);
    } catch (err) {
      console.error(`Error initializing WhatsApp Baileys socket for channel ${session.channelId}:`, err);
      session.isInitializing = false;
      this.updateState(session, 'disconnected');
      this.scheduleReconnect(session);
    }
  }

  /**
   * Subscribe to all Baileys socket events (messages, contacts, connection, etc.) for a session.
   */
  private setupSocketEvents(session: WhatsAppSession, sock: WASocket, _saveCreds: () => Promise<void>): void {
    // Subscribe to messages.upsert for Phase 4 ingestion
    sock.ev.on('messages.upsert', async (m) => {
      try {
        if (m.type === 'notify' || m.type === 'append') {
          for (const msg of m.messages) {
            await this.processIncomingMessage(session, msg);
          }
        }
      } catch (err) {
        console.error(`Error processing Baileys messages.upsert event for channel ${session.channelId}:`, err);
      }
    });

    // Subscribe to contacts events to capture and sync contact names
    sock.ev.on('contacts.upsert', (contacts) => {
      try {
        for (const c of contacts) {
          if (c && c.id) {
            saveContactToCache({
              jid: c.id,
              name: c.name || null,
              notify: c.notify || null,
              verifiedName: c.verifiedName || null,
              source: 'contacts_upsert'
            });
          }
        }
      } catch (err) {
        console.error(`Error handling contacts.upsert event for channel ${session.channelId}:`, err);
      }
    });

    sock.ev.on('contacts.update', (updates) => {
      try {
        for (const u of updates) {
          if (u && u.id) {
            saveContactToCache({
              jid: u.id,
              name: u.name || null,
              notify: u.notify || null,
              verifiedName: u.verifiedName || null,
              source: 'contacts_update'
            });
          }
        }
      } catch (err) {
        console.error(`Error handling contacts.update event for channel ${session.channelId}:`, err);
      }
    });

    // Subscribe to chats events for contact/group names
    sock.ev.on('chats.upsert', (chats) => {
      try {
        for (const ch of chats) {
          if (ch && ch.id && ch.name) {
            saveContactToCache({
              jid: ch.id,
              name: ch.name,
              notify: null,
              verifiedName: null,
              source: 'chats_upsert'
            });
          }
        }
      } catch (err) {
        console.error(`Error handling chats.upsert event for channel ${session.channelId}:`, err);
      }
    });

    sock.ev.on('chats.update', (updates) => {
      try {
        for (const ch of updates) {
          if (ch && ch.id && ch.name) {
            saveContactToCache({
              jid: ch.id,
              name: ch.name,
              notify: null,
              verifiedName: null,
              source: 'chats_update'
            });
          }
        }
      } catch (err) {
        console.error(`Error handling chats.update event for channel ${session.channelId}:`, err);
      }
    });

    // Only track live LID mapping updates on demand
    sock.ev.on('lid-mapping.update', ({ lid, pn }) => {
      try {
        if (lid && pn) {
          saveLidPhoneMapping(lid, pn, 'lid_mapping_update');
        }
      } catch (err) {
        console.error(`Error handling lid-mapping.update event for channel ${session.channelId}:`, err);
      }
    });

    // Handle history synchronization: populate contact names and LID mappings without creating leads
    sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, lidPnMappings }) => {
      try {
        console.log(`[whatsapp] messaging-history.set received for channel ${session.channelId}: ${messages?.length || 0} messages, ${contacts?.length || 0} contacts, ${chats?.length || 0} chats`);

        // 1. Process LID-PN mappings (for contact resolution only)
        if (lidPnMappings && Array.isArray(lidPnMappings)) {
          for (const m of lidPnMappings) {
            if (m && m.lid && m.pn) {
              saveLidPhoneMapping(m.lid, m.pn, 'history_sync');
            }
          }
        }

        // 2. Process contacts to populate names cache (do NOT create leads from contacts)
        if (contacts && Array.isArray(contacts)) {
          for (const c of contacts) {
            if (c && c.id) {
              saveContactToCache({
                jid: c.id,
                name: c.name || null,
                notify: c.notify || null,
                verifiedName: c.verifiedName || null,
                source: 'history_sync'
              });
            }
          }
        }

        // 3. Process historical messages ONLY for leads that ALREADY exist in the database
        // (Never create new leads from past chat history or saved contacts)
        if (messages && Array.isArray(messages)) {
          for (const msg of messages) {
            const remoteJid = msg?.key?.remoteJid;
            if (!remoteJid || remoteJid === 'status@broadcast' || remoteJid.endsWith('@g.us') || remoteJid.endsWith('@broadcast') || remoteJid.endsWith('@newsletter')) {
              continue;
            }
            const candidateJids = [remoteJid];
            if (msg.key?.participant) candidateJids.push(msg.key.participant);
            const existing = findLeadByAnyJid(candidateJids, session.channelId);
            if (existing) {
              await this.processIncomingMessage(session, msg, true);
            }
          }
        }
      } catch (err) {
        console.error(`Error handling messaging-history.set for channel ${session.channelId}:`, err);
      }
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          session.qrDataUrl = await QRCode.toDataURL(qr);
          this.updateState(session, 'waiting_for_qr');
        } catch (err) {
          console.error(`Failed to generate QR data URL for channel ${session.channelId}:`, err);
        }
      }

      if (connection === 'open') {
        session.reconnectAttempts = 0;
        session.qrDataUrl = null;
        session.pairingCode = null;
        session.pairingCodePhoneNumber = null;

        // Extract connected WhatsApp phone number safely from user JID
        const rawJid = session.socket?.user?.id || '';
        const phone = extractPhoneDigits(rawJid) || rawJid;
        session.connectedNumber = phone;
        session.lastConnectedAt = new Date().toISOString();
        this.updateState(session, 'connected');
        this.scheduleCloudBackup(session);

        // Trigger automatic resolution for any unresolved leads
        this.resolveAllUnresolvedLeads(session).catch(err => {
          console.error(`Error resolving unresolved leads on connection open for channel ${session.channelId}:`, err);
        });
      } else if (connection === 'close') {
        session.socket = null;
        session.isInitializing = false;

        const error = lastDisconnect?.error as { output?: { statusCode?: number } } | undefined;
        const statusCode = error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const isReplaced = statusCode === DisconnectReason.connectionReplaced;

        if (isLoggedOut) {
          console.log(`WhatsApp Baileys session logged out for channel ${session.channelId}.`);
          this.updateState(session, 'logged_out');
          session.connectedNumber = null;
          session.qrDataUrl = null;
          await this.clearAuthDirectory(session);
        } else if (isReplaced) {
          console.log(`WhatsApp connection replaced for channel ${session.channelId} (status: 440). Standing by for new connection.`);
          this.updateState(session, 'disconnected');
        } else {
          console.log(`WhatsApp socket closed for channel ${session.channelId} (status: ${statusCode}). Scheduling reconnect...`);
          this.updateState(session, 'disconnected');
          this.scheduleReconnect(session);
        }
      }
    });
  }

  /**
   * Process and ingest an incoming or outgoing Baileys message event
   */
  public async processIncomingMessage(session: WhatsAppSession, msg: WAMessage, isHistory = false): Promise<void> {
    if (!msg || !msg.key) return;

    const remoteJid = msg.key.remoteJid;
    if (!remoteJid) return;

    // Ignore status broadcasts, group messages, broadcast lists, and newsletter channels
    if (
      remoteJid === 'status@broadcast' ||
      remoteJid.endsWith('@g.us') ||
      remoteJid.endsWith('@broadcast') ||
      remoteJid.endsWith('@newsletter') ||
      remoteJid.includes('broadcast')
    ) {
      return;
    }

    // Message ID
    const waMessageId = msg.key.id;
    if (!waMessageId) return;

    // Direction
    const direction: 'incoming' | 'outgoing' = msg.key.fromMe ? 'outgoing' : 'incoming';

    // Extract text content and type
    const { text, messageType } = extractMessageText(msg.message);

    // Skip unsupported/unrecognized message types that yield no useful text
    if (messageType === 'unknown' || messageType === 'protocol') {
      console.log(`[dev] skipped_${messageType}_message: wa_msg_id=${waMessageId}`);
      return;
    }

    // Resolve canonical identity, aliases, and business self status
    const resolved = resolveLeadIdentity(msg, session.connectedNumber);

    // Rule C: Never create business self account as a lead
    if (resolved.isBusinessSelf) {
      console.log('[dev] skipped_business_self_message: Message ignored as business self-account');
      return;
    }

    // Historical messages from history sync must NEVER create a new lead (they only attach to existing leads).
    // Live messages (both incoming from customer and outgoing from operator to lead) always create/update the lead!
    const existingLead = findLeadByAnyJid(resolved.knownAliases, session.channelId);
    if (!existingLead && isHistory) {
      return;
    }

    // Message timestamp
    const timestampSec = typeof msg.messageTimestamp === 'number'
      ? msg.messageTimestamp
      : (msg.messageTimestamp && typeof msg.messageTimestamp === 'object' && 'low' in msg.messageTimestamp)
        ? (msg.messageTimestamp as { low: number }).low
        : Math.floor(Date.now() / 1000);

    const sentAt = new Date(timestampSec * 1000).toISOString();

    // If customerName is missing, attempt immediate Baileys lookup for both incoming and outgoing messages
    if (!resolved.customerName && session.socket) {
      try {
        const digits = extractPhoneDigits(resolved.displayPhone || resolved.canonicalJid);
        const targetJid = digits ? `${digits}@s.whatsapp.net` : (resolved.canonicalJid.includes('@s.whatsapp.net') ? resolved.canonicalJid : null);
        if (targetJid) {
          const biz = await session.socket.getBusinessProfile(targetJid);
          const rawBiz = biz as unknown as Record<string, unknown> | undefined;
          const cleanBiz = cleanValidCustomerName(typeof rawBiz?.name === 'string' ? rawBiz.name : null);
          if (cleanBiz) {
            resolved.customerName = cleanBiz;
            saveContactToCache({
              jid: targetJid,
              name: cleanBiz,
              verifiedName: cleanBiz,
              source: 'business_profile_lookup'
            });
          }
        }
      } catch {}
    }

    // Idempotently save message & upsert canonical lead in SQLite scoped to session.channelId
    const ingestRes = saveMessageAndUpsertCanonicalLead({
      channel_id: session.channelId,
      wa_message_id: waMessageId,
      canonicalJid: resolved.canonicalJid,
      candidateJids: resolved.knownAliases,
      direction: direction,
      sender_name: resolved.customerName,
      message_text: text || messageType,
      message_type: messageType,
      displayPhone: resolved.displayPhone,
      isBusinessSelf: resolved.isBusinessSelf,
      sent_at: sentAt
    });

    // Update 2-minute inactivity debounce timer for Groq analysis (only for live or fresh messages)
    if (ingestRes.leadId) {
      const isRecent = (Date.now() - new Date(sentAt).getTime()) < 5 * 60 * 1000;
      if (!isHistory || isRecent) {
        updateLeadInactivityDebounce(ingestRes.leadId, sentAt);
      }

      const updatedLead = getLeadById(ingestRes.leadId);
      if (updatedLead) {
        supabaseService.syncLead(updatedLead).catch(err => {
          console.error('[dev] async_supabase_sync_error:', err);
        });

        googleService.syncLeadToSheet(updatedLead).catch(err => {
          console.error('[dev] async_google_sheet_sync_error:', err);
        });
      }
    }
  }

  /**
   * Attempt to query Baileys internal signalRepository for a JID (LID or phone) to resolve LID <-> phone mapping
   */
  public async tryResolveLid(session: WhatsAppSession, lidJid: string): Promise<string | null> {
    if (!session.socket || !lidJid || !lidJid.endsWith('@lid')) return null;
    const cleanLid = lidJid;

    try {
      // 1. Check DB cache
      const existingPhone = lookupPhoneByLid(cleanLid);
      if (existingPhone) {
        saveLidPhoneMapping(cleanLid, existingPhone, 'db_cache_hit');
        return existingPhone;
      }

      const socketWithMapping = session.socket as unknown as {
        signalRepository?: {
          lidMapping?: { getPNForLID: (lid: string) => Promise<string | null> };
        };
      };
      const resolvedPhone = await socketWithMapping.signalRepository?.lidMapping?.getPNForLID(cleanLid);
      if (resolvedPhone) {
        saveLidPhoneMapping(cleanLid, resolvedPhone, 'baileys_v7_lid_store');
        return resolvedPhone;
      }

      return null;
    } catch (err) {
      console.error(`[dev] tryResolveLid_error for ${lidJid}:`, err);
    }
    return null;
  }

  /**
   * Iterate over all unresolved leads in DB and query Baileys socket to resolve LID, phone numbers, and contact/business names
   */
  public async resolveAllUnresolvedLeads(session?: WhatsAppSession): Promise<void> {
    const activeSessions = session ? [session] : this.getConnectedSessions();
    if (activeSessions.length === 0) return;

    for (const s of activeSessions) {
      if (!s.socket || s.state !== 'connected') continue;
      try {
        const unresolved = getUnresolvedLeads();
        for (const lead of unresolved) {
          // 1. Resolve LID to phone if needed
          if (lead.lead_identity && lead.lead_identity.endsWith('@lid')) {
            await this.tryResolveLid(s, lead.lead_identity);
          } else if (lead.whatsapp_jid && lead.whatsapp_jid.endsWith('@lid')) {
            await this.tryResolveLid(s, lead.whatsapp_jid);
          }

          // 2. Check contacts cache for name
          const candidateJids = [lead.lead_identity, lead.whatsapp_jid, lead.whatsapp_phone].filter(Boolean) as string[];
          let cachedName = lookupContactNameFromCache(candidateJids);
          const digits = extractDigitsOnly(lead.whatsapp_phone || lead.lead_identity || lead.whatsapp_jid);
          if (!cachedName && digits) {
            cachedName = lookupContactNameFromCache(digits);
          }

          if (cachedName && lead.id) {
            updateLeadNameByJid(lead.lead_identity, cachedName);
            if (digits) updateLeadNameByPhone(digits, cachedName);
            continue;
          }

          // 3. If name is still missing and we have a PN JID, query WhatsApp business profile for verified name
          const targetJid = digits 
            ? `${digits}@s.whatsapp.net` 
            : (lead.whatsapp_jid?.includes('@s.whatsapp.net') 
                ? lead.whatsapp_jid 
                : (lead.lead_identity?.includes('@s.whatsapp.net') ? lead.lead_identity : null));

          if (targetJid && s.socket) {
            try {
              const bizProfile = await s.socket.getBusinessProfile(targetJid);
              const rawBiz = bizProfile as unknown as Record<string, unknown> | undefined;
              const cleanBizName = cleanValidCustomerName(typeof rawBiz?.name === 'string' ? rawBiz.name : null);
              if (cleanBizName) {
                saveContactToCache({
                  jid: targetJid,
                  name: cleanBizName,
                  verifiedName: cleanBizName,
                  source: 'business_profile_lookup'
                });
                updateLeadNameByJid(lead.lead_identity, cleanBizName);
                if (digits) updateLeadNameByPhone(digits, cleanBizName);
              }
            } catch {
              // Not a business profile or rate limited, ignore
            }
          }
        }
      } catch (err) {
        console.error(`Error in resolveAllUnresolvedLeads for channel ${s.channelId}:`, err);
      }
    }
  }

  private scheduleReconnect(session: WhatsAppSession): void {
    if (session.reconnectTimeout) {
      clearTimeout(session.reconnectTimeout);
    }
    // Exponential backoff capped at 30 seconds
    const delay = Math.min(30000, Math.pow(2, session.reconnectAttempts) * 3000);
    session.reconnectAttempts++;

    session.reconnectTimeout = setTimeout(() => {
      this.initialize(session.channelId);
    }, delay);
  }

  private updateState(session: WhatsAppSession, newState: WhatsAppState): void {
    session.state = newState;
  }

  public getStatus(channelId?: string): WhatsAppStatus {
    if (!channelId) {
      return {
        state: 'not_connected',
        connectedNumber: null,
        lastConnectedAt: null,
        qrAvailable: false,
        pairingCodeAvailable: false
      };
    }
    const session = this.getOrCreateSession(channelId);
    const pairingInfo = this.getPairingCode(channelId);
    return {
      state: session.state,
      connectedNumber: session.connectedNumber,
      lastConnectedAt: session.lastConnectedAt,
      qrAvailable: !!session.qrDataUrl,
      pairingCodeAvailable: !!pairingInfo.code,
      pairingCode: pairingInfo.code,
      pairingPhone: pairingInfo.phoneNumber
    };
  }

  public getQRDataUrl(channelId?: string): string | null {
    if (!channelId) return null;
    const session = this.getOrCreateSession(channelId);
    return session.qrDataUrl;
  }

  /**
   * Request an 8-character pairing code for linking via phone number for a channel.
   */
  public async requestPairingCode(phoneNumber: string, channelId: string): Promise<string> {
    const session = this.getOrCreateSession(channelId);
    const cleanPhone = phoneNumber.replace(/\D/g, '');
    if (!cleanPhone || cleanPhone.length < 10) {
      throw new Error('Please enter a valid phone number with country code (e.g. 919876543210).');
    }

    if (session.state === 'connected' && session.socket?.user) {
      throw new Error('WhatsApp is already connected. Reset session first to link another number.');
    }

    if (session.reconnectTimeout) {
      clearTimeout(session.reconnectTimeout);
      session.reconnectTimeout = null;
    }

    // Reset session credentials to guarantee fresh pairing
    await this.clearAuthDirectory(session);

    if (session.socket) {
      try {
        session.socket.end(undefined);
      } catch {
        // ignore close error
      }
      session.socket = null;
    }
    session.isInitializing = false;
    session.reconnectAttempts = 0;

    const { state: authState, saveCreds } = await useMultiFileAuthState(session.authDir);
    const logger = pino({ level: 'silent' });

    const sock = makeWASocket({
      auth: authState,
      printQRInTerminal: false,
      logger: logger,
      browser: ['Ubuntu', 'Chrome', '20.0.04']
    });

    session.socket = sock;

    sock.ev.on('creds.update', async () => {
      await saveCreds();
      this.scheduleCloudBackup(session);
    });

    this.setupSocketEvents(session, sock, saveCreds);

    try {
      if (authState.creds.registered) {
        throw new Error('This session is already registered. Please reset session.');
      }

      await new Promise(r => setTimeout(r, 1500));

      const rawCode = await sock.requestPairingCode(cleanPhone);
      if (!rawCode) {
        throw new Error('WhatsApp did not return a pairing code. Please verify your phone number.');
      }

      const formattedCode = rawCode.length >= 8
        ? `${rawCode.slice(0, 4)}-${rawCode.slice(4)}`
        : rawCode;

      session.pairingCode = formattedCode;
      session.pairingCodePhoneNumber = cleanPhone;
      session.pairingCodeGeneratedAt = Date.now();

      return formattedCode;
    } catch (err: any) {
      console.error(`[WhatsAppService] Error requesting pairing code for channel ${session.channelId}:`, err);
      throw new Error(err?.message || 'Failed to request pairing code from WhatsApp.');
    }
  }

  public getPairingCode(channelId?: string): { code: string | null; phoneNumber: string | null; ageSeconds: number } {
    if (!channelId) {
      return { code: null, phoneNumber: null, ageSeconds: 0 };
    }
    const session = this.getOrCreateSession(channelId);
    if (!session.pairingCode) {
      return { code: null, phoneNumber: null, ageSeconds: 0 };
    }
    const ageSeconds = Math.floor((Date.now() - session.pairingCodeGeneratedAt) / 1000);
    if (ageSeconds > 180) {
      session.pairingCode = null;
      session.pairingCodePhoneNumber = null;
      return { code: null, phoneNumber: null, ageSeconds: 0 };
    }
    return {
      code: session.pairingCode,
      phoneNumber: session.pairingCodePhoneNumber,
      ageSeconds
    };
  }

  public async reconnect(channelId: string): Promise<void> {
    const session = this.getOrCreateSession(channelId);
    if (session.socket) {
      try {
        session.socket.end(undefined);
      } catch {
        // ignore close error
      }
      session.socket = null;
    }
    session.isInitializing = false;
    session.reconnectAttempts = 0;
    session.pairingCode = null;
    session.pairingCodePhoneNumber = null;
    await this.initialize(channelId);
  }

  public async resetSession(channelId: string): Promise<void> {
    const session = this.getOrCreateSession(channelId);
    if (session.reconnectTimeout) {
      clearTimeout(session.reconnectTimeout);
      session.reconnectTimeout = null;
    }

    if (session.socket) {
      try {
        session.socket.end(undefined);
      } catch {
        // ignore close error
      }
      session.socket = null;
    }

    session.isInitializing = false;
    session.qrDataUrl = null;
    session.pairingCode = null;
    session.pairingCodePhoneNumber = null;
    session.connectedNumber = null;
    this.updateState(session, 'not_connected');

    await this.clearAuthDirectory(session);
  }

  private async clearAuthDirectory(session: WhatsAppSession): Promise<void> {
    try {
      if (fs.existsSync(session.authDir)) {
        fs.rmSync(session.authDir, { recursive: true, force: true });
        fs.mkdirSync(session.authDir, { recursive: true });
      }
      await supabaseService.clearWhatsAppConnection(session.channelId);
    } catch (err) {
      console.error(`Error clearing auth directory for channel ${session.channelId}:`, err);
    }
  }

  public async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.reconnectTimeout) {
        clearTimeout(session.reconnectTimeout);
        session.reconnectTimeout = null;
      }
      if (session.backupDebounceTimer) {
        clearTimeout(session.backupDebounceTimer);
        session.backupDebounceTimer = null;
      }
      if (session.socket) {
        try {
          session.socket.end(undefined);
        } catch {
          // ignore close error
        }
        session.socket = null;
      }
      session.isInitializing = false;
    }
  }
}

export function extractPhoneDigits(str: string | null | undefined): string | null {
  if (!str) return null;
  if (str.includes('@lid')) return null;
  const parts = str.split('@')[0].split(':')[0];
  const digits = parts.replace(/\D/g, '');
  return (digits.length >= 7 && digits.length <= 13) ? digits : null;
}

// Helper: Extract text and message type, unwrapping common container wrappers
export function extractMessageText(msgObj: proto.IMessage | null | undefined): { text: string | null; messageType: string } {
  if (!msgObj) return { text: null, messageType: 'unknown' };

  // Unwrap containers
  if (msgObj.ephemeralMessage?.message) {
    return extractMessageText(msgObj.ephemeralMessage.message);
  }
  if (msgObj.viewOnceMessage?.message) {
    return extractMessageText(msgObj.viewOnceMessage.message);
  }
  if (msgObj.viewOnceMessageV2?.message) {
    return extractMessageText(msgObj.viewOnceMessageV2.message);
  }
  if (msgObj.viewOnceMessageV2Extension?.message) {
    return extractMessageText(msgObj.viewOnceMessageV2Extension.message);
  }
  if (msgObj.documentWithCaptionMessage?.message) {
    return extractMessageText(msgObj.documentWithCaptionMessage.message);
  }

  if (msgObj.conversation) {
    return { text: msgObj.conversation, messageType: 'text' };
  }
  if (msgObj.extendedTextMessage?.text) {
    return { text: msgObj.extendedTextMessage.text, messageType: 'text' };
  }
  if (msgObj.imageMessage) {
    return { text: msgObj.imageMessage.caption || '[Image]', messageType: 'image' };
  }
  if (msgObj.videoMessage) {
    return { text: msgObj.videoMessage.caption || '[Video]', messageType: 'video' };
  }
  if (msgObj.documentMessage) {
    return { text: msgObj.documentMessage.caption || msgObj.documentMessage.fileName || '[Document]', messageType: 'document' };
  }
  if (msgObj.audioMessage) {
    return { text: '[Audio]', messageType: 'audio' };
  }
  if (msgObj.stickerMessage) {
    return { text: '[Sticker]', messageType: 'sticker' };
  }
  if (msgObj.contactMessage) {
    return { text: `[Contact: ${msgObj.contactMessage.displayName || 'Shared'}]`, messageType: 'contact' };
  }
  if (msgObj.contactsArrayMessage) {
    const count = msgObj.contactsArrayMessage.contacts?.length || 0;
    return { text: `[${count} Contacts shared]`, messageType: 'contacts' };
  }
  if (msgObj.locationMessage || msgObj.liveLocationMessage) {
    return { text: '[Location]', messageType: 'location' };
  }
  if (msgObj.reactionMessage) {
    const emoji = msgObj.reactionMessage.text || '';
    return { text: emoji ? `Reacted: ${emoji}` : '[Reaction removed]', messageType: 'reaction' };
  }
  if (msgObj.pollCreationMessage || msgObj.pollCreationMessageV2 || msgObj.pollCreationMessageV3) {
    const poll = msgObj.pollCreationMessage || msgObj.pollCreationMessageV2 || msgObj.pollCreationMessageV3;
    return { text: `[Poll: ${poll?.name || 'Untitled'}]`, messageType: 'poll' };
  }
  if (msgObj.pollUpdateMessage) {
    return { text: '[Poll vote]', messageType: 'poll_vote' };
  }
  if (msgObj.editedMessage?.message) {
    return extractMessageText(msgObj.editedMessage.message);
  }
  if (msgObj.buttonsResponseMessage?.selectedDisplayText || msgObj.buttonsResponseMessage?.selectedButtonId) {
    const text = msgObj.buttonsResponseMessage.selectedDisplayText || msgObj.buttonsResponseMessage.selectedButtonId || null;
    return { text, messageType: 'button_reply' };
  }
  if (msgObj.listResponseMessage?.title || msgObj.listResponseMessage?.singleSelectReply?.selectedRowId) {
    const text = msgObj.listResponseMessage.title || msgObj.listResponseMessage.singleSelectReply?.selectedRowId || null;
    return { text, messageType: 'list_reply' };
  }
  if (msgObj.templateButtonReplyMessage?.selectedDisplayText || msgObj.templateButtonReplyMessage?.selectedId) {
    const text = msgObj.templateButtonReplyMessage.selectedDisplayText || msgObj.templateButtonReplyMessage.selectedId || null;
    return { text, messageType: 'button_reply' };
  }
  if (msgObj.interactiveResponseMessage) {
    return { text: '[Interactive Response]', messageType: 'interactive_response' };
  }
  // Protocol messages (read receipts, key distribution, etc.) — skip silently
  if (msgObj.protocolMessage || msgObj.senderKeyDistributionMessage) {
    return { text: null, messageType: 'protocol' };
  }

  // Log unrecognized types for debugging
  const keys = Object.keys(msgObj).filter(k => k !== 'messageContextInfo');
  if (keys.length > 0) {
    console.log(`[dev] unrecognized_message_type: keys=${keys.join(',')}`);
  }

  return { text: '[Unsupported message]', messageType: 'unsupported' };
}

// Helper: Resolve lead identity, candidate aliases, display phone, and business self check
export function resolveLeadIdentity(msg: WAMessage, connectedBusinessNumber: string | null): ResolvedLeadIdentity {
  const candidateJids: string[] = [];

  const key = msg.key;
  const isFromMe = !!key.fromMe;
  const businessDigits = extractPhoneDigits(connectedBusinessNumber);

  // The remote chat partner is the lead
  if (key.remoteJid) candidateJids.push(key.remoteJid);
  
  const keyAny = key as unknown as Record<string, unknown>;
  const msgAny = msg as unknown as Record<string, unknown>;

  if (typeof keyAny.remoteJidAlt === 'string' && keyAny.remoteJidAlt) candidateJids.push(keyAny.remoteJidAlt);

  // In 1-on-1 chats:
  // For incoming messages (!isFromMe), participant/senderPn belongs to the customer.
  // For outgoing messages (isFromMe), participant belongs to the business operator, NOT the customer!
  if (!isFromMe) {
    if (typeof keyAny.senderPn === 'string' && keyAny.senderPn) candidateJids.push(keyAny.senderPn);
    if (typeof keyAny.senderPN === 'string' && keyAny.senderPN) candidateJids.push(keyAny.senderPN);
    if (typeof keyAny.participantPn === 'string' && keyAny.participantPn) candidateJids.push(keyAny.participantPn);
    if (typeof keyAny.participantPN === 'string' && keyAny.participantPN) candidateJids.push(keyAny.participantPN);
    if (typeof keyAny.participant === 'string' && keyAny.participant) candidateJids.push(keyAny.participant);
    if (typeof msgAny.participant === 'string' && msgAny.participant) candidateJids.push(msgAny.participant);
    if (typeof msgAny.senderPn === 'string' && msgAny.senderPn) candidateJids.push(msgAny.senderPn);
    if (typeof msgAny.senderPN === 'string' && msgAny.senderPN) candidateJids.push(msgAny.senderPN);
  }

  // If we have both a LID and a Phone JID, save the LID -> Phone mapping permanently
  const lidCandidate = candidateJids.find(j => j.endsWith('@lid'));
  const pnCandidate = candidateJids.find(j => j.includes('@s.whatsapp.net') || extractPhoneDigits(j));

  if (lidCandidate && pnCandidate) {
    const formattedPn = pnCandidate.includes('@s.whatsapp.net') ? pnCandidate : `${extractPhoneDigits(pnCandidate)}@s.whatsapp.net`;
    saveLidPhoneMapping(lidCandidate, formattedPn, 'message_key_metadata');
  }

  // Look up the lid_phone_map table for any LID candidate that doesn't have a PN already
  for (const jid of [...candidateJids]) {
    if (jid.endsWith('@lid')) {
      const mappedPhone = lookupPhoneByLid(jid);
      if (mappedPhone) {
        candidateJids.push(mappedPhone);
      }
    }
  }

  // Check if this chat is genuinely with the business self (e.g. Note to Self / Message Yourself)
  const remoteDigits = extractPhoneDigits(key.remoteJid);
  const isBusinessSelf = !!(businessDigits && remoteDigits && remoteDigits === businessDigits);

  // Filter out businessDigits from candidate JIDs unless the chat itself is with self
  const filteredCandidates = isBusinessSelf
    ? candidateJids
    : candidateJids.filter(jid => extractPhoneDigits(jid) !== businessDigits);

  // Deduplicate candidates
  const uniqueCandidates = Array.from(new Set(filteredCandidates.filter(Boolean)));

  // Find preferred PN JID and display phone
  let pnJid: string | null = null;
  let displayPhone: string | null = null;

  for (const jid of uniqueCandidates) {
    if (jid.includes('@s.whatsapp.net') || !jid.endsWith('@lid')) {
      const digits = extractPhoneDigits(jid);
      if (digits) {
        pnJid = jid;
        displayPhone = `+${digits}`;
        break;
      }
    }
  }

  // Determine canonical JID
  const canonicalJid = pnJid || uniqueCandidates[0] || '';
  const jidType: 'pn' | 'lid' | 'other' = canonicalJid.endsWith('@lid') ? 'lid' : (canonicalJid.includes('@s.whatsapp.net') ? 'pn' : 'other');
  
  // Extract pushName/verifiedBizName from incoming message and cache it
  const rawIncomingName = !key.fromMe ? (msg.pushName || (msg as unknown as Record<string, unknown>).verifiedBizName as string || null) : null;
  const cleanIncomingName = cleanValidCustomerName(rawIncomingName);
  if (cleanIncomingName) {
    saveContactToCache({
      jid: canonicalJid,
      name: cleanIncomingName,
      notify: cleanIncomingName,
      source: 'incoming_pushname'
    });
  }

  // Check contacts_cache table by all known candidate JIDs and displayPhone
  const cachedNameFromDb = lookupContactNameFromCache([...uniqueCandidates, displayPhone]);

  // Check lid_phone_map table for contact name
  const cachedLidName = uniqueCandidates
    .filter(jid => jid.endsWith('@lid'))
    .map(jid => lookupContactNameByLid(jid))
    .find((name): name is string => !!name);

  const customerName = cleanIncomingName || cachedNameFromDb || cleanValidCustomerName(cachedLidName) || null;

  return {
    canonicalJid,
    knownAliases: uniqueCandidates,
    displayPhone,
    jidType,
    isBusinessSelf,
    customerName
  };
}

export const whatsAppService = new WhatsAppService();

