import { Router, Request, Response } from 'express';
import { authService } from '../services/authService.js';
import { setSessionCookie, clearSessionCookie } from '../middleware/auth.js';
import { whatsAppService } from '../services/whatsappService.js';
import { googleService } from '../services/googleService.js';

const router = Router();

/**
 * Check if the given channel is fully onboarded (WhatsApp connected + Google Sheet configured)
 */
export async function isChannelSetupComplete(channelId?: string | null): Promise<boolean> {
  if (!channelId) return false;
  const waStatus = whatsAppService.getStatus(channelId);
  const hasCreds = whatsAppService.hasCredentials(channelId);
  const isWhatsAppConnected = waStatus.state === 'connected' || hasCreds;

  // Auto-start WhatsApp session in background if credentials exist but session not running
  if (hasCreds && waStatus.state === 'not_connected') {
    whatsAppService.initialize(channelId).catch(() => {});
  }

  const googleConn = await googleService.getConnection(false, channelId);
  const isSheetConfigured = !!googleConn && googleConn.connection_status === 'connected' && !!googleConn.spreadsheet_id;
  return isWhatsAppConnected && isSheetConfigured;
}

// GET /login - Render login page
router.get('/login', async (req: Request, res: Response) => {
  // If already authenticated with a valid database user, redirect to appropriate dashboard/onboarding
  const token = req.cookies?.lp_session;
  if (token) {
    const payload = authService.verifySessionToken(token);
    if (payload) {
      const dbUser = await authService.getUserById(payload.user_id);
      if (dbUser && dbUser.status === 'active') {
        if (dbUser.role === 'admin') {
          res.redirect('/admin/dashboard');
          return;
        } else if (dbUser.channel_id) {
          const secret = process.env.APP_SECRET_PATH || '';
          const isComplete = await isChannelSetupComplete(dbUser.channel_id);
          if (isComplete) {
            res.redirect(`/app/${secret}`);
          } else {
            res.redirect(`/app/${secret}/onboarding`);
          }
          return;
        }
      } else {
        res.clearCookie('lp_session', { path: '/' });
      }
    } else {
      res.clearCookie('lp_session', { path: '/' });
    }
  }

  const error = req.query.error as string || null;
  res.render('login', {
    appTitle: 'LeadPush',
    error: error
  });
});

// POST /login - Authenticate user
router.post('/login', async (req: Request, res: Response) => {
  const identifier = req.body.identifier || req.body.username || req.body.phone;
  const password = req.body.password;

  if (!identifier || !password) {
    res.redirect('/login?error=missing_fields');
    return;
  }

  try {
    const user = await authService.authenticateUser(identifier, password);
    if (!user) {
      res.redirect('/login?error=invalid_credentials');
      return;
    }

    const token = authService.createSessionToken(user);
    setSessionCookie(res, token);

    if (user.role === 'admin') {
      res.redirect('/admin/dashboard');
    } else {
      const secret = process.env.APP_SECRET_PATH || '';
      const channelId = user.channel_id;
      const isComplete = await isChannelSetupComplete(channelId);
      if (isComplete) {
        res.redirect(`/app/${secret}`);
      } else {
        res.redirect(`/app/${secret}/onboarding`);
      }
    }
  } catch (err) {
    console.error('[auth] Login error:', err);
    res.redirect('/login?error=server_error');
  }
});

// POST /logout - Clear session
router.post('/logout', (_req: Request, res: Response) => {
  clearSessionCookie(res);
  res.redirect('/login');
});

// GET / - Root redirect
router.get('/', async (req: Request, res: Response) => {
  const token = req.cookies?.lp_session;
  if (token) {
    const payload = authService.verifySessionToken(token);
    if (payload) {
      if (payload.role === 'admin') {
        res.redirect('/admin/dashboard');
        return;
      } else {
        const secret = process.env.APP_SECRET_PATH || '';
        const channelId = payload.channel_id;
        const isComplete = await isChannelSetupComplete(channelId);
        if (isComplete) {
          res.redirect(`/app/${secret}`);
        } else {
          res.redirect(`/app/${secret}/onboarding`);
        }
        return;
      }
    }
  }
  res.redirect('/login');
});

export default router;
