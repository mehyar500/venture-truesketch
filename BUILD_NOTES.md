
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
