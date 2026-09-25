import { Request, Response, NextFunction } from 'express';
import { authService, SessionPayload } from '../services/authService.js';

// Extend Express Request to include authenticated user
declare global {
  namespace Express {
    interface Request {
      user?: SessionPayload;
    }
  }
}

const COOKIE_NAME = 'lp_session';

/**
 * Middleware: Requires any authenticated user (admin or operator).
 * Reads the session cookie, verifies it, checks database existence, and attaches req.user.
 * Redirects to /login if not authenticated or user no longer exists.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    res.redirect('/login');
    return;
  }

  const payload = authService.verifySessionToken(token);
  if (!payload) {
    // Clear invalid cookie
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.redirect('/login');
    return;
  }

  // Verify user still exists and is active in database (handles database resets / user deletions)
  const dbUser = await authService.getUserById(payload.user_id);
  if (!dbUser || dbUser.status !== 'active') {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.redirect('/login');
    return;
  }

  // Operators must have an assigned channel
  if (dbUser.role === 'operator' && !dbUser.channel_id) {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.redirect('/login?error=no_channel');
    return;
  }

  req.user = {
    user_id: dbUser.id,
    role: dbUser.role,
    channel_id: dbUser.channel_id,
    name: dbUser.name,
    exp: payload.exp
  };

  next();
}

/**
 * Middleware: Requires admin role.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (req.user?.role !== 'admin') {
      res.status(403).send('Forbidden: Admin access required');
      return;
    }
    next();
  });
}

/**
 * Middleware: Requires operator role.
 */
export function requireOperator(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (req.user?.role !== 'operator') {
      res.status(403).send('Forbidden: Operator access required');
      return;
    }
    next();
  });
}

/**
 * Set the session cookie on the response.
 */
export function setSessionCookie(res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: '/'
  });
}

/**
 * Clear the session cookie.
 */
export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

export { COOKIE_NAME };
