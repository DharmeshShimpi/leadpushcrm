import { whatsAppService } from '../src/services/whatsappService.js';

async function run() {
  console.log('Initializing WhatsApp Service...');
  await whatsAppService.initialize();
  
  console.log('Waiting for connection...');
  await new Promise(r => setTimeout(r, 10000));
  
  console.log('Triggering LID resolution...');
  await whatsAppService.resolveAllUnresolvedLeads();
  
  console.log('Waiting for resolution to complete...');
  await new Promise(r => setTimeout(r, 5000));
  
  console.log('Done.');
  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
