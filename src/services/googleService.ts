import { google } from 'googleapis';
import crypto from 'node:crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { encryptSecret, decryptSecret } from '../utils/crypto.js';
import {
  Lead,
  updateLeadSheetRowNumber,
  enqueuePendingSheetSync,
  removePendingSheetSync,
  getPendingSheetSyncs
} from '../db/index.js';

export const REQUIRED_SHEET_HEADERS = [
  'CREATED AT',
  'UPDATED AT',
  'NAME',
  'WHATSAPP NUMBER',
  'STATUS',
  'FIRM/COMPANY',
  'CP/DEVELOPER',
  'LOCATION',
  'REQUIREMENT',
  'BUDGET',
  'SUMMARY'
];

export interface GoogleConnectionConfig {
  connection_key: string;
  channel_id?: string | null;
  encrypted_refresh_token?: string | null;
  google_email?: string | null;
  spreadsheet_id?: string | null;
  spreadsheet_name?: string | null;
  sheet_tab_name?: string | null;
  connection_status: string;
}

class GoogleService {
  private supabase: SupabaseClient | null = null;
  private stateTokens: Map<string, { expiresAt: number; channelId: string }> = new Map();
  private retryIntervalTimer: NodeJS.Timeout | null = null;
  /** Cache: channelId (or connection_key) → GoogleConnectionConfig */
  private connectionCache: Map<string, { config: GoogleConnectionConfig; expiresAt: number }> = new Map();
  /** Cache: spreadsheetId → numeric sheetId (avoids an extra API call per lead sync) */
  private sheetIdCache: Map<string, number> = new Map();

  constructor() {
    this.initSupabase();
  }

  private initSupabase(): void {
    const supabaseUrl = process.env.SUPABASE_URL || '';
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (supabaseUrl && serviceRoleKey) {
      try {
        this.supabase = createClient(supabaseUrl, serviceRoleKey, {
          auth: { persistSession: false }
        });
      } catch (err) {
        console.error('Failed to initialize Supabase client in GoogleService:', err);
      }
    }
  }

  public getOAuth2Client() {
    const clientId = process.env.GOOGLE_CLIENT_ID || '';
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/oauth/google/callback';

    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  }

  /**
   * Generate state token to prevent CSRF attacks and associate with channelId
   */
  public generateStateToken(channelId: string): string {
    const state = crypto.randomBytes(24).toString('hex');
    // Save state in memory for 15 minutes along with target channelId
    this.stateTokens.set(state, {
      expiresAt: Date.now() + 15 * 60 * 1000,
      channelId: channelId
    });
    return state;
  }

  /**
   * Validate state token and return associated channelId
   */
  public validateStateToken(stateToken: string | undefined): { valid: boolean; channelId?: string } {
    if (!stateToken) return { valid: false };
    const entry = this.stateTokens.get(stateToken);
    if (!entry) return { valid: false };
    this.stateTokens.delete(stateToken);
    if (Date.now() > entry.expiresAt) return { valid: false };
    return { valid: true, channelId: entry.channelId };
  }

  /**
   * Handle OAuth2 Callback, exchange code for tokens, save to Supabase per channel
   */
  public async handleOAuthCallback(code: string, channelId: string): Promise<{ email: string; success: boolean }> {
    const oauth2Client = this.getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    if (!tokens.refresh_token) {
      throw new Error('No refresh token received from Google. Ensure prompt=consent and access_type=offline.');
    }

    const encryptedRefreshToken = encryptSecret(tokens.refresh_token);

    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const email = userInfo.data.email || '';

    // Save encrypted tokens & email to Supabase google_connections table
    await this.saveConnectionToSupabase({
      encrypted_refresh_token: encryptedRefreshToken,
      google_email: email,
      connection_status: 'connected'
    }, channelId);

    return { email, success: true };
  }

