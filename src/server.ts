import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

// Fail fast: these variables MUST be set before any service initializes
const REQUIRED_ENV_VARS = ['DATA_ENCRYPTION_KEY', 'APP_SECRET_PATH'];
for (const key of REQUIRED_ENV_VARS) {
  if (!process.env[key]) {
    console.error(`[FATAL] Required environment variable "${key}" is not set. Server cannot start safely.`);
    process.exit(1);
  }
}

import { whatsAppService } from './services/whatsappService.js';
import { supabaseService } from './services/supabaseService.js';
import { googleService } from './services/googleService.js';
import { analysisWorker } from './services/analysisWorker.js';
import healthRouter from './routes/health.js';
import dashboardRouter from './routes/dashboard.js';
import onboardingRouter from './routes/onboarding.js';
import whatsappRouter from './routes/whatsapp.js';
import leadsRouter from './routes/leads.js';
import apiRouter from './routes/api.js';
import eventsRouter from './routes/events.js';
import adminRouter from './routes/admin.js';
import googleAuthRouter from './routes/googleAuth.js';
import analysisRouter from './routes/analysis.js';
import manualOpsRouter from './routes/manualOps.js';
import channelsRouter from './routes/channels.js';
import authRouter from './routes/auth.js';
import adminPanelRouter from './routes/adminPanel.js';
import { authService } from './services/authService.js';
import { closeDb, getAllChannelsWithStats, backfillLeadsToChannel } from './db/index.js';

const app = express();
const port = parseInt(process.env.PORT || '3000', 10);
const host = '0.0.0.0';

// Note: SQLite database is auto-initialized when db/index.ts is first imported.
// Calling initDb() here again would run migrations twice — intentionally omitted.

// Start 10-minute retry timers & 30-second Groq analysis worker
supabaseService.startRetryTimer();
googleService.startRetryTimer();
analysisWorker.startWorker();

// Seed admin user from environment variables (idempotent)
authService.seedAdminUser().catch((err) => {
  console.error('Failed to seed admin user:', err);
});

// Single recovery path: channels first → leads → backfill → WhatsApp sessions
(async () => {
  try {
    // 1. Restore all channels from Supabase into local SQLite (must run BEFORE lead restore)
    await supabaseService.restoreChannelsFromBackup();

    // 2. Restore any lead backups if local leads are empty
    const restoredCount = await supabaseService.performStartupRecovery();
    if (restoredCount > 0) {
      console.log(`Startup recovery completed: ${restoredCount} leads restored from Supabase.`);
    }

    // 3. Backfill: assign orphaned leads (null channel_id) to the sole channel if only one exists
    const channels = getAllChannelsWithStats();
    if (channels.length === 1) {
      const backfilled = backfillLeadsToChannel(channels[0].id);
      if (backfilled > 0) {
        console.log(`[startup] Backfilled ${backfilled} orphaned leads to channel "${channels[0].name}" (${channels[0].id})`);
      }
    }

    // 4. Auto-start WhatsApp sessions for all registered channels
    for (const ch of channels) {
      if (whatsAppService.hasCredentials(ch.id)) {
        whatsAppService.initialize(ch.id).catch((err) => {
          console.error(`Failed to auto-start WhatsApp session for channel ${ch.id}:`, err);
        });
      }
    }
  } catch (err) {
    console.error('Error during startup recovery and channel initialization:', err);
  }
})();

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Resolve views & public asset directories for both development and compiled dist
const viewsPath = fs.existsSync(path.join(process.cwd(), 'src', 'views'))
  ? path.join(process.cwd(), 'src', 'views')
  : path.join(process.cwd(), 'dist', 'views');

const publicPath = fs.existsSync(path.join(process.cwd(), 'src', 'public'))
  ? path.join(process.cwd(), 'src', 'public')
  : path.join(process.cwd(), 'dist', 'public');

// Setup EJS view engine
app.set('views', viewsPath);
app.set('view engine', 'ejs');

// Serve static assets
app.use(express.static(publicPath));

// Register routes
app.use('/', healthRouter);
app.use('/', authRouter);
app.use('/', adminPanelRouter);
app.use('/', onboardingRouter);
app.use('/', whatsappRouter);
app.use('/', leadsRouter);
app.use('/', apiRouter);
app.use('/', eventsRouter);
app.use('/', adminRouter);
app.use('/', googleAuthRouter);
app.use('/', analysisRouter);
app.use('/', manualOpsRouter);
app.use('/', channelsRouter);
app.use('/', dashboardRouter);

// Fallback 404 handler for undefined routes
app.use((_req, res) => {
  res.status(404).send('Not Found');
});

// Start server
const server = app.listen(port, host, () => {
  console.log(`LeadPush server listening on http://${host}:${port}`);
});

// Graceful shutdown
async function gracefulShutdown(signal: string) {
  console.log(`Received ${signal}. Shutting down gracefully...`);

  // Stop background timers
  supabaseService.stopRetryTimer();
  googleService.stopRetryTimer();
  analysisWorker.stopWorker();

  // Close WhatsApp socket cleanly
  await whatsAppService.shutdown();

  // Close SQLite DB safely
  closeDb();

  server.close(() => {
    console.log('LeadPush HTTP server closed.');
    process.exit(0);
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

export default app;
