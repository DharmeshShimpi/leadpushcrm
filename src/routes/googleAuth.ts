import { Router, Request, Response } from 'express';
import { googleService } from '../services/googleService.js';
import { requireSecretPath } from './dashboard.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// GET /oauth/google/connect - Initiate OAuth login
router.get('/oauth/google/connect', requireAuth, (req: Request, res: Response) => {
  try {
    const channelId = req.user?.channel_id;
    if (!channelId) {
      res.status(400).send('No channel assigned to account.');
      return;
    }
    const stateToken = googleService.generateStateToken(channelId);
    const authUrl = googleService.getAuthUrl(stateToken);
    res.redirect(authUrl);
  } catch (err) {
    console.error('Failed to initiate Google OAuth flow:', err);
    res.status(500).send('Google OAuth Configuration Error. Please check GOOGLE_CLIENT_ID & GOOGLE_CLIENT_SECRET.');
  }
});

// GET /oauth/google/callback - Public OAuth Callback route
router.get('/oauth/google/callback', async (req: Request, res: Response) => {
  const { code, state } = req.query;

  // Validate CSRF state token and retrieve target channelId
  const tokenInfo = googleService.validateStateToken(typeof state === 'string' ? state : undefined);
  if (!tokenInfo.valid || !tokenInfo.channelId) {
    res.status(400).send('OAuth State Validation Failed (Possible CSRF attack or expired session). Please try again.');
    return;
  }

  if (!code || typeof code !== 'string') {
    res.status(400).send('Authorization code missing from callback.');
    return;
  }

  try {
    const appSecret = process.env.APP_SECRET_PATH;
    if (!appSecret) {
      res.status(500).send('Server misconfiguration: APP_SECRET_PATH is not set.');
      return;
    }

    const channelId = tokenInfo.channelId;
    await googleService.handleOAuthCallback(code, channelId);

    // Redirect user back to Onboarding Step 2
    res.redirect(`/app/${appSecret}/onboarding?step=2&google=success`);
  } catch (err) {
    console.error('Error handling Google OAuth callback:', err);
    res.status(500).send('Failed to exchange Google OAuth code. Please try again.');
  }
});

// POST /app/:secret/google/setup-sheet - Setup new or select existing spreadsheet
router.post('/app/:secret/google/setup-sheet', requireSecretPath, requireAuth, async (req: Request, res: Response) => {
  const { mode, spreadsheetId, spreadsheetName, tabName } = req.body;
  const isAjax = req.xhr || req.headers.accept?.includes('application/json') || req.headers['content-type']?.includes('application/json');
  const channelId = req.user?.channel_id;

  if (!channelId) {
    if (isAjax) {
      res.status(400).json({ ok: false, error: 'No channel assigned to account' });
    } else {
      res.status(400).send('No channel assigned to account');
    }
    return;
  }

  try {
    let createdSheetId = '';
    let sheetName = 'WhatsApp Leads';
    let sheetTab = 'Leads';

    if (mode === 'create_new' || !mode) {
      const result = await googleService.createNewSpreadsheet(channelId);
      createdSheetId = result.spreadsheetId;
      sheetName = result.spreadsheetName;
      sheetTab = result.tabName;
    } else if (mode === 'select_existing') {
      if (!spreadsheetId || !tabName) {
        if (isAjax) {
          res.status(400).json({ ok: false, error: 'Spreadsheet ID and Tab Name are required' });
        } else {
          res.status(400).send('Spreadsheet ID and Tab Name are required');
        }
        return;
      }
      sheetName = spreadsheetName || 'Selected Sheet';
      sheetTab = tabName;
      await googleService.selectExistingSpreadsheet(spreadsheetId, sheetName, sheetTab, channelId);
      createdSheetId = spreadsheetId;
    } else {
      if (isAjax) {
        res.status(400).json({ ok: false, error: 'Invalid mode' });
      } else {
        res.status(400).send('Invalid mode');
      }
      return;
    }

    if (isAjax) {
      res.json({
        ok: true,
        spreadsheetId: createdSheetId,
        spreadsheetName: sheetName,
        tabName: sheetTab,
        sheetUrl: `https://docs.google.com/spreadsheets/d/${createdSheetId}`,
        nextStepUrl: `/app/${req.params.secret}/onboarding?step=3`
      });
      return;
    }

    if (createdSheetId) {
      res.redirect(`https://docs.google.com/spreadsheets/d/${createdSheetId}`);
    } else {
      res.redirect(`/app/${req.params.secret}/onboarding?step=3`);
    }
  } catch (err) {
    console.error(`Failed to setup Google Sheet for channel ${channelId}:`, err);
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (isAjax) {
      res.status(500).json({ ok: false, error: errorMsg });
    } else {
      res.status(500).send(`Failed to create Google Sheet: ${errorMsg}`);
    }
  }
});

// GET /app/:secret/api/google/spreadsheets - List user spreadsheets
router.get('/app/:secret/api/google/spreadsheets', requireSecretPath, requireAuth, async (req: Request, res: Response) => {
  try {
    const channelId = req.user?.channel_id;
    if (!channelId) {
      res.status(400).json({ ok: false, error: 'No channel assigned to account' });
      return;
    }
    const files = await googleService.listUserSpreadsheets(channelId);
    res.json({ ok: true, files });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /app/:secret/api/google/tabs - List tabs for a spreadsheet
router.get('/app/:secret/api/google/tabs', requireSecretPath, requireAuth, async (req: Request, res: Response) => {
  const spreadsheetId = req.query.spreadsheetId as string;
  if (!spreadsheetId) {
    res.status(400).json({ ok: false, error: 'spreadsheetId required' });
    return;
  }

  try {
    const channelId = req.user?.channel_id;
    if (!channelId) {
      res.status(400).json({ ok: false, error: 'No channel assigned to account' });
      return;
    }
    const tabs = await googleService.listWorksheetTabs(spreadsheetId, channelId);
    res.json({ ok: true, tabs });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// POST /app/:secret/google/disconnect - Disconnect Google Account
router.post('/app/:secret/google/disconnect', requireSecretPath, requireAuth, async (req: Request, res: Response) => {
  try {
    const channelId = req.user?.channel_id;
    if (!channelId) {
      res.status(400).json({ ok: false, error: 'No channel assigned to account' });
      return;
    }
    await googleService.disconnectGoogle(channelId);
    res.json({ ok: true, redirectUrl: `/app/${req.params.secret}/onboarding` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /app/:secret/api/google/status - Check Google connection & sheet status
router.get('/app/:secret/api/google/status', requireSecretPath, requireAuth, async (req: Request, res: Response) => {
  try {
    const channelId = req.user?.channel_id;
    if (!channelId) {
      res.status(400).json({ ok: false, error: 'No channel assigned to account' });
      return;
    }
    const googleConn = await googleService.getConnection(true, channelId);
    const isGoogleAccountConnected = !!googleConn && googleConn.connection_status === 'connected' && !!googleConn.encrypted_refresh_token;
    const isSheetConfigured = isGoogleAccountConnected && !!googleConn.spreadsheet_id;

    res.json({
      ok: true,
      googleSheetsConnected: isSheetConfigured,
      isAccountConnected: isGoogleAccountConnected,
      spreadsheetId: isSheetConfigured ? googleConn.spreadsheet_id : null,
      spreadsheetName: isSheetConfigured ? googleConn.spreadsheet_name : null
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
