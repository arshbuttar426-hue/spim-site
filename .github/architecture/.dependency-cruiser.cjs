/*
 * Architecture rules for the SPIM site.
 *
 * Run from the repository root:
 *   npx dependency-cruiser js functions --config .github/architecture/.dependency-cruiser.cjs
 *
 * These are regression guards, not a rewrite mandate. `error` rules describe
 * boundaries the code already respects. `warn` rules track known coupling so
 * it stays visible without blocking every PR until it is cleaned up.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'A dependency cycle makes module initialisation order fragile.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-unresolved',
      comment: 'An import that cannot be resolved is a broken module graph.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true, pathNot: '^/pkg/spim_wasm\\.js$' },
    },
    {
      name: 'browser-never-imports-server',
      comment: 'Client code must never pull a Pages Function into the browser bundle.',
      severity: 'error',
      from: { path: '^js/' },
      to: { path: '^functions/' },
    },
    {
      name: 'capsules-stay-independent',
      comment: 'Capsules use their own helpers on purpose; keep that domain separate.',
      severity: 'error',
      from: { path: '^functions/capsules/' },
      to: { path: '^functions/api/' },
    },
    {
      name: 'no-domain-cross-imports',
      comment: 'Auth, keys, images and Seam must not import each other’s routes.',
      severity: 'error',
      from: { path: '^functions/api/(auth|seam)/' },
      to: { path: '^functions/api/(connections|dock|images|keys)' },
    },
    {
      name: 'seam-two-libs',
      comment: 'Known coupling: Seam routes import both shared libs. Track, then consolidate.',
      severity: 'warn',
      from: { path: '^functions/api/seam/' },
      to: { path: '^functions/api/_lib\\.js$' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Generated WASM glue and the minified QR vendor file are not authored code.
    exclude: { path: '(^|/)(vendor|pkg)/' },
  },
};
