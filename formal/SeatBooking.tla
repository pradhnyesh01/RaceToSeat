------------------------------ MODULE SeatBooking ------------------------------
(***************************************************************************)
(* Seat acquisition and multi-seat Booking (RaceToSeat, Phase 6 / F1).     *)
(*                                                                         *)
(* Models the concurrent claim of Seats by Requests, each of which wants   *)
(* a set of one or two Seats booked together or not at all. Parameterized *)
(* by ClaimMode, the claim primitive:                                      *)
(*                                                                         *)
(*   "atomic"  default. Check-and-claim of one seat is a single atomic     *)
(*             step that sees in-flight claims: models FOR UPDATE NOWAIT   *)
(*             (pessimistic) / the unique-index entry of an in-flight      *)
(*             INSERT (unique_constraint, ADR-0008). A request that finds  *)
(*             a seat already claimed aborts and rolls back (409).         *)
(*   "naive"   unguarded read-then-write with NO unique backstop: the      *)
(*             availability read sees committed rows only, and the write   *)
(*             that follows is unconditional. Negative control.            *)
(*   "partial" per-seat INSERT ... ON CONFLICT DO NOTHING whose affected-  *)
(*             row count is ignored, so a request commits whichever seats  *)
(*             it happened to win. Negative control for Atomicity.         *)
(*                                                                         *)
(* Out of scope here (later tickets): blocking lock acquisition and        *)
(* deadlock (F2), Hold/Confirm/Expire/Reaper/Cancel (F3), crash and        *)
(* ambiguous-commit (F4). See formal/README.md for the full list of        *)
(* abstractions.                                                           *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Requests,   \* the set of concurrent booking requests
    Seats,      \* the set of seats of the one modeled Event
    ClaimMode   \* "atomic" | "naive" | "partial"

ASSUME ClaimMode \in {"atomic", "naive", "partial"}

VARIABLES
    want,   \* want[r]: the non-empty seat set (size <= 2) request r asked for; fixed at Init
    pc,     \* pc[r]: "idle" | "active" | "committed" | "aborted"
    todo,   \* todo[r]: seats r has not yet attempted to claim
    rows    \* rows[r]: seats for which r has written a booking_seats row
            \* (invisible to others' reads until r commits, but - in "atomic"
            \* mode - already visible to claim attempts as a held lock/index entry)

vars == <<want, pc, todo, rows>>

SeatSets == {S \in SUBSET Seats : Cardinality(S) \in 1..2}

\* What a reader of committed state sees as belonging to request r.
Committed(r)      == pc[r] = "committed"
CommittedSeats(r) == IF Committed(r) THEN rows[r] ELSE {}

\* A plain read (read committed) sees only committed rows.
FreeCommitted(s)  == \A r \in Requests : s \notin CommittedSeats(r)
\* A claim attempt also collides with an in-flight claim (row lock / unique index entry).
FreeInclInflight(s) == \A r \in Requests : s \notin rows[r]

-----------------------------------------------------------------------------
Init ==
    /\ want \in [Requests -> SeatSets]
    /\ pc   = [r \in Requests |-> "idle"]
    /\ todo = [r \in Requests |-> {}]
    /\ rows = [r \in Requests |-> {}]

\* Begin the request's transaction. In "naive" mode this is also where the
\* availability read happens, one SELECT over all requested seats.
Start(r) ==
    /\ pc[r] = "idle"
    /\ UNCHANGED <<want, rows>>
    /\ IF ClaimMode = "naive" /\ ~(\A s \in want[r] : FreeCommitted(s))
          THEN /\ pc'   = [pc EXCEPT ![r] = "aborted"]    \* 409: seen as taken
               /\ todo' = todo
          ELSE /\ pc'   = [pc EXCEPT ![r] = "active"]
               /\ todo' = [todo EXCEPT ![r] = want[r]]

\* Rollback: every claim the transaction made disappears.
Abort(r) ==
    /\ pc'   = [pc   EXCEPT ![r] = "aborted"]
    /\ rows' = [rows EXCEPT ![r] = {}]
    /\ todo' = [todo EXCEPT ![r] = {}]
    /\ UNCHANGED want

Claimed(r, s) ==
    /\ rows' = [rows EXCEPT ![r] = @ \cup {s}]
    /\ todo' = [todo EXCEPT ![r] = @ \ {s}]
    /\ UNCHANGED <<want, pc>>

\* Seats are attempted in any order (the \E): ordering matters only for
\* blocking acquisition, which is F2's concern.
AtomicClaim(r) ==
    /\ pc[r] = "active"
    /\ \E s \in todo[r] :
         IF FreeInclInflight(s) THEN Claimed(r, s) ELSE Abort(r)

NaiveWrite(r) ==
    /\ pc[r] = "active"
    /\ \E s \in todo[r] : Claimed(r, s)       \* unconditional: no re-check, no unique backstop

PartialClaim(r) ==
    /\ pc[r] = "active"
    /\ \E s \in todo[r] :
         IF FreeInclInflight(s)
            THEN Claimed(r, s)
            ELSE /\ todo' = [todo EXCEPT ![r] = @ \ {s}]   \* ON CONFLICT DO NOTHING: skip silently
                 /\ UNCHANGED <<want, pc, rows>>

Commit(r) ==
    /\ pc[r] = "active"
    /\ todo[r] = {}
    /\ pc' = [pc EXCEPT ![r] = "committed"]
    /\ UNCHANGED <<want, todo, rows>>

\* All requests resolved: stutter, so TLC's deadlock check flags only a
\* genuinely stuck non-terminal state.
Terminated ==
    /\ \A r \in Requests : pc[r] \in {"committed", "aborted"}
    /\ UNCHANGED vars

Next ==
    \/ \E r \in Requests :
         \/ Start(r)
         \/ ClaimMode = "atomic"  /\ AtomicClaim(r)
         \/ ClaimMode = "naive"   /\ NaiveWrite(r)
         \/ ClaimMode = "partial" /\ PartialClaim(r)
         \/ Commit(r)
    \/ Terminated

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
TypeOK ==
    /\ want \in [Requests -> SeatSets]
    /\ pc   \in [Requests -> {"idle", "active", "committed", "aborted"}]
    /\ todo \in [Requests -> SUBSET Seats]
    /\ rows \in [Requests -> SUBSET Seats]

\* A seat belongs to at most one Booking.
MutualExclusion ==
    \A r1, r2 \in Requests :
        r1 # r2 => CommittedSeats(r1) \cap CommittedSeats(r2) = {}

\* A Booking's seat set is fully claimed or not at all: a committed Booking
\* holds exactly the seats requested, and a request that never started or
\* aborted leaves no rows behind.
Atomicity ==
    \A r \in Requests :
        /\ Committed(r) => rows[r] = want[r]
        /\ pc[r] \in {"idle", "aborted"} => rows[r] = {}

\* Vacuity guard, expected to be VIOLATED (see Witness.cfg): proves the model
\* can reach a committed two-seat Booking alongside a conflict-aborted request,
\* i.e. the invariants above are not passing on a model that never contends.
NoContendedOutcome ==
    ~( (\E r \in Requests : Committed(r) /\ Cardinality(want[r]) = 2)
       /\ (\E r \in Requests : pc[r] = "aborted") )
=============================================================================
