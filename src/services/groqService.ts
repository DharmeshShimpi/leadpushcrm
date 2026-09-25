import Groq from 'groq-sdk';
import {
  Lead,
  db,
  getMessagesByLeadId,
  saveLeadAnalysisResult,
  setLeadAnalysisError,
  getLeadById
} from '../db/index.js';
import { supabaseService } from './supabaseService.js';
import { googleService } from './googleService.js';
import { sseService } from './sseService.js';

export interface GroqAnalysisResult {
  status: 'interested' | 'not_interested' | 'undecided';
  conversion_score: 'Hot' | 'Warm' | 'Cold';
  confidence: number;
  qualification_reason: string;
  customer_name?: string | null;
  answers: {
    requirement: string | null;
    budget: string | null;
    timeline: string | null;
    location: string | null;
    firm_company: string | null;
    cp_developer: string | null;
    other_details: string | null;
  };
  conversation_summary: string;
}

class GroqService {
  private activeLocks: Set<number> = new Set();

  private getGroqClient(): Groq | null {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return null;
    return new Groq({ apiKey });
  }

  /**
   * Run Groq LLM analysis on a lead's conversation history
   */
  public async analyzeConversation(leadId: number, options?: { force?: boolean }): Promise<Lead | null> {
    const lead = getLeadById(leadId);
    if (!lead) return null;

    // Per-lead lock to prevent concurrent analysis calls
    if (this.activeLocks.has(leadId)) {
      console.log(`[dev] groq_analysis_locked: Lead #${leadId} is already being analyzed.`);
      return lead;
    }

    // Unless forced, verify no newer message arrived during 2-minute window
    if (!options?.force && lead.analysis_due_at) {
      const dueTime = new Date(lead.analysis_due_at).getTime();
      if (Date.now() < dueTime) {
        console.log(`[dev] groq_analysis_pending: Lead #${leadId} activity occurred recently. Postponed.`);
        return lead;
      }
    }

    this.activeLocks.add(leadId);

    console.log(`[analysis_started] lead_id=${leadId}`);

    try {
      // Fetch up to 30 recent messages chronologically
      const messages = getMessagesByLeadId(leadId);
      const recentMessages = messages.slice(-30);

      // Build conversation transcript for prompt
      let conversationFormatted = '';
      if (recentMessages.length > 0) {
        conversationFormatted = recentMessages.map(m => {
          const role = m.direction === 'outgoing' ? 'Business/Representative' : (m.sender_name || 'Customer');
          return `[${m.sent_at}] ${role}: ${m.message_text}`;
        }).join('\n');
      } else if (lead.latest_message && lead.latest_message.trim()) {
        const role = lead.customer_name || 'Customer';
        conversationFormatted = `[${lead.last_activity_at || new Date().toISOString()}] ${role}: ${lead.latest_message.trim()}`;
      } else {
        // No conversation text found to analyze. Mark as undecided to prevent infinite debounce loops
        console.log(`[dev] groq_analysis_no_messages: Lead #${leadId} has no message text. Resolving to undecided.`);
        const now = new Date().toISOString();
        db.prepare(`
          UPDATE leads SET
            status = 'undecided',
            conversion_score = 'Cold',
            analysis_due_at = NULL,
            last_analyzed_at = ?,
            updated_at = ?
          WHERE id = ?
        `).run(now, now, leadId);
        this.activeLocks.delete(leadId);
        const resolvedLead = getLeadById(leadId);
        if (resolvedLead) {
          sseService.broadcast('dashboard_update', { leadId, channelId: resolvedLead.channel_id, state: 'analysis_completed' });
        }
        return resolvedLead || null;
      }

      const systemPrompt = `You are an expert sales lead analyzer. Analyze the provided WhatsApp conversation between a business and a potential customer.
Extract key sales qualification metadata according to strict guidelines.

CLASSIFICATION RULES:
- "interested": clear purchase/booking/demo/consultation/availability/pricing/callback intent from customer.
- "not_interested": explicit rejection, no need, stop request, or clear refusal.
- "undecided": not enough evidence, generic discussion, unclear intent.
- NEVER infer missing budget, timeline, company, or location if not explicitly stated.
- CP vs DEVELOPER RULE: Pay close attention to phrases like "I'm developer", "we are developers", "I am a CP", "channel partner", "broker", "agent", "builder", "direct buyer".
  - If customer indicates they are a developer/builder -> set "cp_developer" to "Developer"
  - If customer indicates they are a channel partner/broker/agent -> set "cp_developer" to "Channel Partner (CP)"
  - If customer indicates they are a direct buyer/homebuyer -> set "cp_developer" to "Direct Buyer"
- confidence MUST be a floating point number between 0.0 and 1.0.
- conversion_score MUST be one of: "Hot" (high purchase/booking intent or demo request), "Warm" (moderate interest/inquiry), "Cold" (low intent/disinterested/unclear).
- conversation_summary MUST be a maximum of 2 concise sentences.
- CURRENCY RULE: All budget and financial amounts MUST ALWAYS be formatted in Indian Rupees using the '₹' symbol (e.g. "₹7,000", "₹50 Lakhs", "₹1.5 Cr"). NEVER use '$' or USD.

STRICT JSON OUTPUT FORMAT:
Return ONLY a raw JSON object matching this schema exactly with no surrounding Markdown or explanation:
{
  "status": "interested" | "not_interested" | "undecided",
  "conversion_score": "Hot" | "Warm" | "Cold",
  "confidence": 0.85,
  "qualification_reason": "Customer explicitly requested project details and pricing.",
  "customer_name": "John Doe or null",
  "answers": {
    "requirement": "2 BHK Flat or null",
    "budget": "₹75 Lakhs or null",
    "timeline": "Immediate or null",
    "location": "Mumbai or null",
    "firm_company": "Firm or Company name or null",
    "cp_developer": "Channel Partner (CP)" | "Developer" | "Direct Buyer" | null,
    "other_details": "Additional preferences or null"
  },
  "conversation_summary": "Customer inquired about project details in Mumbai."
}`;

      const groq = this.getGroqClient();
      let parsedResult: GroqAnalysisResult;

      if (!groq) {
        // Fallback mock classification for development testing if GROQ_API_KEY is not configured
        console.warn(`[analysis_started_fallback] lead_id=${leadId}`);
        parsedResult = this.generateFallbackAnalysis(conversationFormatted, lead);
      } else {
        const model = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
        const response = await groq.chat.completions.create({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `CONVERSATION TRANSCRIPT:\n${conversationFormatted}` }
          ],
          model: model,
          temperature: 0.2,
          response_format: { type: 'json_object' }
        });

        const rawContent = response.choices[0]?.message?.content || '{}';
        parsedResult = this.parseAndValidateGroqResponse(rawContent);
      }

