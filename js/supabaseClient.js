/*
 * SPIM auth client.
 *
 * The filename is historical: every page already loads it. It is no longer a
 * mock — identity comes from /api/auth/*, the session is an HttpOnly cookie
 * issued by Pages Functions, and no password or token is ever kept in
 * localStorage. The small API shape is kept so existing pages keep working.
 */
(function () {
  if (window.SpimAuth) return;

  async function request(path, options) {
    const opts = Object.assign({ credentials: 'include', headers: {} }, options || {});
    if (opts.body && typeof opts.body !== 'string') {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    let res;
    try {
      res = await fetch(path, opts);
    } catch (e) {
      return { data: null, error: { message: 'Network error — check your connection.', status: 0 } };
    }
    let payload = {};
    try {
      payload = await res.json();
    } catch (e) {}
    if (!res.ok) {
      return {
        data: null,
        error: { message: payload.error || 'Request failed (' + res.status + ')', status: res.status },
      };
    }
    return { data: payload, error: null };
  }

  const listeners = [];

  function emit(event, session) {
    for (const fn of listeners) {
      try {
        fn(event, session);
      } catch (e) {}
    }
  }

  const auth = {
    async signUp({ email, password }) {
      const out = await request('/api/auth/register', {
        method: 'POST',
        body: { email, password },
      });
      if (!out.error) emit('SIGNED_IN', out.data.session);
      return out;
    },

    async signInWithPassword({ email, password }) {
      const out = await request('/api/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      if (!out.error) emit('SIGNED_IN', out.data.session);
      return out;
    },

    async signOut() {
      const out = await request('/api/auth/logout', { method: 'POST' });
      emit('SIGNED_OUT', null);
      return { error: out.error };
    },

    async getSession() {
      const out = await request('/api/auth/me', { method: 'GET' });
      if (out.error || !out.data || !out.data.session) {
        return { data: { session: null }, error: null };
      }
      return { data: { session: out.data.session }, error: null };
    },

    async getUser() {
      const out = await request('/api/auth/me', { method: 'GET' });
      if (out.error || !out.data || !out.data.user) {
        return { data: { user: null }, error: null };
      }
      return { data: { user: out.data.user }, error: null };
    },

    onAuthStateChange(callback) {
      listeners.push(callback);
      auth.getSession().then(({ data }) => {
        callback(data.session ? 'SIGNED_IN' : 'SIGNED_OUT', data.session);
      });
      return {
        data: {
          subscription: {
            unsubscribe() {
              const i = listeners.indexOf(callback);
              if (i >= 0) listeners.splice(i, 1);
            },
          },
        },
      };
    },
  };

  window.SpimAuth = { request, auth };
  window.supabase = { auth };
})();