  /**
   * Generate Auth URL for Google Consent screen
   */
  public getAuthUrl(stateToken: string): string {
    const oauth2Client = this.getOAuth2Client();
    const scopes = [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/spreadsheets'
    ];

    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: scopes,
      state: stateToken
    });
  }

  /**
   * Get connection for a given channel from cache or Supabase
   */
  public async getConnection(forceRefresh: boolean = false, channelId?: string): Promise<GoogleConnectionConfig | null> {
    if (!channelId) return null;
    const key = channelId;
    const now = Date.now();
    const cached = this.connectionCache.get(key);

    if (!forceRefresh && cached && now < cached.expiresAt) {
      return cached.config;
    }

    if (!this.supabase) this.initSupabase();
    if (!this.supabase) {
      this.connectionCache.delete(key);
      return null;
    }

    try {
      const { data, error } = await this.supabase
        .from('google_connections')
        .select('*')
        .eq('connection_key', key)
        .maybeSingle();

      if (error || !data) {
        this.connectionCache.delete(key);
        return null;
      }

      const config = data as GoogleConnectionConfig;
      this.connectionCache.set(key, { config, expiresAt: now + 15 * 1000 }); // Cache for 15 seconds
      return config;
    } catch (err) {
      console.error(`Error fetching google_connections for channel ${key} from Supabase:`, err);
      this.connectionCache.delete(key);
      return null;
    }
  }

  /**
   * Save connection metadata for a given channel to Supabase and update local cache
   */
  public async saveConnectionToSupabase(payload: Partial<GoogleConnectionConfig>, channelId: string): Promise<void> {
    const key = channelId || payload.connection_key;
    if (!key) return;
    const current = (await this.getConnection(false, key)) || undefined;

    const merged: GoogleConnectionConfig = {
      connection_key: key,
      channel_id: key,
      encrypted_refresh_token: payload.encrypted_refresh_token !== undefined ? payload.encrypted_refresh_token : current?.encrypted_refresh_token,
      google_email: payload.google_email !== undefined ? payload.google_email : current?.google_email,
      spreadsheet_id: payload.spreadsheet_id !== undefined ? payload.spreadsheet_id : current?.spreadsheet_id,
      spreadsheet_name: payload.spreadsheet_name !== undefined ? payload.spreadsheet_name : current?.spreadsheet_name,
      sheet_tab_name: payload.sheet_tab_name !== undefined ? payload.sheet_tab_name : current?.sheet_tab_name,
      connection_status: payload.connection_status || current?.connection_status || 'connected'
    };

    // Update in-memory cache immediately
    this.connectionCache.set(key, { config: merged, expiresAt: Date.now() + 60 * 1000 });

    if (!this.supabase) this.initSupabase();
    if (!this.supabase) return;

    try {
      const { error } = await this.supabase
        .from('google_connections')
        .upsert({
          connection_key: key,
          channel_id: key,
          encrypted_refresh_token: merged.encrypted_refresh_token,
          google_email: merged.google_email,
          spreadsheet_id: merged.spreadsheet_id,
          spreadsheet_name: merged.spreadsheet_name,
          sheet_tab_name: merged.sheet_tab_name,
          connection_status: merged.connection_status,
          updated_at: new Date().toISOString()
        }, { onConflict: 'connection_key' });
      if (error) {
        console.error(`Failed to save google connection for channel ${key} to Supabase:`, error.message);
      } else {
        console.log(`[GoogleService] Successfully saved Google connection for channel "${key}" to Supabase.`);
      }
    } catch (err) {
      console.error(`Failed to save google connection for channel ${key} to Supabase:`, err);
    }
  }

  /**
   * Get authenticated Google Sheets API client for a specific channel
   */
  public async getSheetsClient(channelId: string) {
    const conn = await this.getConnection(false, channelId);
    if (!conn || !conn.encrypted_refresh_token) {
      throw new Error(`Google account is not connected for channel: ${channelId}`);
    }

    const refreshToken = decryptSecret(conn.encrypted_refresh_token);
    if (!refreshToken) {
      throw new Error(`Failed to decrypt Google refresh token for channel: ${channelId}`);
    }

    const oauth2Client = this.getOAuth2Client();
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    return google.sheets({ version: 'v4', auth: oauth2Client });
  }

  /**
   * Get authenticated Google Drive API client for a specific channel
   */
  public async getDriveClient(channelId: string) {
    const conn = await this.getConnection(false, channelId);
    if (!conn || !conn.encrypted_refresh_token) {
      throw new Error(`Google account is not connected for channel: ${channelId}`);
    }

    const refreshToken = decryptSecret(conn.encrypted_refresh_token);
    if (!refreshToken) {
      throw new Error(`Failed to decrypt Google refresh token for channel: ${channelId}`);
    }

    const oauth2Client = this.getOAuth2Client();
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    return google.drive({ version: 'v3', auth: oauth2Client });
  }

  /**
   * Create new spreadsheet "WhatsApp Leads" with required headers for a specific channel
   */
  public async createNewSpreadsheet(channelId: string): Promise<{ spreadsheetId: string; spreadsheetName: string; tabName: string }> {
    const sheets = await this.getSheetsClient(channelId);
    const spreadsheetName = 'WhatsApp Leads';
    const tabName = 'Leads';

    const createRes = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title: spreadsheetName },
        sheets: [
          {
            properties: { title: tabName }
          }
        ]
      }
    });

    const spreadsheetId = createRes.data.spreadsheetId;
    if (!spreadsheetId) {
      throw new Error('Failed to create Google Spreadsheet');
    }

    // Append required header row
    await sheets.spreadsheets.values.update({
      spreadsheetId: spreadsheetId,
      range: `'${tabName}'!A1:K1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [REQUIRED_SHEET_HEADERS]
      }
    });

    // Save connection info for this channel
    await this.saveConnectionToSupabase({
      spreadsheet_id: spreadsheetId,
      spreadsheet_name: spreadsheetName,
      sheet_tab_name: tabName,
      connection_status: 'connected'
    }, channelId);

    return { spreadsheetId, spreadsheetName, tabName };
  }

  /**
   * Select existing spreadsheet and tab for a specific channel
   */
  public async selectExistingSpreadsheet(spreadsheetId: string, spreadsheetName: string, tabName: string, channelId: string): Promise<void> {
    const sheets = await this.getSheetsClient(channelId);

    // Verify or create header row if sheet is empty
    try {
      const getRes = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${tabName}'!A1:K1`
      });

      if (!getRes.data.values || getRes.data.values.length === 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `'${tabName}'!A1:K1`,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [REQUIRED_SHEET_HEADERS]
          }
        });
      }
    } catch {
      // If range doesn't exist or tab error, write header
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `'${tabName}'!A1:K1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [REQUIRED_SHEET_HEADERS]
        }
      });
    }

    await this.saveConnectionToSupabase({
      spreadsheet_id: spreadsheetId,
      spreadsheet_name: spreadsheetName,
      sheet_tab_name: tabName,
      connection_status: 'connected'
    }, channelId);
  }

  /**
   * List editable spreadsheets via Google Drive API
   */
  public async listUserSpreadsheets(channelId: string): Promise<Array<{ id: string; name: string }>> {
    try {
      const drive = await this.getDriveClient(channelId);
      const res = await drive.files.list({
        q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
        fields: 'files(id, name)',
        pageSize: 20
      });
      return (res.data.files || []).map(f => ({ id: f.id || '', name: f.name || 'Untitled Sheet' }));
    } catch (err) {
      console.error('Failed to list user spreadsheets:', err);
      return [];
    }
  }

  /**
   * List worksheet tabs in a spreadsheet
   */
  public async listWorksheetTabs(spreadsheetId: string, channelId: string): Promise<string[]> {
    try {
      const sheets = await this.getSheetsClient(channelId);
      const res = await sheets.spreadsheets.get({ spreadsheetId });
      return (res.data.sheets || []).map(s => s.properties?.title || 'Sheet1');
    } catch (err) {
      console.error('Failed to list worksheet tabs:', err);
      return ['Leads'];
    }
  }

  /**
   * Append or Update a lead's row in Google Sheets (routed via lead.channel_id)
   */
  public async syncLeadToSheet(lead: Lead): Promise<boolean> {
    if (!lead) return false;

    const channelId = lead.channel_id;
    if (!channelId) return false;
    const conn = await this.getConnection(false, channelId);
    if (!conn || conn.connection_status !== 'connected' || !conn.spreadsheet_id) {
      return false;
    }

    const spreadsheetId = conn.spreadsheet_id;
    const tabName = conn.sheet_tab_name || 'Leads';

    try {
      const sheets = await this.getSheetsClient(channelId);

      // Format row values according to REQUIRED_SHEET_HEADERS
      // Convert ISO date strings to Google Sheets Date Serial numbers
      const toSheetDateSerial = (dateStr?: string | null): number | string => {
        if (!dateStr) return '';
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;
        // Excel/Google Sheets date serial origin is Dec 30 1899
        return (d.getTime() - new Date('1899-12-30T00:00:00Z').getTime()) / 86400000;
      };

      // Helper to return 'unknown' if value is empty/null/undefined
      const fillOrUnknown = (val?: string | number | null): string | number => {
        if (val === null || val === undefined) return 'unknown';
        const str = String(val).trim();
        return str === '' ? 'unknown' : val;
      };

      const createdAtVal = lead.created_at ? toSheetDateSerial(lead.created_at) : 'unknown';
      const updatedAtVal = lead.updated_at ? toSheetDateSerial(lead.updated_at) : 'unknown';
      const nameStr = fillOrUnknown(lead.customer_name);

      // Rule: Never write raw LID to WhatsApp Number column; if phone unavailable leave 'unknown'
      const phoneStr = (lead.whatsapp_phone && !lead.whatsapp_phone.includes('@lid')) ? lead.whatsapp_phone : 'unknown';
      const statusStr = fillOrUnknown(lead.status || 'analyzing');

      // Parse extracted answers JSON if present
      let answers: Record<string, string | null> = {};
      if (lead.extracted_answers) {
        try {
          answers = typeof lead.extracted_answers === 'string'
            ? JSON.parse(lead.extracted_answers)
            : (lead.extracted_answers || {});
        } catch {
          answers = {};
        }
      }

      const summaryStr = fillOrUnknown(lead.conversation_summary);
      const firmCompanyStr = fillOrUnknown(answers.firm_company);
      const cpDeveloperStr = fillOrUnknown(answers.cp_developer);
      const locationStr = fillOrUnknown(answers.location);
      const requirementStr = fillOrUnknown(answers.requirement);

      let budgetStr = answers.budget || '';
      if (budgetStr) {
        budgetStr = budgetStr.replace(/\$/g, '₹');
      }
      const finalBudgetVal = fillOrUnknown(budgetStr);

      const rowValues = [
        createdAtVal,    // Created At (Date Serial)
        updatedAtVal,    // Updated At (Date Serial)
        nameStr,         // Name
        phoneStr,        // WhatsApp Number
        statusStr,       // Status
        firmCompanyStr,  // Firm/Company
        cpDeveloperStr,  // cp/developer
        locationStr,     // Location
        requirementStr,  // Requirement
        finalBudgetVal,  // Budget
        summaryStr       // Summary
      ];

      // Check if lead already has a row number
      let rowNumber = lead.google_sheet_row_number;

      if (!rowNumber) {
        // Append row
        const appendRes = await sheets.spreadsheets.values.append({
          spreadsheetId,
          range: `'${tabName}'!A:K`,
          valueInputOption: 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          requestBody: {
            values: [rowValues]
          }
        });

        // Extract updated row index from updatedRange (e.g. "'Leads'!A5:K5")
        const updatedRange = appendRes.data.updates?.updatedRange || '';
        const match = updatedRange.match(/!A(\d+):/);
        if (match && match[1]) {
          rowNumber = parseInt(match[1], 10);
          updateLeadSheetRowNumber(lead.id, rowNumber);
          console.log(`[dev] google_sheet_appended: Lead #${lead.id} written to row ${rowNumber}`);
        }
      } else {
        // Update existing row
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `'${tabName}'!A${rowNumber}:K${rowNumber}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [rowValues]
          }
        });
        console.log(`[dev] google_sheet_updated: Lead #${lead.id} updated at row ${rowNumber}`);
      }

      // Apply Formatting & Validation to the Sheet
      if (rowNumber) {
        try {
          // Resolve numeric sheetId from cache; only call spreadsheets.get() on first use per spreadsheet
          let sheetId = this.sheetIdCache.get(spreadsheetId);
          if (sheetId === undefined) {
            const sheetInfo = await sheets.spreadsheets.get({ spreadsheetId });
            const sheetObj = sheetInfo.data.sheets?.find(s => s.properties?.title === tabName);
            sheetId = sheetObj?.properties?.sheetId ?? 0;
            this.sheetIdCache.set(spreadsheetId, sheetId);
          }

          // Determine row background color based on status
          // interested -> Soft Green (#d1fae5 / rgb 0.82, 0.98, 0.90)
          // undecided -> Soft Yellow (#fef3c7 / rgb 0.99, 0.95, 0.78)
          // not_interested -> Soft Red (#fee2e2 / rgb 0.99, 0.88, 0.88)
          // default (analyzing) -> Light Gray (#f4f4f5 / rgb 0.95, 0.95, 0.96)
          let bgColor = { red: 0.95, green: 0.95, blue: 0.96 };
          const s = String(statusStr).toLowerCase();
          if (s === 'interested') {
            bgColor = { red: 0.82, green: 0.98, blue: 0.90 };
          } else if (s === 'undecided') {
            bgColor = { red: 0.99, green: 0.95, blue: 0.78 };
          } else if (s === 'not_interested') {
            bgColor = { red: 0.99, green: 0.88, blue: 0.88 };
          }

          const requests: any[] = [
            // 1. Header row formatting: UPPERCASE, BOLD, Dark Header Background
            {
              repeatCell: {
                range: {
                  sheetId: sheetId,
                  startRowIndex: 0,
                  endRowIndex: 1,
                  startColumnIndex: 0,
                  endColumnIndex: 11
                },
                cell: {
                  userEnteredFormat: {
                    backgroundColor: { red: 0.1, green: 0.1, blue: 0.11 },
                    textFormat: { bold: true, fontSize: 10, foregroundColor: { red: 1, green: 1, blue: 1 } },
                    horizontalAlignment: 'LEFT',
                    verticalAlignment: 'MIDDLE'
                  }
                },
                fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)'
              }
            },
            // 2. Format row background color according to lead status
            {
              repeatCell: {
                range: {
                  sheetId: sheetId,
                  startRowIndex: rowNumber - 1,
                  endRowIndex: rowNumber,
                  startColumnIndex: 0,
                  endColumnIndex: 11
                },
                cell: {
                  userEnteredFormat: {
                    backgroundColor: bgColor
                  }
                },
                fields: 'userEnteredFormat.backgroundColor'
              }
            },
            // 3. Format Date/Time for columns A & B
            {
              repeatCell: {
                range: {
                  sheetId: sheetId,
                  startRowIndex: rowNumber - 1,
                  endRowIndex: rowNumber,
                  startColumnIndex: 0,
                  endColumnIndex: 2
                },
                cell: {
                  userEnteredFormat: {
                    numberFormat: {
                      type: 'DATE_TIME',
                      pattern: 'yyyy-mm-dd hh:mm:ss'
                    }
                  }
                },
                fields: 'userEnteredFormat.numberFormat'
              }
            },
            // 4. Dropdown Data Validation for Column E (Status: interested, undecided, not_interested, analyzing)
            {
              setDataValidation: {
                range: {
                  sheetId: sheetId,
                  startRowIndex: 1,
                  endRowIndex: 1000,
                  startColumnIndex: 4,
                  endColumnIndex: 5
                },
                rule: {
                  condition: {
                    type: 'ONE_OF_LIST',
                    values: [
                      { userEnteredValue: 'interested' },
                      { userEnteredValue: 'undecided' },
                      { userEnteredValue: 'not_interested' },
                      { userEnteredValue: 'analyzing' }
                    ]
                  },
                  showCustomUi: true,
                  strict: false
                }
              }
            },
            // 5. Dropdown Data Validation for Column G (CP/Developer: Channel Partner (CP), Developer, Direct Buyer, unknown)
            {
              setDataValidation: {
                range: {
                  sheetId: sheetId,
                  startRowIndex: 1,
                  endRowIndex: 1000,
                  startColumnIndex: 6,
                  endColumnIndex: 7
                },
                rule: {
                  condition: {
                    type: 'ONE_OF_LIST',
                    values: [
                      { userEnteredValue: 'Channel Partner (CP)' },
                      { userEnteredValue: 'Developer' },
                      { userEnteredValue: 'Direct Buyer' },
                      { userEnteredValue: 'unknown' }
                    ]
                  },
                  showCustomUi: true,
                  strict: false
                }
              }
            }
          ];

          await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: { requests }
          });
        } catch (fmtErr) {
          console.warn('[dev] google_sheet_format_warning:', fmtErr);
        }
      }

        removePendingSheetSync(lead.id);
        return true;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[dev] google_sheet_sync_failed: Lead #${lead.id} queued for retry (${errorMsg})`);
        enqueuePendingSheetSync(lead.id, errorMsg);
        return false;
      }
    }

  /**
   * Read all rows from Google Sheet and reverse sync edits (status, phone, name, fields) back to local DB
   */
  public async syncFromSheetToDb(channelId?: string): Promise<void> {
    try {
      const { getAllChannelsWithStats, getAllLeads, updateLeadFromGoogleSheet } = await import('../db/index.js');
      const channelsToSync = channelId ? [channelId] : getAllChannelsWithStats().map(c => c.id);

      for (const chId of channelsToSync) {
        const conn = await this.getConnection(false, chId);
        if (!conn || !conn.spreadsheet_id || conn.connection_status !== 'connected' || !conn.encrypted_refresh_token) {
          continue;
        }

        const spreadsheetId = conn.spreadsheet_id;
        const tabName = conn.sheet_tab_name || 'Leads';
        const sheets = await this.getSheetsClient(chId);

        const res = await sheets.spreadsheets.values.get({
          spreadsheetId,
          range: `'${tabName}'!A2:K1000`
        });

        const rows = res.data.values;
        if (!rows || rows.length === 0) continue;

        const allLeads = getAllLeads();

        rows.forEach((row, idx) => {
          const rowNumber = idx + 2; // Rows start at 2 (after headers)
          if (!row || row.length === 0) return;

          // Match lead by row number or WhatsApp Number
          const phone = row[3] ? String(row[3]).trim() : '';
          const name = row[2] ? String(row[2]).trim() : '';
          const status = row[4] ? String(row[4]).trim() : '';
          const firmCompany = row[5] ? String(row[5]).trim() : '';
          const cpDeveloper = row[6] ? String(row[6]).trim() : '';
          const location = row[7] ? String(row[7]).trim() : '';
          const requirement = row[8] ? String(row[8]).trim() : '';
          const budget = row[9] ? String(row[9]).trim() : '';
          const summary = row[10] ? String(row[10]).trim() : '';

          const targetLead = allLeads.find(l => (l.channel_id === chId || !l.channel_id) && l.google_sheet_row_number === rowNumber) ||
                             allLeads.find(l => (l.channel_id === chId || !l.channel_id) && phone && l.whatsapp_phone && l.whatsapp_phone.replace(/\D/g, '') === phone.replace(/\D/g, ''));

          if (targetLead) {
            // Check if any value actually changed before writing
            let existingAnswers: Record<string, string | null> = {};
            if (targetLead.extracted_answers) {
              try {
                existingAnswers = typeof targetLead.extracted_answers === 'string'
                  ? JSON.parse(targetLead.extracted_answers)
                  : (targetLead.extracted_answers || {});
              } catch {}
            }

            const normStr = (s?: string | null) => {
              if (!s) return '';
              const trimmed = String(s).trim();
              return (trimmed.toLowerCase() === 'unknown' || trimmed === '-') ? '' : trimmed;
            };

            const normPhone = (s?: string | null) => {
              if (!s) return '';
              return String(s).replace(/\D/g, '');
            };

            const currentStatus = (targetLead.status || '').trim().toLowerCase();
            const sheetStatus = (status || '').trim().toLowerCase();
            const validStatuses = ['analyzing', 'interested', 'not_interested', 'undecided'];
            const hasStatusChanged = !!(sheetStatus && validStatuses.includes(sheetStatus) && sheetStatus !== currentStatus);

            const hasNameChanged = !!(normStr(name) && normStr(name) !== normStr(targetLead.customer_name));
            const hasPhoneChanged = !!(normPhone(phone) && normPhone(phone) !== normPhone(targetLead.whatsapp_phone));
            const hasFirmChanged = !!(normStr(firmCompany) && normStr(firmCompany) !== normStr(existingAnswers.firm_company));
            const hasCpDevChanged = !!(normStr(cpDeveloper) && normStr(cpDeveloper) !== normStr(existingAnswers.cp_developer));
            const hasLocChanged = !!(normStr(location) && normStr(location) !== normStr(existingAnswers.location));
            const hasReqChanged = !!(normStr(requirement) && normStr(requirement) !== normStr(existingAnswers.requirement));
            const hasBudgetChanged = !!(normStr(budget) && normStr(budget) !== normStr(existingAnswers.budget));
            const hasSummaryChanged = !!(normStr(summary) && normStr(summary) !== normStr(targetLead.conversation_summary));

            if (hasStatusChanged || hasNameChanged || hasPhoneChanged || hasFirmChanged || hasCpDevChanged || hasLocChanged || hasReqChanged || hasBudgetChanged || hasSummaryChanged) {
              updateLeadFromGoogleSheet({
                leadId: targetLead.id,
                name: hasNameChanged ? name : undefined,
                phone: hasPhoneChanged ? phone : undefined,
                status: hasStatusChanged ? status : undefined,
                firmCompany: hasFirmChanged ? firmCompany : undefined,
                cpDeveloper: hasCpDevChanged ? cpDeveloper : undefined,
                location: hasLocChanged ? location : undefined,
                requirement: hasReqChanged ? requirement : undefined,
                budget: hasBudgetChanged ? budget : undefined,
                summary: hasSummaryChanged ? summary : undefined
              });
            }
          }
        });
      }
    } catch (err) {
      console.warn('[dev] google_sheet_reverse_sync_failed:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Retry pending Google Sheet syncs (runs every 10 mins) and sync edits back
   */
  public async processPendingSheetSyncs(channelId?: string): Promise<void> {
    if (channelId) {
      const conn = await this.getConnection(false, channelId);
      if (!conn || conn.connection_status !== 'connected' || !conn.encrypted_refresh_token || !conn.spreadsheet_id) {
        return;
      }
    }

    const pending = getPendingSheetSyncs();
    if (pending.length > 0) {
      console.log(`[dev] google_sheet_retry_queue: Processing ${pending.length} pending sheet updates...`);
      for (const item of pending) {
        await this.syncLeadToSheet(item.lead);
      }
    }
    // Also pull edits from sheet back into local DB
    await this.syncFromSheetToDb();
  }

  /**
   * Start 60-second poll timer for real-time reverse sync from Google Sheets
   */
  public startRetryTimer(): void {
    if (this.retryIntervalTimer) return;
    console.log('[dev] google_sheet_worker: Started 60-second polling timer for real-time sheet sync.');
    const SIXTY_SECONDS_MS = 60 * 1000;
    this.retryIntervalTimer = setInterval(() => {
      this.processPendingSheetSyncs().catch(err => {
        console.error('Error during scheduled Google Sheet pending sync processing:', err);
      });
    }, SIXTY_SECONDS_MS);
  }

  public stopRetryTimer(): void {
    if (this.retryIntervalTimer) {
      clearInterval(this.retryIntervalTimer);
      this.retryIntervalTimer = null;
      console.log('[dev] google_sheet_worker: Stopped retry timer.');
    }
  }

  /**
   * Disconnect Google account for a specific channel (removes encrypted refresh token from Supabase)
   */
  public async disconnectGoogle(channelId: string): Promise<void> {
    if (!channelId) return;
    const key = channelId;
    if (!this.supabase) this.initSupabase();
    if (this.supabase) {
      await this.supabase
        .from('google_connections')
        .update({
          encrypted_refresh_token: null,
          connection_status: 'disconnected',
          updated_at: new Date().toISOString()
        })
        .eq('connection_key', key);
    }

    this.connectionCache.delete(key);
  }
}

export const googleService = new GoogleService();
