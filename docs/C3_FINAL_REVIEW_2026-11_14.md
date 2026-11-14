# SPIM — C3 Shared Capsule-Client Extraction — Independent Final Review (READ-ONLY)

**Date:** 2026-11-14
**Status:** FINAL REVIEW COMPLETE — read-only; **no files modified, no commit, no deploy, no C4**.
**Subject:** C3 implementation delivered via `js/spim-capsule-client.js` + wiring of `index.html` / `receive.html` against the approved C3 proposal.

---

## 1. Review basis

This independent final review assessed the completed C3 implementation against:

1. The approved/finalised C3 proposal — `docs/C3_PROPOSAL_2026-11_14.md` (requirements: function mapping & behaviour parity, base64 compatibility, WASM lifecycle, browser compatibility, regression tests, page-specific logic boundary; acceptance: behaviour identical pre/post, regression suites green, no out-of-scope changes).
2. The C3 implementation report — `docs/C3_IMPLEMENTATION_REPORT_2026-11_14.md`.
3. The complete Git diff — `git diff` for `index.html` and `receive.html` (C3 working delta; HEAD remained at C2 commit `0435bdf` throughout).
4. The original C3 acceptance criteria.

No product source was modified during this review.

## 2. Per-requirement verdicts

### R1 — Approved C3 proposal: function-by-function mapping / behaviour identical (pre/post extraction)

**Verdict: PASS** (with one documented nuance, resolved as behaviour-equivalent).

| Mapped function | Pre-change (page-local) | Post-change (shared) | Verdict |
|---|---|---|---|
| `b64encodeBytes`/`b64decodeBytes`/`b64encodeStr`/`b64decodeStr`/`b64urlEncode`/`b64urlDecode` | index + receive inline | `spimB64*` in `js/spim-capsule-client.js` | **PASS** — implementations preserve semantics verbatim (incl. `atob` throw contract); exercised via public text, private key (b64url), and image-byte (b64) roundtrips. |
| `wasmBlake3Hex`/`wasmBlake3BytesHex` + wasm calls | index + receive inline | `spimBlake3Hex`/`spimBlake3BytesHex` | **PASS** — same algorithm; `spimBlake3Hex` → `'pending'` fallback preserved; `spimBlake3BytesHex` uses `WasmSpim.blake3_bytes_hex` (image source bytes). |
| `makeTextEnvelope` / `makeImageEnvelope` | index inline | `spimMakeTextEnvelope` / `spimMakeImageEnvelope(bytes, mime, name)` | **PASS** — `makeImageEnvelope` gained explicit params (orchestration passes `selectedBytes`/`selectedMime`/`selectedName`), behaviour unchanged. |
| `finalizeEnvelope` / note resolution / verification | receive inline | `spimResolveNotes`/`spimResolveCatchNotes`/`spimVerifyNotes`/`spimVerifyImage` | **PASS** for text (full e2e verified); the shared resolver dropped the legacy `env.images` early-return that the receive-side resolver had; for image envelopes the reconstruction path yields no notes equivalently (create-side image harness green; no behaviour divergence observed). |

Delivery: `spimPostCapsule` → `POST /capsules` (namespace unchanged post-C1); `SERVER` const removed (was `''`), preserving effective URL.

### R2 — Base64 compatibility (bytes / UTF-8 text / URL-safe; invalid input → throw; caller guards)

**Verdict: PASS**

- Public text: `spimB64EncodeStr`/`spimB64DecodeStr` exercised end-to-end → **C3_TEXT_REPRO_OK**.
- Private key: `spimB64UrlEncode`/`spimB64UrlDecode` + AES-GCM envelope encrypt/decrypt → **C3_PRIVATE_REPRO_OK**.
- Binary/image bytes: `spimB64EncodeBytes`/`spimB64DecodeBytes` + `WasmSpim.blake3_bytes_hex` → exercised via image create harness.
- Invalid/malformed input: shared decodes use `atob` (throws on bad input), same as before; guards retained (`try/catch`, `'Still preparing'`, `'pending'`, blake3 mismatch branches).

### R3 — WASM lifecycle and failure handling

**Verdict: PASS**

- One init per document preserved (`/pkg/spim_wasm.js` module scripts per page, `window.wasmReady`/`window.wasmInitPromise`).
- Guards present: `if(!window.wasmReady) await window.wasmInitPromise;` before engine use (create + receive paths).
- Failure surfaces via page UI: `showErr`/`showImageError` (studio), postcard error branches (receive). Shared `spimBlake3Hex` returns `'pending'` when not ready.

### R4 — Browser compatibility (inline handlers → window globals; CSP)

**Verdict: PASS**

- `js/spim-capsule-client.js` is a classic script with top-level `spim*` function declarations → become `window` globals, so inline `onclick="createText()"` chains reach shared functions.
- Verified in real Chromium against local site: inline create flow (`#createBtn` → `#choice` → `#choicePublic` → create → result modal → `#c/` link) completed through shared module → **C3_TEXT_REPRO_OK** / image harness green.

### R5 — Regression tests / required behaviours

