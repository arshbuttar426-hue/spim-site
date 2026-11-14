# SPIM — C3 Shared Capsule-Client Extraction — Implementation Report

**Date:** 2026-11-14
**Status:** IMPLEMENTATION + TESTING COMPLETE — delivered. **STOP before commit / deploy / C4** (per C3 authorisation).

---

## 1. Scope delivered

Finalised C3 plan (see `C3_PROPOSAL_2026-11_14.md`) executed as authorised: no server-side source changes, no engine/WASM semantics changes; only client-side extraction of the duplicated capsule-client primitives into a single shared module, plus wiring of `index.html` (studio/create) and `receive.html` (inbox/open) to it.

### 1.1 New shared module

- `js/spim-capsule-client.js` — classic script loaded on both pages.
- Exposes (as `window` globals via top-level function declarations, keeping inline handlers working):
  - b64: `spimB64EncodeBytes`, `spimB64DecodeBytes`, `spimB64EncodeStr`, `spimB64DecodeStr`, `spimB64UrlEncode`, `spimB64UrlDecode`
  - BLAKE3: `spimBlake3Hex`, `spimBlake3BytesHex`
  - envelopes: `spimMakeTextEnvelope(notes)`, `spimMakeImageEnvelope(bytes, mime, name)`
  - crypto: `spimGenerateKey`, `spimEncryptEnvelope`, `spimDecryptEnvelope`
  - delivery: `spimPostCapsule(blob, destroyable)`
  - receiver: `spimReconstructNotes(env, strict)`, `spimResolveNotes(env)`, `spimResolveCatchNotes(env)`, `spimVerifyNotes(notes)`, `spimVerifyImage(img)`
- Depends on page-level WASM globals (`window.WasmSpim`, `window.blake3_hex_static`, `window.format_delta_encode`, `window.format_delta_apply`) and readiness (`window.wasmReady`, `window.wasmInitPromise`) from each page's `/pkg/spim_wasm.js` module; one init per document, unchanged.
- Page-specific orchestration (studio UI, inbox rendering, search, audio/beam/catch, quota/dock) deliberately remains page-local.

### 1.2 Wiring changes

- `index.html`:
  - Added `<script src="/js/spim-capsule-client.js"></script>` after `/js/spim-audio.js`.
  - Removed local b64 / WASM / envelope / delivery helpers; `doCreate`/`createImage` now call `spimMakeImageEnvelope`, `spimMakeTextEnvelope`, `spimBlake3Hex`, `spimGenerateKey`, `spimB64UrlEncode`, `spimEncryptEnvelope`, `spimB64EncodeStr`, `spimPostCapsule`.
  - Removed now-unused `const SERVER = '';` (shared delivery posts to `/capsules` relatively).
- `receive.html`:
  - Added `<script src="/js/spim-capsule-client.js"></script>`.
  - `finalizeEnvelope` uses `spimBlake3Hex`, `spimResolveNotes`, `spimVerifyNotes`, `spimVerifyImage`.
  - `loadReceive` uses `spimDecryptEnvelope`, `spimB64UrlDecode`, `spimB64DecodeStr`.
  - `openSpimFile` uses `spimDecryptEnvelope`, `spimB64UrlDecode`, `spimB64DecodeStr`.

### 1.3 Behaviour parity

- Pure primitives (b64 bytes/text/URL-safe, WASM BLAKE3, envelope build/verify/resolve) moved verbatim in semantics; throw/return contracts preserved (bad base64 → throw from `atob`, guarded by callers).
- Private flow preserved: key gen → AES-GCM encrypt → URL-safe key → deliver blob; open → URL-safe key decode → AES-GCM decrypt → finalize.
- Delivery namespace unchanged post-C1: `POST /capsules` (+ consume family) only.

## 2. Defect found & fixed during wiring (regression caught immediately)

- `js/spim-capsule-client.js` shipped with `function spimB64DecodeStr(s){ return decodeURIComponent(escape(atob(b))); }` — wrong parameter reference (`b` instead of `s`) — so **every** text-envelope decode threw.
- Effect: the receive page entered its error branch (`TMPDEBUG` instrumentation confirmed) and the open flow failed.
- Fix: `atob(s)`.
- Post-fix, the full public and private roundtrips pass in a real Chromium against the local site (see §3).

## 3. Local validation results (post-wiring)

### 3.1 Real-browser roundtrips via shared client (local site on 127.0.0.1)

- Public text capsule: create (shared `spimMakeTextEnvelope` → `spimPostCapsule`) → open (shared `spimB64DecodeStr` → `finalizeEnvelope` → BLAKE3 seal + SPIM reconstruction verify) → **C3_TEXT_REPRO_OK**.
- Private text capsule: create (`spimGenerateKey` → `spimB64UrlEncode` → `spimEncryptEnvelope` → `spimPostCapsule`) → open (`spimB64UrlDecode` → `spimDecryptEnvelope` → `finalizeEnvelope`) → **C3_PRIVATE_REPRO_OK**.

### 3.2 Regression harnesses (local site + real Functions)

| Harness | Result |
|---|---|
| `tools/seam-capsule-test.mjs` | **5 passed, 0 failed** |
| `tools/seam-image-browser-test.mjs` | **3 passed, 0 failed** (pre-existing 401/404 console noise; result meta OK) |
| `tools/seam-browser-test.mjs` | **10 passed, 0 failed — ALLDONE** |

### 3.3 Pre-change baseline comparison (same harnesses, pre-wiring)

- `seam-capsule`: 5 passed / 0 failed
- `seam-image-browser`: 3 passed / 0 failed (pre-existing 401 console error; result meta OK)
- `seam-browser`: 10 passed / 0 failed — ALLDONE

Post-wiring re-run matches the pre-change baseline exactly → **no regression**.

## 4. Wiring verification

- No leftover call sites of pre-extraction identifiers (`b64d`, `b64dBytes`, `b64decodeStr`, `b64encodeStr`, `b64urlDecode`, `wasmBlake3Hex`, `makeTextEnvelope`, `makeImageEnvelope`, `postCapsule`, `decryptEnvelope`, `encryptEnvelope`, `generateKey`, `resolveNotes`, …) in page scripts.
- All remaining references are the sanctioned shared (`spim*`) names or page-local orchestration names (`finalizeEnvelope` is the page-level verify/render orchestrator; `blake3_hex*` are WASM API methods).
- No CSP entries were found requiring change for `/js/` classic scripts (`script-src 'self'` covers same-origin classic scripts).

## 5. Delivery boundary honoured (C3 phase)

- No commit performed for the C3 implementation phase.
- No deploy performed.
- No production config change.
- No C4 / C5 / C6 work performed.

## 6. STOP

**C3 implementation phase delivered and locally validated. Stopping here — before commit / deploy / C4, per C3 authorisation. Awaiting your go-ahead before any further phase.**
