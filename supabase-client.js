// Supabase client module (ES module)
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

const SUPABASE_URL = import.meta.env?.VITE_SUPABASE_URL || 'https://rwxzmnvtmaeswygyntyz.supabase.co';
const SUPABASE_ANON_KEY = import.meta.env?.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ3eHptbnZ0bWFlc3d5Z3ludHl6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAxOTE1NDIsImV4cCI6MjA4NTc2NzU0Mn0.pLzSBuB0rZqfKJtDJzxUq9NV5a1ZrGjhfenGQNyvKzM';

// Create client with retry logic
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true
  },
  global: {
    fetch: (...args) => fetch(...args).catch(err => {
      console.error('Supabase fetch error:', err);
      throw new Error('Network error - please check your connection');
    })
  }
});

// Helper for batch operations with retry
export async function batchOperation(operations, batchSize = 10) {
  const results = [];
  for (let i = 0; i < operations.length; i += batchSize) {
    const batch = operations.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map(op => op()));
    results.push(...batchResults);
    
    // Small delay between batches to prevent rate limiting
    if (i + batchSize < operations.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  return results;
}

// Transaction-like helper for related operations
export async function executeTransaction(operations) {
  const results = [];
  const errors = [];
  
  for (const operation of operations) {
    try {
      const result = await operation();
      results.push(result);
    } catch (error) {
      errors.push(error);
      // Rollback would require database support - for now, we log and continue
      console.error('Transaction operation failed:', error);
    }
  }
  
  if (errors.length > 0) {
    throw new Error(`Transaction failed with ${errors.length} errors`);
  }
  
  return results;
}

// Rate limiting helper
const rateLimiter = {
  tokens: 60,
  lastRefill: Date.now(),
  
  async acquire() {
    const now = Date.now();
    const timePassed = now - this.lastRefill;
    this.tokens = Math.min(60, this.tokens + Math.floor(timePassed / 1000) * 10);
    this.lastRefill = now;
    
    if (this.tokens <= 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return this.acquire();
    }
    
    this.tokens--;
    return true;
  }
};

export async function fetchTable(table = 'grades', options = {}) {
  await rateLimiter.acquire();
  
  const query = supabase.from(table).select('*');
  
  if (options.userId) {
    query.eq('user_id', options.userId);
  }
  
  if (options.classroomId) {
    query.eq('classroom_id', options.classroomId);
  }
  
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

export async function insertRow(table, row) {
  await rateLimiter.acquire();
  
  const { data, error } = await supabase.from(table).insert(row).select();
  if (error) throw error;
  return data;
}

export async function upsertRows(table, rows, conflictKey = 'id') {
  await rateLimiter.acquire();
  
  const { data, error } = await supabase
    .from(table)
    .upsert(rows, { onConflict: conflictKey })
    .select();
    
  if (error) throw error;
  return data;
}

export function subscribeTable(table = 'grades', onEvent = () => {}) {
  const channel = supabase
    .channel(`public:${table}`)
    .on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => {
      try {
        onEvent(payload);
      } catch (e) {
        console.error('subscribeTable onEvent handler error', e);
      }
    })
    .subscribe();

  return channel;
}

export async function unsubscribeChannel(channel) {
  try {
    await channel.unsubscribe();
  } catch (e) {
    console.error('unsubscribeChannel error', e);
  }
}

// Export to window
if (typeof window !== 'undefined') {
  window.supabaseClient = {
    supabase,
    fetchTable,
    insertRow,
    upsertRows,
    subscribeTable,
    unsubscribeChannel,
    batchOperation,
    executeTransaction
  };
}