      // Save analysis outcome to SQLite
      const updatedLead = saveLeadAnalysisResult(leadId, parsedResult);
      if (!updatedLead) throw new Error('Failed to update lead analysis in DB');

      console.log(`[analysis_completed] lead_id=${leadId} status=${updatedLead.status} confidence=${updatedLead.confidence}`);

      // Broadcast SSE live update
      sseService.broadcast('dashboard_update', { leadId: leadId, channelId: updatedLead.channel_id, state: 'analysis_completed' });

      // Mirror update to Supabase lead_backups & Google Sheets asynchronously
      supabaseService.syncLead(updatedLead).catch(err => {
        console.error(`[analysis_supabase_sync_failed] lead_id=${leadId}:`, err instanceof Error ? err.message : err);
      });

      googleService.syncLeadToSheet(updatedLead).catch(err => {
        console.error(`[analysis_google_sheet_sync_failed] lead_id=${leadId}:`, err instanceof Error ? err.message : err);
      });

      return updatedLead;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[analysis_failed] lead_id=${leadId} error=${errorMsg}`);
      setLeadAnalysisError(leadId, errorMsg);
      return lead;
    } finally {
      this.activeLocks.delete(leadId);
    }
  }

  /**
   * Validate and parse Groq raw JSON response
   */
  public parseAndValidateGroqResponse(rawJson: string): GroqAnalysisResult {
    const cleaned = rawJson.replace(/```json/g, '').replace(/```/g, '').trim();
    const data = JSON.parse(cleaned);

    const validStatuses = ['interested', 'not_interested', 'undecided'];
    const status = validStatuses.includes(data.status) ? data.status : 'undecided';

    const rawConf = typeof data.confidence === 'number' ? data.confidence : parseFloat(data.confidence);
    const confidence = isNaN(rawConf) ? 0.5 : Math.min(1.0, Math.max(0.0, rawConf));

    const qualification_reason = typeof data.qualification_reason === 'string' ? data.qualification_reason : 'Conversation analysis completed.';
    const conversation_summary = typeof data.conversation_summary === 'string' ? data.conversation_summary : 'Customer engaged in WhatsApp conversation.';
    const customer_name = typeof data.customer_name === 'string' ? data.customer_name : null;

    const rawAnswers = data.answers || {};
    let rawBudget = typeof rawAnswers.budget === 'string' ? rawAnswers.budget : null;
    if (rawBudget) {
      rawBudget = rawBudget.replace(/\$/g, '₹');
    }

    let parsedCpDev = typeof rawAnswers.cp_developer === 'string' ? rawAnswers.cp_developer : (typeof rawAnswers.cp === 'string' ? rawAnswers.cp : (typeof rawAnswers.developer === 'string' ? rawAnswers.developer : null));
    if (parsedCpDev) {
      const lowerDev = parsedCpDev.toLowerCase();
      if (lowerDev.includes('developer') || lowerDev.includes('builder')) {
        parsedCpDev = 'Developer';
      } else if (lowerDev.includes('cp') || lowerDev.includes('channel partner') || lowerDev.includes('broker') || lowerDev.includes('agent')) {
        parsedCpDev = 'Channel Partner (CP)';
      } else if (lowerDev.includes('direct buyer') || lowerDev.includes('buyer') || lowerDev.includes('client')) {
        parsedCpDev = 'Direct Buyer';
      }
    }

    const answers = {
      requirement: typeof rawAnswers.requirement === 'string' ? rawAnswers.requirement : null,
      budget: rawBudget,
      timeline: typeof rawAnswers.timeline === 'string' ? rawAnswers.timeline : null,
      location: typeof rawAnswers.location === 'string' ? rawAnswers.location : null,
      firm_company: typeof rawAnswers.firm_company === 'string' ? rawAnswers.firm_company : null,
      cp_developer: parsedCpDev,
      other_details: typeof rawAnswers.other_details === 'string' ? rawAnswers.other_details : null
    };

    const validScores = ['Hot', 'Warm', 'Cold'];
    let conversion_score: 'Hot' | 'Warm' | 'Cold' = 'Warm';
    if (typeof data.conversion_score === 'string' && validScores.includes(data.conversion_score)) {
      conversion_score = data.conversion_score as 'Hot' | 'Warm' | 'Cold';
    } else {
      if (status === 'interested') conversion_score = confidence >= 0.7 ? 'Hot' : 'Warm';
      else if (status === 'not_interested') conversion_score = 'Cold';
      else conversion_score = 'Warm';
    }

    return {
      status,
      conversion_score,
      confidence,
      qualification_reason,
      customer_name,
      answers,
      conversation_summary
    };
  }

  private generateFallbackAnalysis(transcript: string, lead: Lead): GroqAnalysisResult {
    const lower = transcript.toLowerCase();
    let status: 'interested' | 'not_interested' | 'undecided' = 'undecided';
    let confidence = 0.6;
    let reason = 'Customer engaged in general discussion.';

    if (lower.includes('price') || lower.includes('cost') || lower.includes('demo') || lower.includes('buy') || lower.includes('book') || lower.includes('yes') || lower.includes('interested')) {
      status = 'interested';
      confidence = 0.85;
      reason = 'Customer inquired about pricing, demo, or purchase availability.';
    } else if (lower.includes('stop') || lower.includes('not interested') || lower.includes('don\'t want') || lower.includes('no thanks')) {
      status = 'not_interested';
      confidence = 0.90;
      reason = 'Customer expressed explicit disinterest or requested to stop.';
    }

    let extractedName: string | null = lead.customer_name || null;
    if (!extractedName || extractedName === 'N/A') {
      const nameMatch = transcript.match(/(?:i am|my name is|this is|myself|i'm)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
      if (nameMatch && nameMatch[1]) {
        extractedName = nameMatch[1].trim();
      }
    }

    let fallbackCpDev: string | null = null;
    if (lower.includes('developer') || lower.includes('builder')) {
      fallbackCpDev = 'Developer';
    } else if (lower.includes('channel partner') || lower.includes('cp ') || lower.includes('broker')) {
      fallbackCpDev = 'Channel Partner (CP)';
    }

    let fallbackCompany: string | null = null;
    const compMatch = transcript.match(/company is\s+([A-Z][a-z0-9\s]+)/i);
    if (compMatch && compMatch[1]) {
      fallbackCompany = compMatch[1].trim();
    }

    let fallbackLocation: string | null = null;
    if (lower.includes('mumbai')) fallbackLocation = 'Mumbai';
    else if (lower.includes('thane')) fallbackLocation = 'Thane';
    else if (lower.includes('pune')) fallbackLocation = 'Pune';

    const conversion_score: 'Hot' | 'Warm' | 'Cold' = status === 'interested' ? 'Hot' : (status === 'not_interested' ? 'Cold' : 'Warm');

    return {
      status,
      conversion_score,
      confidence,
      qualification_reason: reason,
      customer_name: extractedName,
      answers: {
        requirement: lower.includes('pricing') || lower.includes('video') ? 'Video pricing inquiry' : null,
        budget: lower.includes('5000') ? '₹5,000' : null,
        timeline: null,
        location: fallbackLocation,
        firm_company: fallbackCompany,
        cp_developer: fallbackCpDev,
        other_details: null
      },
      conversation_summary: `Customer participated in WhatsApp chat. Analyzed intent as ${status}.`
    };
  }
}

export const groqService = new GroqService();
