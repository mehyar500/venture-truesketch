
## Design review — product-build skill, two critique passes (2026-09-16)

### PASS 1 (2026-09-16, ~23:30 EDT)
Evidence: 10 desktop-width screenshots via managed browser (landing hero/scroll/pricing/FAQ+footer, /free, /privacy x2, /terms x3). Browser tool cannot resize viewports, so the 390px mobile critique ran as a DOM/CSS audit.

**5-second test (landing):** all 5 questions answered cleanly — product (AI portrait sketch + reading), audience (self-curious, entertainment), free (free sketch via "Get my free sketch"), paid ($37 full reading), next click (free sketch CTA).

**Findings (fixed):**
1. Mobile header nav overflow at 390px — 5 links + brand clipped (flex, no wrap). FIXED: `.nav-secondary` class + `@media (max-width:600px)` hides secondary links; every page keeps its one essential CTA visible.
2. Mobile hero-gallery 2-col cramped (~165px/column at 390px). FIXED: `@media (max-width:520px)` → 1fr single column.
3. Nav confusion: "Free sketch" (free.html tool) vs "Free preview" (teaser.html samples) — two near-identical labels. FIXED: renamed to "See samples" in index nav + footer, free.html nav, intake.html nav.
4. Robustness: `.hidden` existed only in free.html's page-scoped style block; FIXED: added global `.hidden` utility to styles.css.

**Audit (no issues):** all 45 HTML classes defined (styles.css + page style blocks); all imgs alt'd; all anchors href'd (Contact = mailto:team@mehyar.us); no placeholders/lorem/coming-soon; 7-day redo-or-refund consistent across landing/teaser/intake/terms; subscribe → /api/subscribe (brand + global tables) and /api/unsubscribe both 200-verified earlier; sample sketches vision-clean (no Flux pseudo-text); free/paid gap clear (watermarked free vs print-ready paid + gallery).

**Deployed:** deploy-truesketch.py, "deploy token revoked" confirmed. Verified live: styles.css (nav-secondary present), index.html ("See samples" x2), pages 200 (/free,/teaser 308 clean-URL redirects, normal).

### PASS 2 (2026-09-16, ~23:40 EDT)
Re-critique of the fixed state (same 10 screenshots + source audit): buyer-shoes verdict unchanged — stranger-buyer instantly gets what it is, what's free, why paid is worth it. CSS braces balanced (93/93), zero undefined classes. No new material issues. **Verdict: SHIP.**

## Unstyled-site outage — found + fixed (2026-10-08, Mayor report: "weird UI and broken")
**Root cause:** the 2026-10-05 portfolio-visibility rollout rewrote every page's `<head>` (GTM/GA4, OG, JSON-LD) and dropped `<link rel="stylesheet" href="styles.css">` plus all page-scoped `<style>` blocks. Site rendered fully unstyled 2026-10-05 → 2026-10-08.
**Fix:** stylesheet link restored on all 9 pages (`/styles.css`, root-relative); 6 stripped classes reconstructed in styles.css in the existing token language (`.legal`, `.updated`, `.optin-row`, `.watermarked`, `.wm-tilt`, `.tease-lock`); footer gained centralized mehyar.us Privacy/Terms/Data-Deletion links (compliance scope rule); business address added to /privacy + /terms contact sections. Compliance audit: `~/workspace/product-compliance/audits/truesketch-2026-10-08.md`. **Open decision items for Mayor:** (1) pages promise 7-day redo-or-refund vs standing no-refunds order; (2) "turns your photo into a hand-style AI portrait" meta copy vs selfie-as-style-reference-only contract.
**Deployed:** deploy-truesketch.py ×2, "deploy token revoked" both runs. Verified live: stylesheet link, 6 classes, footer links present.
