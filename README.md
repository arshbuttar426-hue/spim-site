# SPIM capsule site

Production: https://www.spim.co.in  (alternate host: https://capsule.spim.co.in)

A static capsule client (compose, receive, verify) on Cloudflare Pages, with the
capsule API proxied through Pages Functions to a self-hosted VPS origin.

## Layout

- `index.html`, `receive.html`, `images.html`, `account.html`, `login.html`, ... — pages
- `js/` — client crypto/envelope code (WASM-ready, `window.wasmReady`)
- `js/spim-analytics.js` — cookie-free visit counter (included on every page)
- `pkg/` — WASM package assets served by the static site
- `functions/api/hit.js` — `POST /api/hit` (daily visit aggregates in `SPIM_KV`)
- `functions/capsules.js` — `POST /capsules` (create)
- `functions/capsules/[id].js` — `GET /capsules/:id` (fetch)
- `functions/capsules/[id]/consume.js` — `POST /capsules/:id/consume` (destroy)
- `functions/update-origin.js` — `POST /update-origin` (token-protected origin update)
- `wrangler.toml` — Pages project, vars, KV binding

Clean routes are real directories (`receive/index.html` etc.), so there is no SPA
fallback: unknown paths return the Pages 404 page. Extensionless canonical URLs only.

Links are generated as `https://<host>/receive#c/<id>` (public) and
`https://<host>/receive#c/<id>#<key>` (private). The key lives in the fragment and is
never sent to the server.

## Deploy

```
npx wrangler login                       # account arshbuttar426@gmail.com (199e...)
./deploy.sh                              # === npx wrangler pages deploy . --project-name=spim-site --commit-dirty=true
```

Never pass `--branch`: production branch is `master`, and non-`master` uploads
become preview deployments that the custom domain does not serve.

## Ingress

```
browser → www.spim.co.in (Pages + Functions)
        → KV `spim-origin` key `origin`   (namespace 0df622028d884c439f064e3673f4bfe9)
        → https://<random>.trycloudflare.com  (cloudflared quick tunnel on VPS)
        → 127.0.0.1:8080  (/root/server.py, JSON files in /root/capsules)
```

The cloudflared quick tunnel URL changes whenever the tunnel restarts. `spim-report`
on the VPS watches `/root/tunnel.log`, health-checks the new URL, and POSTs it to
`/update-origin` with `x-update-token`. The Pages Function writes it to KV, so the
public site heals itself without a redeploy. A wrong/missing token gets 403; a
non-`https://*.trycloudflare.com` origin gets 400. KV reads can be stale for ~60s,
which shows up briefly as a 530/1033 on `/capsules/*`.

VPS units (enabled, survive reboot):

- `spim-api` — `python3 /root/server.py`, binds `127.0.0.1:8080` only
- `spim-tunnel` — `cloudflared tunnel --url http://127.0.0.1:8080`, logs to `/root/tunnel.log`
- `spim-report` — `/root/report-origin.sh`

Recovery: `systemctl restart spim-tunnel spim-report`, then wait for KV to catch up.

A named tunnel `spim-api` (`4e51ccbd-726f-49e4-b519-448cfe7b110b`) and its
`api.spim.co.in → <id>.cfargotunnel.com` record exist in the zone configuration, and
the unit `/etc/systemd/system/spim-tunnel-named.service` is installed but **disabled**.
It cannot serve traffic until `spim.co.in` is an active Cloudflare zone.

## DNS and certificates

GoDaddy DNS for `spim.co.in`:

- `CNAME www → spim-site.pages.dev` (TTL 600)
- `CNAME capsule → spim-site.pages.dev` (TTL 600)
- `A @ → WebsiteBuilder Site` (GoDaddy builder, unchanged)
- `TXT _dmarc`, `CNAME _domainconnect` (unchanged)

Both hostnames are registered as Pages custom domains in the `spim-site` project and
report active with Google Trust Services certificates.

### Zone migration attempt (2026-10-26) — aborted

