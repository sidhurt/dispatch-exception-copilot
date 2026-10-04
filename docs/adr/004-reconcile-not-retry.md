# ADR-004: A goods issue that timed out is reconciled, not retried

> **Status:** draft, to be written by Siddharth. The ERP side is already built and marked "pending ADR-004" in the SPEC.

## Context
<!-- What problem forced a decision? (Timeout after commit: the PGI may have posted, and the caller can't tell.) -->

## Decision
<!-- What did we choose? -->

## Why not the alternatives
<!-- 2–3 obvious other choices, and why not. E.g. just retry? trust status alone? use postedBy + postedAt? a new key on each retry? -->

## What it costs us
<!-- What gets harder because of this choice? -->

---

### Raw notes: your own answers from 2026-10-04 (delete when the ADR is written)
- Before any retry: check the goods movements first.
- postedBy / postedAt can't tell "my attempt" from someone else's.
- Send the proposalId with the goods issue; the ERP stores it as `clientReference`; search for it after a timeout.
- A retry uses the **same** key. "A new one would look like a different attempt."
- The ERP stores the reference but doesn't reject repeats. Your executor does the checking.
