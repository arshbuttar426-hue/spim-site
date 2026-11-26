/*
 * dock-client.js — client-only Dock key handling.
 *
 * The Dock server stores a capsule reference (id + private marker) and never a
 * link. Private links are rebuilt here from a key kept only in this browser's
 * localStorage, so no private key is sent to or returned by the server.
 */
(function (global) {
  'use strict';

  function pendingKey(userId) { return 'spim_dock_pending:' + (userId || 'anon'); }
  function keysKey(userId) { return 'spim_dock_keys:' + (userId || 'anon'); }

  function readJSON(key, fallback) {
    try {
      var v = JSON.parse(global.localStorage.getItem(key));
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    try { global.localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }
  function readMap(userId) {
    var m = readJSON(keysKey(userId), {});
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  }

  function saveKey(userId, capsuleId, keyB64) {
    if (!capsuleId || !keyB64 || typeof keyB64 !== 'string') return false;
    var m = readMap(userId);
    m[capsuleId] = keyB64;
    return writeJSON(keysKey(userId), m);
  }
  function getKey(userId, capsuleId) {
    var v = readMap(userId)[capsuleId];
    return typeof v === 'string' ? v : '';
  }
  function removeKey(userId, capsuleId) {
    var m = readMap(userId);
    if (Object.prototype.hasOwnProperty.call(m, capsuleId)) {
      delete m[capsuleId];
      writeJSON(keysKey(userId), m);
    }
  }

  /* Older Dock rows carried the full private link. Move any key they contain
   * into the local key store and drop the link, so legacy data is not echoed. */
  function migratePending(userId) {
    var key = pendingKey(userId);
    var parsed = readJSON(key, []);
    var list = Array.isArray(parsed) ? parsed : [];
    var changed = false;
    var cleaned = list.map(function (item) {
      if (!item || typeof item !== 'object' || !item.link) return item;
      var out = Object.assign({}, item);
      var m = String(out.link).match(/#c\/[A-Za-z0-9_-]{6,16}(?:#([^\s#]+))?/);
      if (m && m[1] && m[1].length >= 20 && out.capsule_id) {
        saveKey(userId, out.capsule_id, m[1]);
      }
      delete out.link;
      changed = true;
      return out;
    });
    if (changed) writeJSON(key, cleaned);
    return cleaned;
  }

  function linkFor(userId, item) {
    if (!item || !item.capsule_id || !/^[A-Za-z0-9_-]{6,16}$/.test(item.capsule_id)) return null;
    var key = item.private ? getKey(userId, item.capsule_id) : '';
    if (item.private && !key) return null;
    return global.location.origin + '/receive#c/' + item.capsule_id + (key ? '#' + key : '');
  }

  global.DockClient = {
    pendingKey: pendingKey,
    saveKey: saveKey,
    getKey: getKey,
    removeKey: removeKey,
    migratePending: migratePending,
    linkFor: linkFor
  };
})(window);
