// Mock Supabase client for local development
// In production, replace with real Supabase URL and anon key
// This mock implements the same API shape as @supabase/supabase-js for auth

if (typeof window.supabase !== 'undefined') {
  // Already loaded, do not redeclare
} else {
const MOCK = true;
const STORAGE_KEY = 'spim_mock_session';

class MockSupabase {
  constructor() {
    this.auth = {
      signUp: async ({email, password}) => {
        // Check if user exists
        const users = JSON.parse(localStorage.getItem('spim_mock_users') || '[]');
        if (users.find(u => u.email === email)) {
          return { data: null, error: { message: 'User already exists' } };
        }
        const user = { id: 'user_' + Math.random().toString(36).slice(2,9), email, created_at: new Date().toISOString() };
        users.push({ ...user, password }); // In real Supabase, password is hashed
        localStorage.setItem('spim_mock_users', JSON.stringify(users));
        // Also create profile
        const profiles = JSON.parse(localStorage.getItem('spim_mock_profiles') || '[]');
        profiles.push({ user_id: user.id, email: user.email, created_at: user.created_at });
        localStorage.setItem('spim_mock_profiles', JSON.stringify(profiles));
        const session = { user, access_token: 'mock_token_' + user.id, refresh_token: 'mock_refresh_' + user.id };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
        return { data: { user, session }, error: null };
      },
      signInWithPassword: async ({email, password}) => {
        const users = JSON.parse(localStorage.getItem('spim_mock_users') || '[]');
        const user = users.find(u => u.email === email && u.password === password);
        if (!user) {
          return { data: null, error: { message: 'Invalid credentials' } };
        }
        const session = { user: { id: user.id, email: user.email }, access_token: 'mock_token_' + user.id, refresh_token: 'mock_refresh_' + user.id };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
        return { data: { user: session.user, session }, error: null };
      },
      signOut: async () => {
        localStorage.removeItem(STORAGE_KEY);
        return { error: null };
      },
      getSession: async () => {
        const session = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        return { data: { session }, error: null };
      },
      onAuthStateChange: (callback) => {
        // Simple mock
        const session = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        if (session) callback('SIGNED_IN', session);
        return { data: { subscription: { unsubscribe: () => {} } } };
      }
    };
  }
}

// For local dev, use mock. For production, set SUPABASE_URL and SUPABASE_ANON_KEY
let supabase;
if (MOCK) {
  supabase = new MockSupabase();
} else {
  // Real Supabase - would be:
  // import { createClient } from '@supabase/supabase-js';
  // supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

window.supabase = supabase;
}