Moving the zone to Cloudflare was attempted so the apex could point at Pages and the
API could use a named tunnel. Sequence: zone created (Free, full setup, NS
`carioca.ns.cloudflare.com` / `gannon.ns.cloudflare.com`), records pre-created, apex
added as a Pages custom domain, then nameservers switched at GoDaddy.

The Cloudflare zone stayed in `initializing` (meta step 1) for over an hour; both
assigned nameservers returned `REFUSED` for the zone, so public resolution failed even
though the registry delegated to them. Nameservers were switched back to
`ns61/ns62.domaincontrol.com`; service returned and the apex Pages domain was removed.
The zone object was deleted and re-created once, landing in the same `initializing`
state, so the failure is in zone provisioning for this account, not the DNS records.

Before any retry: create the zone, wait until its status is `pending` (not
`initializing`) and its nameservers actually answer, **then** switch registrar
nameservers. Switching first is what caused the outage.

## Analytics

First-party only: no third-party script, no cookies, no IPs.

- Each page includes `/js/spim-analytics.js`. It keeps a random id in
  `localStorage` (`spim_sid`), respects Do Not Track, and sends one `POST /api/hit`
  per page load with `{ p: path, r: referrer host, s: sid }`.
- `functions/api/hit.js` ignores known crawler user-agents and requires the JS id, so
  scanners and non-JS bots are not counted. Daily aggregates are stored in `SPIM_KV`
  as `stats:day:<YYYY-MM-DD>`:
  `{ views, visitors: { <sid>: 1 }, paths: {}, refs: {} }` (400-day TTL).
- Reads are eventually consistent (~60s) and the read-modify-write assumes low
  traffic. Tracking starts 2026-11-10; earlier traffic has no visit data.

```
npx wrangler kv key list --namespace-id=0df622028d884c439f064e3673f4bfe9 --remote
npx wrangler kv key get stats:day:2026-11-10 --namespace-id=0df622028d884c439f064e3673f4bfe9 --remote
```

## Accounts / history

- Active Cloudflare account: `199e010ed36c3bfc2827626960665eff` (arshbuttar426@gmail.com)
- Legacy project `s-pim` lives in an inaccessible account
  (`a85472514bff02a529b31ff380d52776`, thebuttarsh@gmail.com). Its alias serves an old
  Terminal build; do not point DNS there.
- Source was recovered from legacy deployment `9d2a0337` into this repo.
- This repository is local-only. `wrangler.toml` contains the origin-update token, so
  do not push it to a public remote without moving that value to a Pages secret.

## Known gaps

- Apex `spim.co.in` still serves the GoDaddy Website Builder page. Options: GoDaddy
  dashboard forwarding to `https://www.spim.co.in` (no public API), or a proper zone
  migration once Cloudflare provisions the zone.
- Upstream origin is a single VPS behind a quick tunnel; there is no second origin.
- KV origin updates are eventually consistent (~60s).

## Verification

Do not claim success from HTTP 200 alone, and do not trust DOM presence alone — a
missing closing tag once nested the whole receive page inside the hidden mobile nav,
so the page was blank while every DOM-based check still passed. A passing run checks,
in a real browser against the public hostname with zero console errors:

1. painted layout — for each route the body height is sane and the postcard /
   collection / image element has a non-zero rect, no hidden ancestor, and is the hit
   target at its centre
2. public text — 5 notes with Unicode, newlines and trailing spaces stored exactly,
   rendered, and shown as `Verified`
3. private text — ciphertext-only on the wire, exact plaintext after decrypt, 43-char
   key in the fragment, wrong key rejected
4. public PNG — byte-exact reconstruction (SHA-256 match), rendered, `Verified`
5. images — PNG, JPEG and WebP, public and private: exact bytes, painted render,
   wrong key rejected
6. single-use — 200 before open, 410 `{"error":"destroyed"}` after, destroyed UI on revisit

The `div` open/close counts in every page must also match; a single missing `</div>`
is enough to blank a page.
