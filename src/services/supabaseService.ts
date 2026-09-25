import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  Lead,
  getPendingSyncs,
  removePendingSync,
  enqueuePendingSync,
  getPendingSyncCount,
  countLocalLeads,
  restoreLeadFromSupabaseBackup,
  restoreChannelFromSupabaseBackup
} from '../db/index.js';

export interface SupabaseHealth {
  connected: boolean;
  lastSyncTime: string | null;
  pendingSyncCount: number;
  lastError: string | null;
}

class SupabaseService {
  private client: SupabaseClient | null = null;
  private lastSyncTime: string | null = null;
  private lastError: string | null = null;
  private retryIntervalTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.initClient();
  }

  private initClient(): void {
    const supabaseUrl = process.env.SUPABASE_URL || '';
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

    if (supabaseUrl && serviceRoleKey) {
      try {
        this.client = createClient(supabaseUrl, serviceRoleKey, {
          auth: { persistSession: false }
        });
      } catch (err) {
        console.error('Failed to initialize Supabase client:', err);
      }
    }
  }

  /**
   * Immediately mirror a lead (new creation or update) to Supabase lead_backups.
   * If Supabase is unavailable, enqueue lead into pending_supabase_syncs for retry.
   */
  public async syncLead(lead: Lead): Promise<boolean> {
    if (!lead) return false;

    if (!this.client) {
      this.initClient();
    }

    if (!this.client) {
      enqueuePendingSync(lead.id, 'Supabase client not initialized');
      return false;
    }

    try {
      let parsedAnswers = null;
      if (lead.extracted_answers) {
        try {
          parsedAnswers = typeof lead.extracted_answers === 'string'
            ? JSON.parse(lead.extracted_answers)
            : lead.extracted_answers;
        } catch {
          parsedAnswers = null;
        }
      }

      const payload = {
        channel_id: lead.channel_id || null,
        lead_identity: lead.lead_identity,
        whatsapp_jid: lead.whatsapp_jid,
        whatsapp_phone: lead.whatsapp_phone || null,
        customer_name: lead.customer_name || null,
        status: lead.status || 'analyzing',
        latest_message: lead.latest_message || null,
        first_activity_at: lead.first_activity_at,
        last_activity_at: lead.last_activity_at,
        confidence: lead.confidence != null ? lead.confidence : null,
        qualification_reason: lead.qualification_reason || null,
        conversation_summary: lead.conversation_summary || null,
        extracted_answers: parsedAnswers,
        google_sheet_row_number: lead.google_sheet_row_number != null ? lead.google_sheet_row_number : null,
        updated_at: lead.updated_at || new Date().toISOString()
      };

      const { error } = await this.client
        .from('lead_backups')
        .upsert(payload, { onConflict: 'lead_identity' });

      if (error) {
        throw error;
      }

      this.lastSyncTime = new Date().toISOString();
      this.lastError = null;
      removePendingSync(lead.id);
      console.log(`[dev] supabase_lead_synced: Lead #${lead.id} (${lead.lead_identity}) mirrored to Supabase`);
      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.lastError = errorMsg;
      console.warn(`[dev] supabase_sync_failed: Lead #${lead.id} queued for retry (${errorMsg})`);
      enqueuePendingSync(lead.id, errorMsg);
      return false;
    }
  }

  /**
   * Process all pending lead sync jobs (retried every 10 minutes)
   */
  public async processPendingSyncs(): Promise<void> {
    const pending = getPendingSyncs();
    if (pending.length === 0) return;

    console.log(`[dev] supabase_retry_queue: Processing ${pending.length} pending lead backups...`);
    for (const item of pending) {
      await this.syncLead(item.lead);
    }
  }

  /**
   * Start recurring 10-minute retry interval
   */
  public startRetryTimer(): void {
    if (this.retryIntervalTimer) return;
    console.log('[dev] supabase_worker: Started 10-minute retry timer.');
    const TEN_MINUTES_MS = 10 * 60 * 1000;
    this.retryIntervalTimer = setInterval(() => {
      this.processPendingSyncs().catch(err => {
        console.error('Error during scheduled pending sync processing:', err);
      });
    }, TEN_MINUTES_MS);
  }

  public stopRetryTimer(): void {
    if (this.retryIntervalTimer) {
      clearInterval(this.retryIntervalTimer);
      this.retryIntervalTimer = null;
      console.log('[dev] supabase_worker: Stopped retry timer.');
    }
  }

  /**
   * Boot-time recovery: If local SQLite has 0 leads, fetch lead_backups from Supabase and restore them.
   */
  public async performStartupRecovery(): Promise<number> {
    const localCount = countLocalLeads();
    if (localCount > 0) {
      console.log(`[dev] startup_recovery: Local SQLite contains ${localCount} leads. Recovery skipped.`);
      return 0;
    }

    if (!this.client) this.initClient();
    if (!this.client) {
      console.warn('[dev] startup_recovery: Supabase client unavailable. Recovery skipped.');
      return 0;
    }

    try {
      console.log('[dev] startup_recovery: Local DB empty. Fetching backups from Supabase lead_backups...');
      const { data, error } = await this.client
        .from('lead_backups')
        .select('*')
        .order('created_at', { ascending: true });

      if (error) throw error;
      if (!data || data.length === 0) {
        console.log('[dev] startup_recovery: No lead backups found in Supabase.');
        return 0;
      }

      let restoredCount = 0;
      for (const row of data) {
        restoreLeadFromSupabaseBackup({
          channel_id: row.channel_id,
          lead_identity: row.lead_identity,
          whatsapp_jid: row.whatsapp_jid,
          whatsapp_phone: row.whatsapp_phone,
          customer_name: row.customer_name,
          status: row.status,
          latest_message: row.latest_message,
          first_activity_at: row.first_activity_at,
          last_activity_at: row.last_activity_at,
          qualification_reason: row.qualification_reason,
          confidence: row.confidence,
          conversation_summary: row.conversation_summary,
          extracted_answers: row.extracted_answers,
          google_sheet_row_number: row.google_sheet_row_number,
          created_at: row.created_at,
          updated_at: row.updated_at
        });
        restoredCount++;
      }

      console.log(`[dev] startup_recovery: Successfully restored ${restoredCount} leads from Supabase into local SQLite.`);
      return restoredCount;
    } catch (err) {
      console.error('[dev] startup_recovery_failed:', err instanceof Error ? err.message : err);
      return 0;
    }
  }

  /**
   * Immediately mirror a channel (new creation or update) to Supabase channels table
   */
  public async syncChannel(channel: { id: string; name: string; status?: string; created_at?: string }): Promise<boolean> {
    if (!channel || !channel.id) return false;
    if (!this.client) this.initClient();
    if (!this.client) return false;

    try {
      const now = new Date().toISOString();
      const { error } = await this.client
        .from('channels')
        .upsert({
          id: channel.id,
          name: channel.name,
          status: channel.status || 'active',
          updated_at: now
        }, { onConflict: 'id' });

      if (error) {
        console.error(`[dev] supabase_channel_sync_error for ${channel.id}:`, error.message);
        return false;
      }
      return true;
    } catch (err) {
      console.error(`[dev] supabase_channel_sync_exception for ${channel.id}:`, err);
      return false;
    }
  }

  /**
   * Delete a channel from Supabase channels table
   */
  public async deleteChannel(channelId: string): Promise<boolean> {
    if (!channelId) return false;
    if (!this.client) this.initClient();
    if (!this.client) return false;

    try {
      const { error } = await this.client
        .from('channels')
        .delete()
        .eq('id', channelId);

      if (error) {
        console.error(`[dev] supabase_channel_delete_error for ${channelId}:`, error.message);
        return false;
      }
      return true;
    } catch (err) {
      console.error(`[dev] supabase_channel_delete_exception for ${channelId}:`, err);
      return false;
    }
  }

  /**
   * Restore all channels from Supabase channels table into local SQLite
   */
  public async restoreChannelsFromBackup(): Promise<number> {
    if (!this.client) this.initClient();
    if (!this.client) return 0;

    try {
      const { data, error } = await this.client
        .from('channels')
        .select('*')
        .order('created_at', { ascending: true });

      if (error) throw error;
      if (!data || data.length === 0) return 0;

      let count = 0;
      for (const ch of data) {
        restoreChannelFromSupabaseBackup({
          id: ch.id,
          name: ch.name,
          status: ch.status,
          created_at: ch.created_at
        });
        count++;
      }
      console.log(`[dev] startup_recovery: Restored ${count} channels from Supabase into local SQLite.`);
      return count;
    } catch (err) {
      console.error('[dev] startup_channels_recovery_failed:', err instanceof Error ? err.message : err);
      return 0;
    }
  }

  /**
   * Save complete encrypted WhatsApp credentials bundle to Supabase whatsapp_connections table (1 row per channel)
   */
  public async saveWhatsAppSession(
    sessionBundle: Record<string, string>,
    metadata: { phoneNumber?: string | null; jid?: string | null; connectionStatus?: string } = {},
    channelId: string
  ): Promise<void> {
    if (!channelId) return;
    if (!this.client) this.initClient();
    if (!this.client) return;

    const key = channelId;

    try {
      const { encryptSecret } = await import('../utils/crypto.js');
      const payloadString = JSON.stringify(sessionBundle);
      const encrypted = encryptSecret(payloadString);

      const record: Record<string, any> = {
        connection_key: key,
        channel_id: key,
        encrypted_session_data: encrypted,
        updated_at: new Date().toISOString()
      };

      if (metadata.phoneNumber !== undefined) record.phone_number = metadata.phoneNumber;
      if (metadata.jid !== undefined) record.jid = metadata.jid;
      if (metadata.connectionStatus !== undefined) record.connection_status = metadata.connectionStatus;
      if (metadata.connectionStatus === 'connected') record.last_connected_at = new Date().toISOString();

      await this.client
        .from('whatsapp_connections')
        .upsert(record, { onConflict: 'connection_key' });
    } catch (err) {
      console.warn(`[dev] whatsapp_session_backup_failed for channel ${key}:`, err instanceof Error ? err.message : err);
    }
  }

  /**
   * Restore WhatsApp session files from single-row cloud backup into local auth directory on startup for a channel
   */
  public async restoreWhatsAppSession(authDir: string, channelId: string): Promise<boolean> {
    if (!channelId) return false;
    if (!this.client) this.initClient();
    if (!this.client) return false;

    const key = channelId;

    try {
      const { data, error } = await this.client
        .from('whatsapp_connections')
        .select('*')
        .eq('connection_key', key)
        .maybeSingle();

      if (error) throw error;
      if (!data || !data.encrypted_session_data) return false;

      const fs = await import('fs');
      const path = await import('path');
      const { decryptSecret } = await import('../utils/crypto.js');

      const decrypted = decryptSecret(data.encrypted_session_data);
      if (!decrypted) return false;

      const sessionBundle = JSON.parse(decrypted) as Record<string, string>;
      if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
      }

      let restoredCount = 0;
      for (const [fileName, fileContent] of Object.entries(sessionBundle)) {
        if (fileName && fileContent && !fileName.startsWith('lid-mapping-')) {
          const filePath = path.join(authDir, fileName);
          fs.writeFileSync(filePath, fileContent, 'utf8');
          restoredCount++;
        }
      }

      if (restoredCount > 0) {
        console.log(`[dev] whatsapp_session_restored: Restored ${restoredCount} session files for channel "${key}" from Supabase credentials backup.`);
        return true;
      }
      return false;
    } catch (err) {
      console.error(`[dev] whatsapp_session_restore_failed for channel ${key}:`, err instanceof Error ? err.message : err);
      return false;
    }
  }

  /**
   * Clear WhatsApp session credentials from Supabase when user logs out / resets session for a channel
   */
  public async clearWhatsAppConnection(channelId: string): Promise<void> {
    if (!channelId) return;
    const key = channelId;
    if (!this.client) this.initClient();
    if (!this.client) return;

    try {
      await this.client
        .from('whatsapp_connections')
        .update({
          encrypted_session_data: null,
          connection_status: 'disconnected',
          phone_number: null,
          jid: null,
          updated_at: new Date().toISOString()
        })
        .eq('connection_key', key);
      console.log(`[dev] whatsapp_connection_cleared for channel "${key}" from Supabase.`);
    } catch (err) {
      console.warn(`[dev] whatsapp_clear_failed for channel ${key}:`, err instanceof Error ? err.message : err);
    }
  }

  /**
   * Return safe internal health details (without exposing secret keys)
   */
  public getHealth(): SupabaseHealth {
    return {
      connected: !!this.client && !this.lastError,
      lastSyncTime: this.lastSyncTime,
      pendingSyncCount: getPendingSyncCount(),
      lastError: this.lastError
    };
  }
}

export const supabaseService = new SupabaseService();
