---
name: LedgerLens
description: A spreadsheet-intuitive, web-automated personal asset console with explicit financial truth boundaries.
themes:
  default: light
  persistentPreference: ledgerlens-theme
colors:
  light:
    ground: "#f3f4ef"
    surface: "#ffffff"
    surface-muted: "#eef0ea"
    ink: "#171a18"
    muted: "#596158"
    quiet: "#646c64"
    line: "#dde0d8"
    accent: "#647d17"
  dark:
    ground: "#0b0e0c"
    surface: "#111512"
    surface-muted: "#181d19"
    ink: "#f4f7ef"
    muted: "#afb7aa"
    quiet: "#8b9588"
    line: "#292f2a"
    accent: "#d4fb4c"
  categories:
    cash: "violet"
    deposits: "pink"
    pension-insurance: "mint"
    equities: "lime"
    other: "neutral"
typography:
  family: '"Pretendard Variable", Pretendard, "Noto Sans KR", "Segoe UI", sans-serif'
  hero: "clamp(2rem, 4vw, 4.1rem) / 0.98 / 820"
  total: "clamp(1.7rem, 2.8vw, 3rem) / 1 / 770"
  section: "1.08rem / 1.3 / 760"
  body: "15px / 1.55 / 400"
rounded:
  control: "8px"
  grouped: "12px"
  kpi-mobile-panel: "14px"
  panel: "16px"
  hero: "20px"
  status: "999px"
---

# Design System: LedgerLens

## Creative north star

**The Personal Asset Console** — the scanability of a well-built asset spreadsheet, upgraded with web-native synchronization, responsive charts, explicit data states, and accessible drill-downs.

LedgerLens is analytical, not promotional. The light theme is a warm editorial ledger; the dark theme is a charcoal portfolio console with restrained lime accents. Both themes share the same hierarchy and category identity. Large totals establish orientation, compact KPI cards establish composition, and ledgers/charts provide evidence. The interface never turns missing data into a financial claim.

## Product and truth principles

- The primary total is **current registered valuation**, not investment performance.
- Toss-tracked securities and manually registered assets are visibly distinguished.
- Whole-asset history is shown only when both saved history and the current manual-asset source are reliable. Otherwise, use the explicitly labeled saved-securities fallback.
- Market allocation must not be called sector allocation until sector metadata exists.
- Account period change is not realized profit and loss. Do not infer taxes, dividends, fees, or trade-level attribution without a supported ledger.
- Order execution and automated trading are outside the product boundary. LedgerLens remains read-only.
- Demo, live, relay, unavailable, empty, loading, and insufficient-history states need explicit text; color alone is never status evidence.

## Themes and color

Light is the default and must be present in server-rendered HTML. The boot script may read only `ledgerlens-theme` and set `data-theme="dark"` before paint to prevent a flash of the wrong theme. The navigation control persists the explicit user choice.

Semantic tokens in `app/globals.css` are the source of truth. Components must consume tokens rather than hard-coded light colors.

- `--ground`, `--surface`, `--surface-muted`, `--panel-tint`: canvas and analytical layers.
- `--ink`, `--muted`, `--quiet`: text hierarchy. Light `--quiet` is intentionally `#646c64` so small analytical labels meet normal-text contrast on muted surfaces.
- `--accent`: active navigation and selection, olive in light and electric lime in dark.
- `--positive`, `--negative`, `--warning`: measured state only, always paired with a sign, label, or shape.
- `--chart-cash`, `--chart-deposit`, `--chart-pension`, `--chart-equity`, `--chart-other`: stable asset-category identity across both themes.

Do not introduce gradients, glass effects, neon bloom, or decorative market-terminal chrome. Dark mode should feel calm and exact, not theatrical.

## Typography and numbers

One Korean-first workhorse sans keeps the console coherent. Hierarchy comes from weight, scale, and alignment rather than decorative type.

- Hero: 32–66px responsive, 820 weight, tight `-0.055em` tracking.
- Total: 27–48px responsive, 770 weight.
- Panel title: about 17px, 760 weight.
- Body: 15px / 1.55.
- Eyebrows, table headers, legends, and qualifiers: compact 10–12px analytical labels. Keep their contrast compliant and consider a 1–2px future increase where density permits.
- All money, quantities, rates, and dates use tabular numerals. Preserve exact decimal strings in domain logic; compact only at display time.

## Layout and information architecture

The content container is fluid up to 1440px. The dashboard reading order is fixed:

