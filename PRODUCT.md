# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

LedgerLens is for its owner, who periodically reviews investment performance and capital plans on a desktop PC. The primary session is analytical rather than transactional.

## Product Purpose

LedgerLens combines a read-only Toss Securities portfolio, immutable snapshots, manually recorded external cash flows, and cash-flow-adjusted analytics. Within 30 seconds, it should answer whether tracked assets are progressing toward the owner's plan, what materially changed, and what deserves review before the next capital allocation decision.

## Positioning

The product is a private capital review workspace, not a trading terminal or advisory service. It connects current holdings, historical evidence, allocation targets, and owner-entered capital plans while preserving the boundary between measured facts and estimates.

## Operating Context

The owner uses the app periodically on PC for performance review, allocation checks, contribution planning, and investigation of individual holdings. Mobile web is a responsive companion, not the primary analytical surface.

## Capabilities and Constraints

- Preserve exact decimal financial values internally and format only for display.
- Keep Toss integration read-only. Do not add order execution or a general-purpose proxy.
- Distinguish live, demo, loading, empty, insufficient-history, and error states.
- Target assets, plan dates, monthly contribution, and KR/US/cash target weights are owner-editable.
- Focus on current and historical analysis plus plan status. Do not forecast returns, build scenario simulations, or recommend trades.
- Modified Dietz is a cash-flow-adjusted estimate over tracked assets, not a guaranteed or official return.
- Holding-level period attribution is limited without a complete trade, dividend, fee, and realized-profit ledger.

## Evidence on Hand

The repository contains live/demo portfolio contracts, immutable portfolio and holding snapshots, a manual cash-flow ledger, Modified Dietz analytics, holding history, and snapshot automation status. There is no benchmark feed or complete transaction ledger and neither may be fabricated.

## Product Principles

- Put decisions before totals.
- Make causes visible without overstating certainty.
- Keep financial precision and data provenance inspectable.
- Use visualization to connect trend, cash flow, allocation, and plan status.
- Preserve accessible keyboard and responsive operation.

## Accessibility & Inclusion

All workflows must support keyboard navigation, visible focus, WCAG AA contrast, reduced motion, forced colors, non-color status cues, and textual equivalents for charts.
