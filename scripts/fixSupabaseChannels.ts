// Script to create ch_87549fb2 as "7 Orbit Studio" in Supabase
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  // 1. Insert the channel
  console.log('--- Creating channel ch_87549fb2 as "7 Orbit Studio" ---');
  const { data, error } = await supabase
    .from('channels')
    .upsert({
      id: 'ch_87549fb2',
      name: '7 Orbit Studio',
      status: 'active',
      updated_at: new Date().toISOString()
    }, { onConflict: 'id' })
    .select();

  if (error) {
    console.error('Error:', error.message);
  } else {
    console.log('Created:', JSON.stringify(data, null, 2));
  }

  // 2. Verify final state
  console.log('\n--- Final State ---');
  const { data: channels } = await supabase.from('channels').select('*');
  console.log('Channels:', JSON.stringify(channels, null, 2));

  const { data: leads } = await supabase.from('lead_backups').select('id, lead_identity, channel_id, customer_name');
  console.log(`\nTotal leads: ${leads?.length || 0}`);
  leads?.forEach(l => console.log(`  ${l.customer_name || 'N/A'} → channel: ${l.channel_id}`));
}

main().catch(console.error);
