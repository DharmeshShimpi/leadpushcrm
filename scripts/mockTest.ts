import { saveMessageAndUpsertCanonicalLead } from '../src/db/index.js';
import { groqService } from '../src/services/groqService.js';

async function runMockScenarios() {
  console.log('--- Starting Mock Lead Test Scenarios ---');

  const now = new Date().toISOString();

  // Mock Lead 1: Rajesh Sharma - Real Estate Inquiry (Hot Lead)
  console.log('\n[1/3] Ingesting Lead 1: Rajesh Sharma (2 BHK Inquiry in Powai)');
  const lead1Result = saveMessageAndUpsertCanonicalLead({
    wa_message_id: 'MOCK_MSG_001',
    canonicalJid: '919876543210@s.whatsapp.net',
    candidateJids: ['919876543210@s.whatsapp.net'],
    direction: 'incoming',
    sender_name: 'Rajesh Sharma',
    message_text: 'Hi, I am interested in your 2 BHK apartments in Powai, Mumbai. What is the pricing and budget requirement?',
    message_type: 'conversation',
    displayPhone: '+91 98765 43210',
    isBusinessSelf: false,
    sent_at: now
  });

  if (lead1Result.leadId) {
    console.log(`[Lead #1 Created ID: ${lead1Result.leadId}] Running Groq Analysis...`);
    const analyzedLead = await groqService.analyzeConversation(lead1Result.leadId, { force: true });
    console.log('-> Groq Result Status:', analyzedLead?.status);
    console.log('-> Conversion Score:', analyzedLead?.conversion_score);
    console.log('-> Extracted Answers:', analyzedLead?.extracted_answers);

    // Follow-up answer from Rajesh
    console.log('\n[1/3 Follow-up] Customer sends location and budget preference...');
    saveMessageAndUpsertCanonicalLead({
      wa_message_id: 'MOCK_MSG_002',
      canonicalJid: '919876543210@s.whatsapp.net',
      candidateJids: ['919876543210@s.whatsapp.net'],
      direction: 'incoming',
      sender_name: 'Rajesh Sharma',
      message_text: 'My budget is around ₹85 Lakhs and I am a direct buyer, looking in Hiranandani Powai.',
      message_type: 'conversation',
      displayPhone: '+91 98765 43210',
      isBusinessSelf: false,
      sent_at: new Date().toISOString()
    });

    const reAnalyzedLead = await groqService.analyzeConversation(lead1Result.leadId, { force: true });
    console.log('-> Updated Extracted Answers:', reAnalyzedLead?.extracted_answers);
  }

  // Mock Lead 2: Priya Verma - Channel Partner / Broker (Hot Lead)
  console.log('\n[2/3] Ingesting Lead 2: Priya Verma (Channel Partner Inquiry)');
  const lead2Result = saveMessageAndUpsertCanonicalLead({
    wa_message_id: 'MOCK_MSG_003',
    canonicalJid: '919820011223@s.whatsapp.net',
    candidateJids: ['919820011223@s.whatsapp.net'],
    direction: 'incoming',
    sender_name: 'Priya Verma',
    message_text: 'Hello team, I am a Channel Partner (CP) from Apex Realty. We have 3 client leads interested in commercial spaces in Whitefield Bangalore with a budget of ₹2.5 Cr.',
    message_type: 'conversation',
    displayPhone: '+91 98200 11223',
    isBusinessSelf: false,
    sent_at: now
  });

  if (lead2Result.leadId) {
    console.log(`[Lead #2 Created ID: ${lead2Result.leadId}] Running Groq Analysis...`);
    const analyzedLead2 = await groqService.analyzeConversation(lead2Result.leadId, { force: true });
    console.log('-> Groq Result Status:', analyzedLead2?.status);
    console.log('-> Conversion Score:', analyzedLead2?.conversion_score);
    console.log('-> Extracted Answers:', analyzedLead2?.extracted_answers);
  }

  // Mock Lead 3: Amit Patel - Not Interested (Cold Lead)
  console.log('\n[3/3] Ingesting Lead 3: Amit Patel (Disinterested)');
  const lead3Result = saveMessageAndUpsertCanonicalLead({
    wa_message_id: 'MOCK_MSG_004',
    canonicalJid: '919112233445@s.whatsapp.net',
    candidateJids: ['919112233445@s.whatsapp.net'],
    direction: 'incoming',
    sender_name: 'Amit Patel',
    message_text: 'Please remove my number from your mailing list. I am not interested at all.',
    message_type: 'conversation',
    displayPhone: '+91 91122 33445',
    isBusinessSelf: false,
    sent_at: now
  });

  if (lead3Result.leadId) {
    console.log(`[Lead #3 Created ID: ${lead3Result.leadId}] Running Groq Analysis...`);
    const analyzedLead3 = await groqService.analyzeConversation(lead3Result.leadId, { force: true });
    console.log('-> Groq Result Status:', analyzedLead3?.status);
    console.log('-> Conversion Score:', analyzedLead3?.conversion_score);
    console.log('-> Extracted Answers:', analyzedLead3?.extracted_answers);
  }

  // Mock Lead 4: Karan Malhotra - Luxury Penthouse (Hot Lead)
  console.log('\n[4/7] Ingesting Lead 4: Karan Malhotra');
  const lead4Result = saveMessageAndUpsertCanonicalLead({
    wa_message_id: 'MOCK_MSG_005',
    canonicalJid: '919811122334@s.whatsapp.net',
    candidateJids: ['919811122334@s.whatsapp.net'],
    direction: 'incoming',
    sender_name: 'Karan Malhotra',
    message_text: 'Looking for 3 BHK luxury penthouse in Worli Mumbai, budget around ₹4.5 Cr. Please send brochures.',
    message_type: 'conversation',
    displayPhone: '+91 98111 22334',
    isBusinessSelf: false,
    sent_at: now
  });
  if (lead4Result.leadId) await groqService.analyzeConversation(lead4Result.leadId, { force: true });

  // Mock Lead 5: Ananya Deshmukh - Retail Shop (Warm Lead)
  console.log('\n[5/7] Ingesting Lead 5: Ananya Deshmukh');
  const lead5Result = saveMessageAndUpsertCanonicalLead({
    wa_message_id: 'MOCK_MSG_006',
    canonicalJid: '919855566778@s.whatsapp.net',
    candidateJids: ['919855566778@s.whatsapp.net'],
    direction: 'incoming',
    sender_name: 'Ananya Deshmukh',
    message_text: 'Hi, inquiring about retail shop space in Thane West. Budget is ₹1.2 Cr.',
    message_type: 'conversation',
    displayPhone: '+91 98555 66778',
    isBusinessSelf: false,
    sent_at: now
  });
  if (lead5Result.leadId) await groqService.analyzeConversation(lead5Result.leadId, { force: true });

  // Mock Lead 6: Vikram Sethi - Ready to Move Flat (Warm Lead)
  console.log('\n[6/7] Ingesting Lead 6: Vikram Sethi');
  const lead6Result = saveMessageAndUpsertCanonicalLead({
    wa_message_id: 'MOCK_MSG_007',
    canonicalJid: '919899900112@s.whatsapp.net',
    candidateJids: ['919899900112@s.whatsapp.net'],
    direction: 'incoming',
    sender_name: 'Vikram Sethi',
    message_text: 'Are 1 BHK ready to move flats available near Hinjewadi Pune?',
    message_type: 'conversation',
    displayPhone: '+91 98999 00112',
    isBusinessSelf: false,
    sent_at: now
  });
  if (lead6Result.leadId) await groqService.analyzeConversation(lead6Result.leadId, { force: true });

  // Mock Lead 7: Sneha Kulkarni - Office Space (Hot Lead)
  console.log('\n[7/7] Ingesting Lead 7: Sneha Kulkarni');
  const lead7Result = saveMessageAndUpsertCanonicalLead({
    wa_message_id: 'MOCK_MSG_008',
    canonicalJid: '919877788990@s.whatsapp.net',
    candidateJids: ['919877788990@s.whatsapp.net'],
    direction: 'incoming',
    sender_name: 'Sneha Kulkarni',
    message_text: 'We are expanding our IT firm and need 5,000 sq ft office space in BKC Mumbai. Budget ₹8 Cr.',
    message_type: 'conversation',
    displayPhone: '+91 98777 88990',
    isBusinessSelf: false,
    sent_at: now
  });
  if (lead7Result.leadId) await groqService.analyzeConversation(lead7Result.leadId, { force: true });

  console.log('\n--- Mock Lead Test Completed Successfully! Total 7 Leads. ---');
}

runMockScenarios().catch(console.error);
