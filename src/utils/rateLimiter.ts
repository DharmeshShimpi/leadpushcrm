/**
 * Lightweight in-memory rate limiter for destructive endpoints.
 * No external dependencies — uses a simple sliding window counter per IP.
 */

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

class InMemoryRateLimiter {
  private store = new Map<string, RateLimitEntry>();
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(options: { windowMs: number; maxRequests: number }) {
    this.windowMs = options.windowMs;
    this.maxRequests = options.maxRequests;

    // Periodic cleanup of expired entries to prevent memory growth
    setInterval(() => this.cleanup(), this.windowMs * 2);
  }

  public isAllowed(key: string): boolean {
    const now = Date.now();
    const entry = this.store.get(key);

    if (!entry || now - entry.windowStart > this.windowMs) {
      // First request in window, or window has expired
      this.store.set(key, { count: 1, windowStart: now });
      return true;
    }

    if (entry.count >= this.maxRequests) {
      return false;
    }

    entry.count++;
    return true;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now - entry.windowStart > this.windowMs) {
        this.store.delete(key);
      }
    }
  }
}

import { Request, Response, NextFunction } from 'express';

/**
 * Create an Express middleware that rate-limits requests per IP.
 * @param windowMs   Time window in milliseconds
 * @param max        Max requests per window per IP
 * @param message    Error message to return when limit is exceeded
 */
export function createRateLimiter(windowMs: number, max: number, message = 'Too many requests. Please try again later.') {
  const limiter = new InMemoryRateLimiter({ windowMs, maxRequests: max });

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (!limiter.isAllowed(ip)) {
      res.status(429).json({ ok: false, error: message });
      return;
    }
    next();
  };
}
