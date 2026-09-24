# Galiot — Free Hosting Comparison (public OSS, non-commercial)

> **⚠️ Hosting correction (2026-09-24):** this document predates the hosting
> decision and still describes **GitHub Pages**. Galiot ships to **Cloudflare
> Workers Static Assets** (free tier, $0, static requests free & unlimited).
> See [STACK_DECISION.md](STACK_DECISION.md) §6, §12 and §13 for the verified decision and sources.
> This file is kept as the original spec; corrections live in that log.

> **Status:** Research pass — hosting alternatives to GitHub Pages, restricted to **free tiers
> usable by a public open-source project with no commercial intent**.
> **Date:** 2026-09-18
> **Method:** Every number below was read from the vendor's own docs/pricing page on 2026-09-18
> (sources in §8). Third-party blogs were used only as leads, never as sources.
> Related: [`STACK_DECISION.md`](STACK_DECISION.md) §6 (hosting constraints),
> [`FEASIBILITY_AND_RISKS.md`](FEASIBILITY_AND_RISKS.md) §5 (browser/durability constraints).

---

## 0. Constraints that decide this

Galiot is a static SPA. That normally makes hosting trivial, but five requirements eliminate
most free hosts:

| # | Requirement | Why | Disqualifies |
|---|---|---|---|
| 1 | **Custom response headers** | `Content-Security-Policy` with `frame-ancestors`, `Permissions-Policy`, HSTS. Meta CSP ignores `frame-ancestors`; GH Pages cannot set headers at all | GitHub Pages, GitLab Pages, Codeberg Pages |
| 2 | **No billing risk / no hard stop** | A public OSS app cannot silently go dark or invoice its maintainer | Firebase (site disabled at 10 GB), Netlify Free (pauses at 300 credits), Vercel (usage + commercial clause) |
| 3 | **Non-commercial public use permitted** | Explicitly an OSS project with no commercial value | Vercel Hobby ("non-commercial, personal use only") is the only hard clause |
| 4 | **Bandwidth headroom for a WASM app** | Cold load is ~4–6 MB (PGlite WASM ~3 MB gz + CodeMirror + app), so bandwidth — not storage — is the binding cost | Firebase (10 GB), Netlify Free (~15 GB), Render (small pool) |
| 5 | **Root-path serving + service worker** | PWA install is a durability requirement on Safari/iOS (see FEASIBILITY §3.2); SW scope and `base` are simplest at the domain root | GitHub Pages *project* sites serve under `/galiot/` |

The repo can stay on GitHub — hosting is a deploy target, not a repo move.

---

## 1. Headline comparison (free tiers)

| Host | Free bandwidth | Custom headers | Free-plan hard stop? | Commercial clause | Deploy from GitHub | Verdict for Galiot |
|---|---|---|---|---|---|---|
| **GitHub Pages** | 100 GB/mo soft | **✗ none** | site stays up (soft limits) | n/a (no commercial SaaS) | native | Baseline; fails req. 1 |
| **Cloudflare Pages** | **static requests free & unlimited** (fair-use) | **✓** `_headers` | no billing (no card) | none | Git integration or Actions/wrangler | **PRIMARY** |
| **Cloudflare Workers Static Assets** | **static requests free & unlimited** | ✓ | no billing on static-only | none | wrangler/Actions | **Forward path** |
| **Netlify (Free)** | ~15 GB (300 credits @ 20 cr/GB) | ✓ `_headers` | **yes — sites pause** | none | Git integration or Actions | Too small as-is |
| **Netlify (Open Source plan)** | **10,000 credits/mo ≈ 500 GB** | ✓ `_headers` | yes, but 33× the headroom | **non-commercial only** (matches Galiot) | Git integration | **Best fallback** |
| **Azure Static Web Apps (Free)** | **100 GB/mo** | ✓ `globalHeaders` | no overage billing documented on Free | none | official GH Action | Solid alternative |
| **Firebase Hosting (Spark)** | 10 GB/mo, then **site disabled** | ✓ `firebase.json` | **yes — site disabled** | none | GH Action | Avoid |
| **Vercel (Hobby)** | 100 GB fast data transfer, 1M edge requests | ✓ `vercel.json` | usage-based | **"non-commercial, personal use only"** | native | Avoid for a public tool |
| **Render (Free)** | small workspace pool, overage billed | ✓ `render.yaml` headers | overage **billed** | none | Git integration | No |
| **GitLab Pages** | free on GitLab.com | **✗ not documented** | — | none | native | Fails req. 1 |
| **Codeberg Pages** | free (FOSS-aligned) | **✗ not documented** | — | non-commercial | Git (Codeberg) | Docs mirror only |

