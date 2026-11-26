/*
 * Session-aware chrome.
 *
 * Every themed page ships this. It resolves the signed-in user from the
 * HttpOnly session cookie via /api/auth/me, swaps the logged-out / logged-in
 * nav sections, fills the account label, wires sign-out, and keeps the tab
 * links marked as current on the home studio.
 */
(function () {
  // Register the offline service worker where supported. Registration is
  // deliberately best-effort: a failed SW must never break online behaviour.
  // The SW itself only caches the static shell and never caches private paths.
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {});
    });
  }

  // Minimal, honest offline notice. Local .spim files keep working offline;
  // server-backed features do not. Never imply those features are available.
  var offlineBanner;
  function updateOfflineBanner() {
    if (!offlineBanner) {
      offlineBanner = document.createElement('div');
      offlineBanner.setAttribute('role', 'status');
      offlineBanner.setAttribute('data-spim-offline', '');
      offlineBanner.textContent = 'You are offline. Local .spim files still open; accounts, capsules and chats need a connection.';
      offlineBanner.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;' +
        'padding:10px 16px;background:#1b2330;color:#e7e9ee;border-top:1px solid #33405a;' +
        'font:13px/1.5 system-ui,sans-serif;text-align:center';
    }
    if (navigator.onLine === false) {
      if (!offlineBanner.parentNode) document.body.appendChild(offlineBanner);
    } else if (offlineBanner.parentNode) {
      offlineBanner.parentNode.removeChild(offlineBanner);
    }
  }

  function qsa(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function setVisible(el, visible) {
    if (!el) return;
    el.hidden = !visible;
    el.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  function applyNav(user) {
    qsa('[data-auth="out"]').forEach(function (el) {
      setVisible(el, !user);
    });
    qsa('[data-auth="in"]').forEach(function (el) {
      setVisible(el, !!user);
    });
    if (user) {
      qsa('[data-auth-email]').forEach(function (el) {
        el.textContent = user.email || 'Account';
      });
      qsa('[data-auth-initial]').forEach(function (el) {
        el.textContent = (user.email || 'A').charAt(0).toUpperCase();
      });
    }
    document.documentElement.setAttribute('data-signed-in', user ? 'true' : 'false');
  }

  function markCurrent() {
    var path = location.pathname.replace(/\/+$/, '') || '/';
    var hash = location.hash || '';
    var key = null;
    if (path === '/' || path === '/index.html') {
      if (hash === '#text' || hash === '#image' || hash === '#beam' || hash === '#catch') {
        key = hash.slice(1);
      } else {
        key = 'text';
      }
    } else if (path === '/why') key = 'why';
    else if (path === '/support') key = 'support';
    else if (path === '/account') key = 'account';

    qsa('a[data-nav]').forEach(function (a) {
      if (key && a.getAttribute('data-nav') === key) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  function wireSignOut() {
    qsa('[data-auth-signout]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        try {
          await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
        } catch (e) {}
        location.href = '/';
      });
    });
  }

  async function boot() {
    wireSignOut();
    markCurrent();
    updateOfflineBanner();
    window.addEventListener('online', updateOfflineBanner);
    window.addEventListener('offline', updateOfflineBanner);
    window.addEventListener('hashchange', markCurrent);
    window.addEventListener('spim:tab', markCurrent);

    let user = null;
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      if (res.ok) {
        const body = await res.json();
        user = body.user || null;
      }
    } catch (e) {}
    applyNav(user);
    window.dispatchEvent(new CustomEvent('spim:session', { detail: { user: user } }));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
