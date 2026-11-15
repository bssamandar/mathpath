# ADR-0006: Rule-based gap routing and SM-2 review, behind interfaces

- Status: Proposed
- Date: 2026-11-15

## Context

The adaptive algorithm must detect gaps and route students back to
prerequisite topics. At launch we have no answer data to train statistical
models.

## Decision

- **Mastery:** a topic is mastered when the mastery-test score ≥ the threshold
  (80%, config). Practice accuracy feeds a "warning" signal.
- **Gap routing:** deterministic rules over the knowledge graph (see
  architecture §5.2) with depth and frequency limits from config.
- **Review:** SM-2-style spaced repetition with intervals from config.
- Both sit behind `MasteryModel`, `GapRouter` and `ReviewScheduler`
  interfaces.

## Alternatives considered

- **Bayesian Knowledge Tracing / Item Response Theory.** More precise, but
  they need calibrated item parameters from real data, are hard to explain
  to parents and teachers, and are hard to debug.
- **FSRS for review.** Better retention modelling, but it needs per-user history to
  tune. It is a candidate once we have data.

## Consequences

- Behaviour is explainable ("you were sent to Fractions because...") and
  easy to unit-test.
- We log every routing decision as a learning event, which becomes training data
  for a later statistical model.