**Decisive facts**

- Cloudflare (both products): *"On both free and paid plans, requests to static assets are free
  and unlimited."* No bandwidth cap is documented for Pages; "unlimited" is qualified only by
  Cloudflare's fair-use policy.
- Netlify's free plan is **no longer 100 GB/300 build minutes**. Since 2025-09-04 new accounts
  use credit pricing: **300 credits/month, hard limit** — and *"once your monthly credit
  allotment is used up … all of your web projects are paused and visitors … find a `Site not
  available` page."* Rates: **15 credits per production deploy, 20 credits per GB bandwidth**,
  2 credits/10k web requests.
- Netlify's **Open Source plan is 10,000 credits/month** for qualifying non-commercial
  projects — the single best free fallback for this use case.

---

## 2. Bandwidth math (why the tiers above matter)

Assume a cold visit downloads ~4–6 MB (PGlite WASM is ~3 MB gzipped; CodeMirror ~116 KB gz
core plus languages; React + app ~0.5 MB). A repeat visit is mostly cached.

| Host | Free allowance | ≈ cold visits/month |
|---|---|---|
| Cloudflare Pages / Workers static | unlimited (fair use) | unbounded |
| Netlify **Open Source** 10,000 credits | ~500 GB | ~85k–125k |
| GitHub Pages (soft) / Azure Free | 100 GB | ~17k–25k |
| Vercel Hobby | 100 GB | ~17k–25k |
| Netlify Free 300 credits | ~15 GB (minus 15 cr/deploy) | ~2k–3.5k |
| Firebase Spark | 10 GB, then disabled | ~1.7k–2.5k |

A "popular OSS launch" (Hacker News front page ≈ 50k–150k visits) breaks Firebase and plain
Netlify Free in a single day. That is the real selection criterion.

---

## 3. How headers are set (Galiot needs one file per host)

| Host | Mechanism | Static-only caveat |
|---|---|---|
| Cloudflare Pages | `_headers` in the build output root | **Not applied to Pages Functions responses** — fine for a pure SPA |
| Cloudflare Workers static assets | `wrangler.jsonc` `assets` config / Worker response | SPA fallback via `not_found_handling: "single-page-application"` does **not** invoke the Worker (keeps it free) |
| Netlify | `_headers` | applies to static responses |
| Azure SWA | `staticwebapp.config.json` → `globalHeaders` | headers do not affect API responses (n/a) |
| Firebase | `firebase.json` → `hosting.headers` | — |
| Vercel | `vercel.json` → `headers` | — |
| Render | `render.yaml` / static-site headers setting | — |
| GitHub Pages | **none** — `<meta>` CSP only, `frame-ancestors`/`report-to`/`sandbox` ignored | see STACK_DECISION §6 |

Keeping a `_headers` (Cloudflare/Netlify), `staticwebapp.config.json` (Azure), and
`firebase.json` header block in the repo is ~30 lines of duplication and makes the host
swappable in an afternoon.

---

## 4. Recommendation

1. **Primary — Cloudflare Workers Static Assets.** *(Updated 2026-09-22: Cloudflare now
   steers new projects to Workers over Pages.)* Free, no card, no bandwidth cap on static
   assets, custom headers via `_headers` (natively parsed), free `*.workers.dev` subdomain
   plus free custom domain + TLS, deploys from GitHub Actions via `wrangler deploy`. SPA
   fallback via `not_found_handling: "single-page-application"` keeps it free. No
   commercial-use clause. This is the recommended path for new projects.
