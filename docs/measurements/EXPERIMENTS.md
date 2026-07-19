# EXPERIMENTS — CSUB-RIO Demo Performance Ledger

Per Demo Spec 05 R1, every experiment against the live demo line is written
into this ledger *before* it runs, with all five R1 parts recorded in its
row: (1) hypothesis, (2) the single config change (one Railway environment
variable flipped — never a code diff), (3) the measurement (which existing
log fields, over how many calls/turns, aggregated exclusively through
`scripts/aggregate-latency.mjs` over exported JSONL), (4) the numeric pass
gate compared against the baseline, and (5) the revert rule — the exact
variable/value restored on a gate FAIL. Only one variable is ever flipped at
a time, and a gate FAIL is reverted the same day it is evaluated (R1c).
Experiment ordering follows Demo Spec 05 R11: the R2 baseline session runs
first; E3 runs before E4's 20-question session; E4 must complete and PASS
before the announcement email is released; the deploy freeze (Demo Spec 06)
ends all further flips. Subjective gates (E1 audio quality, E2 clipped
turns) must name their judging procedure and judge count in the row's notes
(R1a). The configuration of record at any moment must be derivable from this
ledger alone (R12). This ledger is committed together with each session's
measurement directory, within that same 72 h extraction deadline (R3).

| date | experiment | variable=value | measurement dir | gate | result (numbers) | verdict | notes |
| --- | --- | --- | --- | --- | --- | --- | --- |

Verdict vocabulary: `PASS` / `FAIL+REVERTED` / `BLOCKED` (R12). E3's row
records the S8 answer (is `marin` a valid voice?) and E1's row records the
S1 answer (does the gateway honor `audio/pcmu`?) — both are also recorded in
the base S1–S35 answer table per master plan R2.3, by DC1, not by this task.
