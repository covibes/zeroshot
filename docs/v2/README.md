# Zeroshot V2 planning artifacts

Planning documents for the V2 effort: epic **#643** (Open Engine Cluster Protocol) and epic **#665** (native Rust engine). Written 2026-07-29 against Node baseline `50c5b00`.

| Document                                                           | Purpose                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [parity-matrix.md](parity-matrix.md)                               | **The document that makes "we did not lose features" checkable.** 281 capability rows (183 control surface + 98 engine surface), each classified `implemented` / `replaced` / `excluded` / `absent-in-node` and mapped to an owning #665 issue. Input artifact for #691. |
| [m1-launch-order.md](m1-launch-order.md)                           | Wave structure and launch rule for milestone `M1 — Certified embeddable backend` (11 issues, 8 waves).                                                                                                                                                                   |
| [behavior-spec-schema.md](behavior-spec-schema.md)                 | Scenario schema for the dual-binary behaviour-spec suite that runs one spec file against both `zeroshot` (Node) and `zeroshot-rust`.                                                                                                                                     |
| [748-typescript-client-design.md](748-typescript-client-design.md) | Ownership design gating #748. Per owner decision, no `src/cluster/**` code is written until this is reviewed and accepted.                                                                                                                                               |

## Read these first

**The parity matrix is provisional, not pinned.** Node Zeroshot keeps receiving features and freezes later. Every Node feature PR that changes user-observable behaviour must append a row to the matrix's delta log (§9) until the freeze. A PR that changes observable behaviour without a delta-log row is a parity defect.

**§7 of the parity matrix lists 71 unowned capabilities**, tiered by risk. These are capabilities with no owning #665 issue — the ones that will be silently lost if nothing changes. They are deliberately _not_ filed as individual issues yet; this document is the record so they can be tackled later. The Tier 1 set is the urgent one, including the finding that the V2 product currently has **no configuration write path at all**.

**§3.3 distinguishes `excluded by decision` from `excluded by consequence`.** The second kind is the dangerous one: nobody decided to drop the capability, it fell out of a constraint written for another purpose, and no owner recorded the loss.

## Status

These are planning artifacts, not specifications of shipped behaviour. Where they describe future work they are proposals; where they describe current Node or Rust behaviour they carry file:line evidence and were verified at `50c5b00`.