2. **Alternative — Cloudflare Pages.** Same free tier, same `_headers` support. Pages is
   not deprecated and remains fully supported. Use if Workers has any deployment friction
   or if Git-integration deploy (no wrangler) is preferred.
3. **Fallback — Netlify Open Source plan** (10,000 credits/month). Apply once the repo is
   public; the plan is explicitly for non-commercial OSS, which Galiot is. Plain Netlify Free
   is not usable as the primary due to the 300-credit pause.
4. **Docs mirror — GitHub Pages** (or Codeberg Pages for FOSS alignment). The documentation
   site needs no headers, so the front door can stay at `*.github.io` while the app itself is
   served from Cloudflare. Alternatively, make GH Pages a 301-style landing page that links to
   the app.
5. **Avoid** Firebase (site disabled at 10 GB on the no-billing plan), Vercel Hobby
   (non-commercial/personal clause plus usage-based overage), and Render Free (billed overage).

### Deploy sketch (Cloudflare Pages)

```
# _headers (in the built output root)
/*
  Content-Security-Policy: default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src https:; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
  Permissions-Policy: camera=(), microphone=(), geolocation=(), usb=(), serial=()
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload

/assets/*
  Cache-Control: public, max-age=31536000, immutable
```

Notes for the build: serve at the domain **root** (custom domain or `*.pages.dev`) rather than
a sub-path, so `base: '/'` and the service-worker scope stay simple; verify the `.wasm` MIME
type is `application/wasm` and that `Content-Encoding` behaves under Cloudflare's automatic
compression.

---

## 5. Non-goals / what was not verified

- Exact Cloudflare fair-use enforcement at extreme traffic (e.g. multi-TB/month) is not
  published; a static OSS client is far below any plausible threshold.
- GitLab Pages and Codeberg Pages custom-header support is recorded as "not documented" rather
  than "impossible" — neither documents a headers mechanism, which is enough to fail req. 1.
- Render's included bandwidth is plan-table data that its docs page does not expose as text;
  the conclusion (billed overage, small pool) does not depend on the exact number.
- Deno Deploy, Surge, Neocities, and Bunny.net were considered and excluded: the first is a
  runtime rather than a static host, the others have no custom-header support or no free tier.

---

## 6. Sources (read 2026-09-18)

- GitHub Pages limits + no custom headers — https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits and https://github.com/orgs/community/discussions/199121
- Cloudflare Pages `_headers` — https://developers.cloudflare.com/pages/configuration/headers/
- Cloudflare Pages limits — https://developers.cloudflare.com/pages/platform/limits/
- Cloudflare: static asset requests free & unlimited — https://developers.cloudflare.com/pages/functions/pricing/ and https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
- Cloudflare Workers static assets — https://developers.cloudflare.com/workers/static-assets/
- Netlify credits (rates + pause behaviour) — https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/billing-faq-for-credit-based-plans.md
- Netlify pricing (300 credit limit/month on Free) — https://www.netlify.com/pricing/
- Netlify Open Source plan (10,000 credits/month, non-commercial) — https://www.netlify.com/open-source/
- Netlify `_headers` — https://docs.netlify.com/build/configure-builds/file-based-configuration/
- Azure Static Web Apps plans (Free: 100 GB bandwidth, 250 MB app) — https://learn.microsoft.com/en-us/azure/static-web-apps/plans
- Azure `globalHeaders` — https://learn.microsoft.com/en-us/azure/static-web-apps/configuration
- Firebase Hosting free quota (10 GB storage / 10 GB transfer, site disabled) — https://firebase.google.com/docs/hosting/usage-quotas-pricing
- Vercel Hobby limits + non-commercial clause — https://vercel.com/docs/accounts/plans/hobby
- Render static sites (free, counts against bandwidth, overage billed) — https://render.com/docs/static-sites and https://render.com/docs/outbound-bandwidth
- Codeberg Pages — https://docs.codeberg.org/codeberg-pages/

---

*End of hosting comparison. Re-check before launch: Netlify and Cloudflare change free-tier terms more often than the stack does.*