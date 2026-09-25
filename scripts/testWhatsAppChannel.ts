import { whatsAppService } from '../src/services/whatsappService.js';
import path from 'path';

console.log('--- Checking WhatsApp Service Channel Resolution ---');
const testChannelId = 'ch_test123';
const authPath = whatsAppService.getAuthPath(testChannelId);
console.log('Auth path for channel:', authPath);
console.log('Status object:', whatsAppService.getStatus(testChannelId));
