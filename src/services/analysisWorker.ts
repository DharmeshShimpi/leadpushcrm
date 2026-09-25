import { getLeadsDueForAnalysis, getLeadById } from '../db/index.js';
import { groqService } from './groqService.js';

class AnalysisWorker {
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;

  /**
   * Start background worker that runs every 30 seconds
   */
  public startWorker(): void {
    if (this.timer) return;

    console.log('[dev] analysis_worker: Started background debounce worker (30-second interval).');

    // Run check every 30 seconds
    const THIRTY_SECONDS_MS = 30 * 1000;
    this.timer = setInterval(() => {
      this.checkAndProcessDueLeads().catch(err => {
        console.error('Error during scheduled analysis worker run:', err);
      });
    }, THIRTY_SECONDS_MS);
  }

  /**
   * Check for leads whose 2-minute inactivity period has passed
   */
  public async checkAndProcessDueLeads(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const dueLeads = getLeadsDueForAnalysis();
      if (dueLeads.length === 0) return;

      console.log(`[dev] analysis_worker: Found ${dueLeads.length} leads due for Groq analysis after 2-minute inactivity.`);

      for (const lead of dueLeads) {
        // Re-verify lead state from DB before executing
        const currentLead = getLeadById(lead.id);
        if (!currentLead || !currentLead.analysis_due_at) continue;

        const dueTime = new Date(currentLead.analysis_due_at).getTime();
        // Skip if a newer message arrived in the meantime and pushed analysis_due_at into future
        if (Date.now() < dueTime) {
          console.log(`[dev] analysis_worker: Lead #${lead.id} received new activity. Debounce timer reset.`);
          continue;
        }

        await groqService.analyzeConversation(currentLead.id);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  public stopWorker(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const analysisWorker = new AnalysisWorker();