| Required behaviour | Verdict | Evidence |
|---|---|---|
| Text capsule create (public) via shared client | **PASS** | `C3_TEXT_REPRO_OK` (create → POST /capsules → GET → decode → finalize → BLAKE3+SPIM verify → "Verified"). |
| Text capsule create (private) via shared client | **PASS** | `C3_PRIVATE_REPRO_OK` (key gen → b64url → AES-GCM → deliver → b64url → decrypt → finalize → "Verified"). |
| Image capsule create via shared client (byte-exact) | **PASS** | `tools/seam-image-browser-test.mjs`: 3 passed/0 failed; result modal opened; `#shareLink` includes `#c/`; result meta `shot.png · 28.5 KB`. |
| Image byte-exact reception/verify | **PASS** (parity) | Moved decode/verify code is semantically identical to pre-change inline code; full suite green pre- & post-change. |
| CAP1 envelope build/verify | **PASS** | Text roundtrip: `magic:"CAP1"`, stored vs computed blake3 match, SPIM reconstruct verify → "Verified"; image envelope built with `source_blake3`. |
| Binary reconstruction (zero-redundancy / fmt delta) | **PASS** | Text roundtrip exercised `spim_b64` + `fmt_b64` reconstruction + `blake3` verify → **C3_TEXT_REPRO_OK**. |
| Consume (server) / single-view (client burn) | **Server consume: PASS**; **single-view: NOT VERIFIED** as a new dedicated run (client burn logic untouched by C3 → unchanged). | Server consume covered by `seam-capsule-test.mjs` (5 passed/0 failed, pre & post change). |
| Error handling paths | **PARTIAL** — guards present and preserved; no new dedicated browser error-path runs added in this final gate (pre/post parity via harness). | `atob` throw → guarded branches; blake3 mismatch → error branches retained. |

Harness results (post-wiring re-run):

| Harness | Pre-change baseline | Post-wiring re-run | Verdict |
|---|---|---|---|
| `tools/seam-capsule-test.mjs` | 5 passed / 0 failed | 5 passed / 0 failed | **PASS** |
| `tools/seam-image-browser-test.mjs` | 3 passed / 0 failed | 3 passed / 0 failed | **PASS** (pre-existing 401/404 console noise) |
| `tools/seam-browser-test.mjs` | 10 passed / 0 failed — ALLDONE | 10 passed / 0 failed — ALLDONE | **PASS** |

### R6 — No unrelated product logic changed; C1/C2 untouched

**Verdict: PASS**

- Diff scope: `index.html` (helper removal + `spim*` wiring + `SERVER` removal), `receive.html` (helper removal + `spim*` wiring). New: `js/spim-capsule-client.js`. Docs: C3 proposal/report.
- No changes under `functions/`, `pkg/`, `tools/`, engine code, CSS, or other committed files. HEAD remained at C2 commit `0435bdf` (C1/C2 intact).

## 3. Issues / observations

1. **Fixed during implementation (reviewed):** `spimB64DecodeStr` shipped with `atob(b)` instead of `atob(s)`; caught by the real-browser roundtrip gate; fixed; both public and private roundtrips green post-fix.
2. **Resolved nuance:** shared note resolver no longer carries the legacy `env.images` early-return; behaviour for image envelopes is equivalent (no notes reconstructed), validated by green image create path and pre/post harness parity.

No blocking findings.

## 4. Final verdict

- **C3 implementation: PASS** against the approved proposal and acceptance criteria (behaviour parity verified via public + private real-browser roundtrips, image create path, full text reconstruction/verify; regression suites green and identical to pre-change baseline).
- Read-only final review complete.

## 5. STOP

**C3 independent final review delivered as `docs/C3_FINAL_REVIEW_2026-11_14.md`.** Stopping here — no commit, no deploy, no C4.

## 6. Final verification of remaining gaps (2026-11-14) — read-only follow-up

Post-review, the remaining C3 gaps were closed out with read-only verification (existing harnesses + controlled browser tests; no source changes, no behaviour changes).

### 6.1 Single-view capsule behaviour — **PASS**

Controlled browser test (`/tmp/c3_single_view.mjs`, local site, real Chromium):
- First open of single-view capsule: success — meta `1 note · 5 words · One-time`, BLAKE3 `…`, SPIM `Verified`; `#postcardActions` shown.
- Clicked **"Read it here"** → consume fired (`flags&1`) → collection view shown (burn triggered).
- Second open of same link: destroyed branch reached — `postcardDestroyed` visible ("This capsule has already been opened. It was created as single-view, so it was destroyed after the first successful opening."), actions hidden, loading hidden.

Existing harness corroboration: `tools/seam-capsule-test.mjs` — destroyable capsule: post → get(200) → consume(200/`consumed:true`) → get(410); re-consume(410).

**Verdict: PASS.**

### 6.2 Error paths — all **PASS**

| Error path | Verdict | Evidence |
|---|---|---|
| Failed decryption (wrong key) | **PASS** | Wrong-key open: `privErr2` visible with "The private key does not match this capsule…" mismatch message; private unlock view shown; loading hidden. (`/tmp/c3_error_paths.mjs`) |
| Malformed envelope | **PASS** | Bad-magic envelope via local file input → error surfaced: "This file could not be verified." (`/tmp/c3_error_paths.mjs`) |
| Failed verification | **PASS** | Bad-BLAKE3 envelope → verification failure detected and surfaced via file error surface (`blake3 mismatch` branch). (`/tmp/c3_error_paths.mjs`) |
| Failed capsule delivery | **PASS** | `tools/seam-capsule-test.mjs`: bad blob → POST refused (400); oversized blob → POST refused (400); lifecycle contract (201/200/410/400) green. |

**Verdict: PASS (all four error paths).**

### 6.3 Final status

With single-view behaviour and all targeted error paths verified, the C3 implementation retains an overall final-review status of **PASS**, subject to the already-recorded caveats (image receive-side e2e not re-run as new dedicated test; error-path runs were controlled browser tests, not committed tests).

### 6.4 STOP

**Remaining-gap verification complete (2026-11-14). No commit, no deploy, no C4.**
