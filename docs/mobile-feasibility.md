# Mobile clients for Prism (status)

**SUPERSEDED as product guidance (2026-08-06).** Keep this file only as a historical pointer.
Do not plan native work from the old research body below the archive note.

## What shipped instead

| Prerequisite the 2026-07 research required | Status |
|---|---|
| First-party auth on the playground Worker (#80) | Shipped (`AUTH_MODE=public` on play) |
| Entitlement / metered inference plane | **prism-control-plane** at `play-proxy.skyphusion.org` |
| Native clients | **[prism-ios](https://github.com/skyphusion-labs/prism-ios)** and **[prism-android](https://github.com/skyphusion-labs/prism-android)** (Swift / Kotlin kits + apps, not RN/Flutter) |

**Current split (truth for agents and operators):**

- **Playground Worker (this repo):** multimodal surface, history, RAG, projects, conversation compact, BYOK AI Gateway or optional control-plane key for chat.
- **Control plane:** who may call what and how much (prepaid ledger). No conversation storage (privacy invariant).
- **Mobile apps:** enroll against the control plane and/or talk to the playground Worker; conversation compact is a playground API (`POST/DELETE /api/conversations/:id/compact`) when a real playground `conversation_id` exists.

For normative mobile inference contracts, read **prism-control-plane** `docs/CONTRACT.md` and `docs/openapi.yaml`. For playground HTTP routes, see this repo's `README.md` API table and `CLAUDE.md`.

## Archive: original research (2026-07)

The remainder of this document is the original Ernst legal-structural / feasibility note from
issue #82 (Sprint 1). Its **recommendation to defer** assumed auth and entitlements were missing.
Those gates are closed. Historical arguments (IAP, AGPL vs store, BYOK vs subscription) may still
inform commercial plan numbers; they are not a build schedule.

---

# Mobile feasibility note: native Android and iOS for Prism

Status: **archived research** (Ernst, Sprint 1, issue #82). Not a decision document for current sprints.

Assumes **paid subscription mobile** per Conrad, 2026-07-17 (issue #82 comment), not a free thin client of
the public web playground. Nothing here is legal advice; the legal-structural section flags items for a
licensed reviewer.

## Recommendation (lead with it) -- historical

**DEFER to a later sprint, gated on #80.** Do not start mobile until first-party auth (#80) is merged and an
entitlement API exists on the Worker. When it does start, ship a **cross-platform app (React Native or
Flutter), chat-only MVP, with Skyphusion-hosted metered inference** behind an App Store / Play auto-renewing
subscription. BYOK stays the web posture; it is a poor fit for a paid mobile tier and is noted as a later
"advanced" tier, not the MVP.

This is a **defer**, not a **no-go**: the product case (a paid, polished mobile client) is coherent, but the
two hard prerequisites (a durable identity plane and a server-side entitlement check) do not exist yet, and
building either against today's Cloudflare Access identity plane would be throwaway work.

Go / no-go / defer, one line each:
- **Go now:** no. Prerequisites (#80 auth, entitlement API) are not in place.
- **No-go forever:** no. The subscription product is viable once the groundwork lands.
- **Defer:** yes. Revisit at the top of the sprint after #80 merges; treat the entitlement API as its own issue.

## v1 approach under a subscription model

Compared against the issue's four options:

| Approach | Subscription fit | Effort | Verdict |
|---|---|---|---|
| Responsive PWA | Weak. No first-class store subscription; iOS PWA cannot use StoreKit, so no App Store IAP. | Low | Non-goal for the paid tier |
| Wrapper (Capacitor) | Marginal. Store binary is fast, but Apple review scrutinizes "just a website" wrappers, and you still bolt on a native IAP plugin. | Low-medium | Non-goal |
| **Cross-platform (React Native / Flutter / KMP)** | **Strong.** One codebase, mature IAP plugins (RevenueCat, react-native-iap, Flutter in_app_purchase), real native UX, StoreKit / Play Billing via plugin. | Medium-high | **Recommended** |
| Fully native (Swift + Kotlin) | Strongest platform fit (StoreKit 2, Play Billing native). | Highest (two codebases) | Overkill for MVP |

**Pick: cross-platform, React Native or Flutter.** It is the only option that gives a credible auto-renewing
subscription story without paying twice for two native codebases. RN vs Flutter is an engineering call for the
frontend lane (Joan); RN leans toward reusing JS/TS skills already in this repo, Flutter toward smoother
media UI. Either satisfies this note.

**What actually shipped:** fully native Swift (prism-ios) and Kotlin (prism-android) kits/apps, with
prism-control-plane for metering. The cross-platform recommendation above is historical preference, not
current architecture.

(The original note continued with IAP, AGPL distribution, and privacy analysis in-repo history. Full
prior text remains in git history before this supersession rewrite; do not re-expand the deferral
recommendation as if it still gates work.)
