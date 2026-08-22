# Problem Statement

## Title
Concurrency-Safe Seat Booking Backend

## Background
Naive ticket-booking backends implement booking as a read-then-write sequence:
check whether a seat is available, then mark it as booked. Under sequential,
single-user testing this works flawlessly. Under real-world concurrent load —
hundreds of users hitting "Book" on the same seat within milliseconds of each
other during a popular movie's opening night — this pattern breaks down into a
classic **lost-update race condition**: multiple requests read the seat as
available before any of them writes, so multiple writes succeed. The result is
one seat sold to two or more people, a failure mode that is invisible in
sequential tests and typically discovered only when a customer arrives to find
their seat occupied.

This class of bug is dangerous precisely because it passes every conventional
test suite. Sequential unit tests, manual QA, and even most integration tests
exercise the system one request at a time and never expose the race. It only
manifests under genuine concurrency, which means it is frequently shipped to
production undetected and discovered by users rather than engineers.

## Problem
Design and build a booking backend for a fixed-inventory reservation system
(movie theater seats) that eliminates the lost-update race entirely, while
preserving system throughput and avoiding new failure modes (starvation,
deadlock, whole-system serialization) that naive fixes commonly introduce.

## Core Requirements
1. **Mutual exclusion per seat.** Given N simultaneous booking requests for
   the same seat, exactly one must succeed. All others must fail immediately
   with a clear conflict response (e.g. HTTP 409) — never a silent overwrite,
   and never two confirmed bookings for the same seat.
2. **No blocking across unrelated seats.** Locking or contention on one seat
   must not increase latency or reduce throughput for bookings on other seats.
   The system must not degrade into a single global queue under load.
3. **No deadlocks under multi-seat transactions.** When a user books multiple
   seats in one transaction (e.g. a group of four), and multiple such
   transactions overlap on seat sets, the system must detect and resolve
   deadlocks (via consistent lock ordering, timeout-and-retry, or an
   equivalent strategy) rather than hanging indefinitely.
4. **Correctness must be demonstrated, not assumed.** The system must be
   proven correct under real concurrent load — e.g. 1,000+ simultaneous
   booking attempts against a single seat — using load testing, and ideally
   supplemented with formal verification and fault-injection ("chaos")
   testing, since this bug class specifically evades sequential testing.

## Non-Goals
- Payment processing and financial settlement.
- Full theater/venue management (screens, showtimes CRUD) beyond what is
  needed to demonstrate booking concurrency.
- UI/frontend polish — this is a backend correctness and systems project.
- Horizontal multi-region scaling (may be discussed as a stretch extension,
  not a core deliverable).

## Why This Matters
This is fundamentally a **database concurrency-control problem**, not a
business-logic problem. The interesting engineering decision is which
mechanism enforces the mutual-exclusion guarantee — pessimistic locking
(`SELECT ... FOR UPDATE`), a database-level unique constraint, optimistic
locking with a version column and retry, advisory locks, or serializable
isolation — and what each choice costs in throughput, latency, and failure
behavior under contention. The project's value lies in answering that
trade-off question with real, measured evidence rather than a single
untested assumption.

## Success Criteria
- Zero double-bookings observed across repeated high-concurrency load tests
  (1,000+ concurrent requests per seat), across multiple independent runs.
- Documented, comparative performance data (throughput, p50/p99 latency,
  conflict rate) across at least three distinct concurrency-control
  mechanisms.
- A reproducible adversarial multi-seat deadlock scenario, shown to hang or
  fail under a naive implementation and resolved under the final design.
- Evidence (formal model-check and/or chaos test results) that the mutual
  exclusion guarantee holds even under process/connection failure, not only
  under the happy path.