1. Whole-asset hero with account/time context and registered total.
2. Four core asset KPIs: cash, deposits, pension/insurance, stocks/ETFs. A nonzero unclassified/other bucket may add a fifth card.
3. Asset allocation donut and monthly whole-asset/saved-securities history.
4. Cash position and deposit/savings maturity ledgers.
5. Market-based stock mix and securities account period change.
6. Top holdings with exact values, return meters, and saved-price sparklines.
7. Three-part trust boundary strip.
8. Collapsed 10-minute Review workspace for the deeper reliability → plan pace → observable change → next action flow.

The dashboard uses unequal evidence-weighted grids, not a generic equal-card wall. Panels are flat, ruled, and close together like a spreadsheet workspace. One restrained tooltip shadow is allowed; grid surfaces do not float.

## Component grammar

### Hero and KPI cards

The hero is orientation, not marketing copy. It contains the product title, masked account, observation time, exact current total, and the qualifier that this is not performance.

KPI cards use one top inset category rule, a tonal category wash, a simple inline SVG, compact value, and share of total. Core cards remain legible at zero rather than disappearing. `other` appears only when nonzero; an intentional fifth-card treatment remains future polish.

### Donuts and charts

Donuts summarize composition only when a text legend exposes every category, amount, and share. The center label states the chart's total.

Growth charts are linear evidence, not decorative area art. The monthly chart may stack Toss-tracked and manual assets only when the current manual source and history are both ready. Saved-securities fallback omits any manual-assets tooltip row and names the reason for fallback. Period-change bars identify recorded contributions, withdrawals, and cash-flow-adjusted change without claiming realized P/L.

Every `aria-hidden` Recharts visualization must have an equivalent screen-reader table. Tooltips never replace the persistent textual scope note.

### Ledgers and holdings

Desktop ledgers use ruled tables, right-aligned numeric columns, sticky identity cells where needed, and exact labels. On narrow screens, holdings become concise two-column rows visually. Headers and secondary evidence may be visually hidden but must remain in the accessibility tree; never use `display:none` for essential financial cells.

Sparklines represent saved price observations only. Their accessible labels include the observed period, direction, starting value, ending value, and currency. Loading/fetch failure versus genuine insufficient history remains a future state refinement.

### Controls and navigation

- Interactive mobile targets are at least 44×44px.
- Segmented period controls use `aria-pressed`; active selection inverts to `--ink`/`--ground`.
- Focus uses the shared visible outline and must remain visible in both themes.
- Desktop uses the sticky top navigation. At mobile width, navigation becomes a safe-area-aware five-item bottom bar.
- The theme toggle announces the action (“다크 테마로 전환” / “기본 테마로 전환”), persists the choice, and exposes pressed state.

## Responsive contract

- At 1180px, evidence grids and donut layouts tighten.
- At 900px, two-column dashboard groups collapse and the bottom navigation takes over.
- At 640px, hero, KPIs, tables, charts, and the Review drawer reflow; period controls become 44px targets and chart Y axes may be visually omitted.
- At 380px, the KPI grid may become one column to prevent overflow.
- The 320px minimum viewport must not create horizontal page scrolling.

Mobile first-viewport density and an expanded visible holding-details treatment are approved follow-up polish, not reasons to remove evidence.

## Accessibility and motion

- Preserve the skip link, semantic headings, region labels, table captions, `aria-live` states, and visible focus.
- Status must include text, not only a colored dot.
- Respect reduced motion. The single workspace-entry animation is brief and nonessential; charts do not count up or replay for spectacle.
- Use forced-color-friendly borders and textual equivalents for every data visualization.

## Do / do not

Do:

- Make exact numbers and source boundaries easy to scan.
- Use the category palette consistently across KPI, donut, and legend.
- Show honest empty and fallback states instead of filling a grid with fictional data.
- Keep the existing 10-minute Review flow reachable beneath the dashboard.

Do not:

- Fabricate sector, benchmark, forecast, attribution, or realized-P/L data.
- Add trading controls or a general-purpose Toss proxy.
- Convert the dashboard into a landing page, oversized welcome screen, or ornamental trading terminal.
- Hide financially meaningful mobile data from assistive technology.

## Approved QA references

- Dark desktop first viewport: `.impeccable/review/hero-repro.png`
- Light desktop full workspace: `.impeccable/review/desktop.png`
- Final dark mobile viewport: `.impeccable/review/mobile-viewport-final.png`

## Non-blocking follow-up polish

- Rename the 24-month growth option from `ALL` to `2Y`/`24M`, or load genuinely unbounded history.
- Distinguish holding-history loading and fetch failure from “기록 부족.”
- Restore a visible mobile Live/Relay/Demo text cue, not only the status dot.
- Consider slightly larger analytical labels and a shorter mobile hero/KPI stack.
- Define an intentional fifth-card layout for a nonzero `other` bucket.
