# Architecture gate

Runs on every push to `master` and every PR via
`.github/workflows/architecture.yml`. It is static analysis only — no traffic,
no load tests, no deployment. Everything lives under `.github/`, which
`deploy.sh` strips from the published site.

Run all three checks locally from the repository root:

```sh
npx --yes dependency-cruiser@18.8.0 js functions \
  --config .github/architecture/.dependency-cruiser.cjs --output-type err

npx --yes jscpd@5.4.3 js functions --ignore "js/vendor/**" \
  --min-lines 5 --min-tokens 40 --threshold 8 --reporters console

node .github/architecture/check-budget.cjs
```

## 1. Dependency rules (`.dependency-cruiser.cjs`)

`error` rules describe boundaries the code already respects:

- no dependency cycles;
- no imports that cannot be resolved (the browser's `/pkg/spim_wasm.js`
  import is server-resolved and deliberately exempt);
- browser code in `js/` never imports from `functions/`;
- capsules never import from the `functions/api` domain;
- auth/Seam routes never import another domain's route helpers.

`warn` rules track known coupling without blocking PRs:

- Seam routes import from both `functions/api/_lib.js` and
  `functions/api/seam/_lib.js`. Six files do this today. When the two libs
  are consolidated, delete that rule — the warnings disappearing is the
  signal that the cleanup worked.

## 2. Duplication ratchet

`jscpd` reports duplicated lines/tokens across `js/` and `functions/`
(excluding the minified QR vendor file). The baseline on 2026-11-20 was
**6.15% tokens / 6.60% lines**; the gate fails above **8%**. Lower the
threshold as duplication is removed, and never raise it without recording
why in a PR.

## 3. Asset budget (`budgets.json`)

Per-file byte caps with about 15% headroom over the measured baseline.
`js/seam-client.js` is capped tightly on purpose: it is a 1,369-line module
mixing crypto, state, networking, polling, and DOM rendering, so growth is a
signal to split it rather than raise the cap. There is also a generic 50 KB
cap for any new file under `js/`, `css/`, or `pkg/`, plus aggregate budgets.

## What this gate does *not* claim

It cannot measure throughput, latency, KV contention, cache hit ratio, or
D1 write behaviour under load. It checks structure and size only. Runtime
scaling questions still need their own evaluation.
