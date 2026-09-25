import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export interface User {
  id: string;
  name: string;
  username?: string | null;
  phone_number?: string | null;
  role: 'admin' | 'operator';
  channel_id: string | null;
  status: string;
  created_at: string;
}

export interface SessionPayload {
  user_id: string;
  role: 'admin' | 'operator';
  channel_id: string | null;
  name: string;
  exp: number;
}

const BCRYPT_ROUNDS = 10;
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getSessionSecret(): string {
  if (process.env.SESSION_SECRET) {
    return process.env.SESSION_SECRET;
  }
  // Auto-generate for dev convenience — logged as warning
  const generated = crypto.randomBytes(32).toString('hex');
  process.env.SESSION_SECRET = generated;
  console.warn('[auth] SESSION_SECRET not set. Generated ephemeral secret (sessions will not persist across restarts).');
  return generated;
}

function getSupabaseClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || '';
  if (!url || !key) return null;
  try {
    return createClient(url, key, { auth: { persistSession: false } });
  } catch {
    return null;
  }
}

class AuthService {
  /**
   * Hash a plaintext password using bcrypt
   */
  public async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, BCRYPT_ROUNDS);
  }

  /**
   * Verify a plaintext password against a bcrypt hash
   */
  public async verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  /**
   * Create an HMAC-signed session token containing user identity
   */
  public createSessionToken(user: User): string {
    const payload: SessionPayload = {
      user_id: user.id,
      role: user.role,
      channel_id: user.channel_id,
      name: user.name,
      exp: Date.now() + SESSION_DURATION_MS
    };
    const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto
      .createHmac('sha256', getSessionSecret())
      .update(payloadStr)
      .digest('base64url');
    return `${payloadStr}.${signature}`;
  }

  /**
   * Verify and decode a session token
   */
  public verifySessionToken(token: string): SessionPayload | null {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;

    const [payloadStr, signature] = parts;
    const expectedSig = crypto
      .createHmac('sha256', getSessionSecret())
      .update(payloadStr)
      .digest('base64url');

    // Timing-safe comparison
    if (signature.length !== expectedSig.length) return null;
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSig);
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;

    try {
      const payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString('utf8')) as SessionPayload;
      if (!payload.user_id || !payload.role || !payload.exp) return null;
      if (Date.now() > payload.exp) return null;
      return payload;
    } catch {
      return null;
    }
  }

  /**
   * Authenticate a user by username (for Admin) or phone number (for Operator).
   * Returns the user if credentials are valid, null otherwise.
   */
  public async authenticateUser(identifier: string, password: string): Promise<User | null> {
    const client = getSupabaseClient();
    if (!client) {
      console.warn('[auth] Cannot authenticate: Supabase client is not available (check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).');
      return null;
    }

    const trimmed = identifier.trim();
    if (!trimmed) return null;

    try {
      // 1. Try matching by username (case-insensitive)
      let { data, error } = await client
        .from('users')
        .select('id, name, username, phone_number, password_hash, role, channel_id, status, created_at')
        .ilike('username', trimmed)
        .eq('status', 'active')
        .maybeSingle();

      // 2. If not found by username, try matching by phone number
      if (!data) {
        const cleanPhone = trimmed.replace(/\D/g, '');
        if (cleanPhone.length >= 10) {
          const phoneRes = await client
            .from('users')
            .select('id, name, username, phone_number, password_hash, role, channel_id, status, created_at')
            .eq('phone_number', cleanPhone)
            .eq('status', 'active')
            .maybeSingle();
          data = phoneRes.data;
          error = phoneRes.error;
        }
      }

      if (error) {
        console.error('[auth] Supabase user query error:', error.message);
        return null;
      }

      if (!data) {
        // If the identifier matches ADMIN_USERNAME and admin user wasn't in Supabase (e.g. after database wipe), auto-seed on demand
        const configuredAdminUser = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
        if (trimmed.toLowerCase() === configuredAdminUser) {
          console.log('[auth] Admin user not found in Supabase. Auto-seeding admin on demand...');
          await this.seedAdminUser();
          const retryRes = await client
            .from('users')
            .select('id, name, username, phone_number, password_hash, role, channel_id, status, created_at')
            .ilike('username', trimmed)
            .eq('status', 'active')
            .maybeSingle();
          data = retryRes.data;
        }
      }

      if (!data) {
        console.warn(`[auth] User not found for identifier: "${trimmed}"`);
        return null;
      }

      const isValid = await this.verifyPassword(password, data.password_hash);
      if (!isValid) {
        console.warn(`[auth] Password mismatch for user: "${trimmed}"`);
        return null;
      }

      return {
        id: data.id,
        name: data.name,
        username: data.username || null,
        phone_number: data.phone_number || null,
        role: data.role,
        channel_id: data.channel_id,
        status: data.status,
        created_at: data.created_at
      };
    } catch (err) {
      console.error('[auth] Error in authenticateUser:', err);
      return null;
    }
  }

  /**
   * Get an active user by their Supabase ID
   */
  public async getUserById(userId: string): Promise<User | null> {
    const client = getSupabaseClient();
    if (!client || !userId) return null;

    try {
      const { data, error } = await client
        .from('users')
        .select('id, name, username, phone_number, role, channel_id, status, created_at')
        .eq('id', userId)
        .eq('status', 'active')
        .maybeSingle();

      if (error || !data) return null;
      return data as User;
    } catch {
      return null;
    }
  }

  /**
   * Seed or sync the default administrator account into Supabase.
   * Updates credentials if admin already exists to match environment variables.
   */
  public async seedAdminUser(): Promise<void> {
    const username = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD;
    const name = process.env.ADMIN_NAME || 'Super Admin';

    if (!username || !password) {
      console.warn('[auth] ADMIN_USERNAME and ADMIN_PASSWORD not set. Skipping admin seed.');
      return;
    }

    const client = getSupabaseClient();
    if (!client) {
      console.warn('[auth] Supabase client not available. Skipping admin seed. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
      return;
    }

    try {
      const passwordHash = await this.hashPassword(password);

      // Check if admin with this username already exists
      const { data: existing, error: selectErr } = await client
        .from('users')
        .select('id, role')
        .ilike('username', username)
        .maybeSingle();

      if (selectErr) {
        console.error('[auth] Error checking for existing admin in Supabase (has users table migration run?):', selectErr.message);
        return;
      }

      if (existing) {
        const { error: updateErr } = await client
          .from('users')
          .update({
            name: name,
            password_hash: passwordHash,
            role: 'admin',
            status: 'active',
            updated_at: new Date().toISOString()
          })
          .eq('id', existing.id);

        if (updateErr) {
          console.error('[auth] Failed to update existing admin user credentials:', updateErr.message);
        } else {
          console.log(`[auth] Admin user "${username}" credentials synced successfully from environment variables.`);
        }
        return;
      }

      const { error } = await client.from('users').insert({
        name: name,
        username: username,
        phone_number: null,
        password_hash: passwordHash,
        role: 'admin',
        channel_id: null,
        status: 'active'
      });

      if (error) {
        console.error('[auth] Failed to seed admin user into Supabase:', error.message);
      } else {
        console.log(`[auth] Admin user "${username}" ("${name}") seeded successfully.`);
      }
    } catch (err) {
      console.error('[auth] Error seeding admin user:', err);
    }
  }

  /**
   * Create an operator in Supabase.
   */
  public async createOperator(name: string, phone: string, password: string, channelId: string): Promise<User> {
    const client = getSupabaseClient();
    if (!client) throw new Error('Supabase not available');

    const cleanPhone = phone.replace(/\D/g, '');
    if (!cleanPhone || cleanPhone.length < 10) {
      throw new Error('Invalid phone number');
    }

    if (!password || password.length < 6) {
      throw new Error('Password must be at least 6 characters');
    }

    if (!name.trim()) {
      throw new Error('Name is required');
    }

    // Check if this channel is already assigned to another operator
    const { data: existingOperator } = await client
      .from('users')
      .select('id, name')
      .eq('role', 'operator')
      .eq('channel_id', channelId)
      .maybeSingle();

    if (existingOperator) {
      throw new Error(`This channel is already assigned to operator "${existingOperator.name}"`);
    }

    const passwordHash = await this.hashPassword(password);

    const { data, error } = await client.from('users').insert({
      name: name.trim(),
      phone_number: cleanPhone,
      password_hash: passwordHash,
      role: 'operator',
      channel_id: channelId,
      status: 'active'
    }).select('id, name, phone_number, role, channel_id, status, created_at').single();

    if (error) {
      if (error.code === '23505') {
        if (error.message?.includes('channel') || error.details?.includes('channel') || error.message?.includes('idx_users_unique_operator_channel')) {
          throw new Error('This channel is already assigned to another operator');
        }
        throw new Error('An account with this phone number already exists');
      }
      throw new Error(error.message);
    }

    // Also mirror to dedicated operators table in Supabase
    try {
      await client.from('operators').upsert({
        id: data.id,
        name: data.name,
        phone_number: cleanPhone,
        channel_id: channelId,
        status: 'active',
        updated_at: new Date().toISOString()
      }, { onConflict: 'phone_number' });
    } catch (opErr) {
      console.warn('[auth] Note: Mirroring to operators table:', opErr);
    }

    return data as User;
  }

  /**
   * Get all operators from Supabase
   */
  public async getAllOperators(): Promise<User[]> {
    const client = getSupabaseClient();
    if (!client) return [];

    try {
      const { data, error } = await client
        .from('users')
        .select('id, name, phone_number, role, channel_id, status, created_at')
        .eq('role', 'operator')
        .order('created_at', { ascending: false });

      if (error || !data) return [];
      return data as User[];
    } catch {
      return [];
    }
  }

  /**
   * Unassign all operators from a channel (e.g. when a channel is deleted)
   */
  public async unassignOperatorsFromChannel(channelId: string): Promise<void> {
    if (!channelId) return;
    const client = getSupabaseClient();
    if (!client) return;

    try {
      await client
        .from('users')
        .update({ channel_id: null, updated_at: new Date().toISOString() })
        .eq('channel_id', channelId);

      await client
        .from('operators')
        .update({ channel_id: null, updated_at: new Date().toISOString() })
        .eq('channel_id', channelId);

      console.log(`[auth] Unassigned operators from channel ${channelId}`);
    } catch (err) {
      console.error(`[auth] Error unassigning operators from channel ${channelId}:`, err);
    }
  }

  /**
   * Reassign an operator to a different channel or unassign them (channelId = null)
   */
  public async reassignOperator(operatorId: string, newChannelId: string | null): Promise<void> {
    if (!operatorId) throw new Error('Operator ID is required');
    const client = getSupabaseClient();
    if (!client) throw new Error('Supabase not available');

    if (newChannelId) {
      // Check if target channel is already assigned to another operator
      const { data: existing } = await client
        .from('users')
        .select('id, name')
        .eq('role', 'operator')
        .eq('channel_id', newChannelId)
        .neq('id', operatorId)
        .maybeSingle();

      if (existing) {
        throw new Error(`Channel is already assigned to operator "${existing.name}"`);
      }
    }

    const updatePayload = {
      channel_id: newChannelId || null,
      updated_at: new Date().toISOString()
    };

    const { error: userErr } = await client
      .from('users')
      .update(updatePayload)
      .eq('id', operatorId);

    if (userErr) throw new Error(userErr.message);

    try {
      await client
        .from('operators')
        .update(updatePayload)
        .eq('id', operatorId);
    } catch (opErr) {
      console.warn('[auth] Note updating operators table on reassign:', opErr);
    }
  }

  /**
   * Delete an operator completely
   */
  public async deleteOperator(operatorId: string): Promise<void> {
    if (!operatorId) throw new Error('Operator ID is required');
    const client = getSupabaseClient();
    if (!client) throw new Error('Supabase not available');

    // First delete from operators table
    try {
      await client
        .from('operators')
        .delete()
        .eq('id', operatorId);
    } catch (opErr) {
      console.warn('[auth] Note deleting from operators table:', opErr);
    }

    // Then delete from users table
    const { error } = await client
      .from('users')
      .delete()
      .eq('id', operatorId)
      .eq('role', 'operator');

    if (error) throw new Error(error.message);
  }
}

export const authService = new AuthService();
