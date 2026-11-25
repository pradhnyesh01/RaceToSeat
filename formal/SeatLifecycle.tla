---------------------------- MODULE SeatLifecycle ----------------------------
(***************************************************************************)
(* Phase 5 lifecycle on top of seat claiming (RaceToSeat, Phase 6 / F3):   *)
(* Hold -> Confirm -> Booking, Expire, Reaper, Cancel.                     *)
(*                                                                         *)
(* Mirrors the `pessimistic` implementation only (ADR-0017):               *)
(*   AcquireHold   src/strategies/pessimisticHold.ts   (FOR UPDATE NOWAIT) *)
(*   DirectBook    src/strategies/pessimistic.ts       (POST /bookings)    *)
(*   ConfirmLock / ConfirmCommit  src/strategies/pessimisticConfirm.ts     *)
(*   Reap          src/reaper.ts                       (one atomic sweep)  *)
(*   Cancel        DELETE /bookings/:id                (src/routes)        *)
(*                                                                         *)
(* TTL is NOT a clock. Each Hold has a monotonic `expired` flag, set by a  *)
(* nondeterministic Expire(r) action and never cleared: time only moves   *)
(* forward, and every interleaving of "time passes" with the other        *)
(* actions is explored. Confirm and the Reaper both read that flag.        *)
(*                                                                         *)
(* Confirm is two steps because the interesting race lives between them:   *)
(* ConfirmLock takes the row locks and does the expiry check (state        *)
(* "confirming" = locks held, hold still unexpired AS OF the check), and   *)
(* ConfirmCommit publishes the Booking. Expire may fire in between; the    *)
(* Reaper's UPDATE would then block on confirm's lock and, once confirm    *)
(* commits, re-check its WHERE clause against the new row (EPQ) and skip   *)
(* it. The default Reaper models that; ReaperMode "stale" is the trap      *)
(* issue #40 analyzed (a precomputed expired-id list applied after         *)
(* confirm committed) and must be caught.                                  *)
(*                                                                         *)
(* Claim granularity: F1 (SeatBooking.tla, ClaimMode "atomic") already     *)
(* proves per-seat claiming under NOWAIT is mutually exclusive and         *)
(* all-or-nothing, so AcquireHold/DirectBook are each ONE atomic           *)
(* all-or-nothing step here. This keeps the lifecycle state space         *)
(* tractable; see formal/README.md "Abstractions".                         *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Requests,     \* each request is one actor: it tries to Hold, or to book directly
    Seats,
    ConfirmMode,  \* "checked" | "noExpiryCheck" | "replayable"
    ReaperMode    \* "guarded" | "noExpiryGuard" | "stale" | "disabled"

ASSUME ConfirmMode \in {"checked", "noExpiryCheck", "replayable"}
ASSUME ReaperMode  \in {"guarded", "noExpiryGuard", "stale", "disabled"}

VARIABLES
    want,         \* want[r]: the non-empty seat set (size <= 2) r asked for; fixed at Init
    pc,           \* pc[r]: lifecycle position, see TypeOK
    seat,         \* seat[s]: seats.status
    holdRows,     \* holdRows[r]: seats with a hold_seats row owned by r
    bookRows,     \* bookRows[r]: seats with a booking_seats row owned by r
    expired,      \* expired[r]: r's Hold has passed its TTL; monotonic
    liveAtCheck,  \* liveAtCheck[r]: was r's Hold unexpired when its last Confirm checked it
    nconf,        \* nconf[r]: how many Confirms have committed on r's Hold
    snap          \* snap[r]: (stale Reaper only) r's hold was on its precomputed expired list

vars == <<want, pc, seat, holdRows, bookRows, expired, liveAtCheck, nconf, snap>>

SeatSets == {S \in SUBSET Seats : Cardinality(S) \in 1..2}

Avail(S) == \A s \in S : seat[s] = "available"
SetSeats(S, v) == [s \in Seats |-> IF s \in S THEN v ELSE seat[s]]
Only(f, r, v) == [f EXCEPT ![r] = v]

-----------------------------------------------------------------------------
Init ==
    /\ want        \in [Requests -> SeatSets]
    /\ pc          = [r \in Requests |-> "idle"]
    /\ seat        = [s \in Seats |-> "available"]
    /\ holdRows    = [r \in Requests |-> {}]
    /\ bookRows    = [r \in Requests |-> {}]
    /\ expired     = [r \in Requests |-> FALSE]
    /\ liveAtCheck = [r \in Requests |-> FALSE]
    /\ nconf       = [r \in Requests |-> 0]
    /\ snap        = [r \in Requests |-> FALSE]

\* POST /holds: all requested seats 'available' -> all held; otherwise 409 and
\* nothing changes (all-or-nothing, F1's Atomicity).
AcquireHold(r) ==
    /\ pc[r] = "idle"
    /\ IF Avail(want[r])
          THEN /\ seat'     = SetSeats(want[r], "held")
               /\ holdRows' = Only(holdRows, r, want[r])
               /\ pc'       = Only(pc, r, "held")
          ELSE /\ pc'       = Only(pc, r, "hold_failed")
               /\ UNCHANGED <<seat, holdRows>>
    /\ UNCHANGED <<want, bookRows, expired, liveAtCheck, nconf, snap>>

\* POST /bookings (pessimistic): same acquisition, straight to 'booked'.
\* A seat held by a live Hold is not 'available', so a direct booking loses.
DirectBook(r) ==
    /\ pc[r] = "idle"
    /\ IF Avail(want[r])
          THEN /\ seat'     = SetSeats(want[r], "booked")
               /\ bookRows' = Only(bookRows, r, want[r])
               /\ pc'       = Only(pc, r, "booked")
          ELSE /\ pc'       = Only(pc, r, "booking_failed")
               /\ UNCHANGED <<seat, bookRows>>
    /\ UNCHANGED <<want, holdRows, expired, liveAtCheck, nconf, snap>>

\* The TTL elapses. Only a Hold that still exists can expire (the flag is
\* frozen once the Hold is confirmed or reaped), and never un-expires.
Expire(r) ==
    /\ pc[r] \in {"held", "confirming"}
    /\ ~expired[r]
    /\ expired' = Only(expired, r, TRUE)
    /\ UNCHANGED <<want, pc, seat, holdRows, bookRows, liveAtCheck, nconf, snap>>

\* POST /holds/:id/confirm, first half: SELECT ... FOR UPDATE OF s NOWAIT over
\* the hold's seats, then the lazy expiry check (ADR-0018). "confirming" means
\* the row locks are held. A confirm that finds the locks taken (concurrent
\* confirm) or the Hold expired answers 409/410 and changes nothing, so it
\* is simply not an enabled step here.
\*   checked        the real code
\*   noExpiryCheck  skips the held_until check (negative control)
\*   replayable     also re-runs against an already-confirmed Hold, i.e. skips
\*                  the "hold_seats rows still exist" check (negative control)
ConfirmLock(r) ==
    /\ IF ConfirmMode = "replayable"
          THEN pc[r] \in {"held", "confirmed"} /\ nconf[r] < 2   \* cap keeps the control finite
          ELSE pc[r] = "held"
    /\ (ConfirmMode = "noExpiryCheck" \/ ~expired[r])
    /\ liveAtCheck' = Only(liveAtCheck, r, ~expired[r])
    /\ pc' = Only(pc, r, "confirming")
    /\ UNCHANGED <<want, seat, holdRows, bookRows, expired, nconf, snap>>

\* Second half: insertBookingForSeats + the DELETE of hold_seats/holds, one
\* transaction. Does not re-check expiry: the locks make the check-time answer
\* stand until commit.
ConfirmCommit(r) ==
    /\ pc[r] = "confirming"
    /\ seat'     = SetSeats(want[r], "booked")
    /\ holdRows' = Only(holdRows, r, {})
    /\ bookRows' = Only(bookRows, r, want[r])
    /\ pc'       = Only(pc, r, "confirmed")
    /\ nconf'    = Only(nconf, r, nconf[r] + 1)
    /\ UNCHANGED <<want, expired, liveAtCheck, snap>>

\* DELETE /bookings/:id, for a Booking from either path.
Cancel(r) ==
    /\ pc[r] \in {"booked", "confirmed"}
    /\ seat'     = SetSeats(bookRows[r], "available")
    /\ bookRows' = Only(bookRows, r, {})
    /\ pc'       = Only(pc, r, "cancelled")
    /\ UNCHANGED <<want, holdRows, expired, liveAtCheck, nconf, snap>>

\* The sweep, for one Hold (the real sweep does every expired Hold in one
\* atomic statement; per-Hold steps cover a superset of its orderings).
\* guarded:       WHERE status = 'held' AND held_until < now(). A seat locked by
\*                an in-flight confirm ("confirming") is not reachable: the UPDATE
\*                blocks, then re-checks the row, finds it booked, skips it.
\* noExpiryGuard: drops the held_until predicate (negative control).
ReapEffect(r) ==
    /\ seat'     = SetSeats(want[r], "available")
    /\ holdRows' = Only(holdRows, r, {})
    /\ pc'       = Only(pc, r, "reaped")

Reap(r) ==
    /\ \/ ReaperMode = "guarded"       /\ expired[r]
       \/ ReaperMode = "noExpiryGuard"
    /\ pc[r] = "held"
    /\ ReapEffect(r)
    /\ UNCHANGED <<want, bookRows, expired, liveAtCheck, nconf, snap>>

\* ReaperMode "stale" (negative control): read the expired list first, apply it
\* later with no re-check of the row -- issue #40's "precomputed id list" trap.
\* The snapshot is taken while confirm's locks are not yet visible as state
\* changes (status still 'held'); the apply waits out confirm's row lock, then
\* resets the seats unconditionally.
SnapReap(r) ==
    /\ ReaperMode = "stale"
    /\ expired[r] /\ ~snap[r]
    /\ pc[r] \in {"held", "confirming"}
    /\ snap' = Only(snap, r, TRUE)
    /\ UNCHANGED <<want, pc, seat, holdRows, bookRows, expired, liveAtCheck, nconf>>

ApplyReap(r) ==
    /\ ReaperMode = "stale"
    /\ snap[r]
    /\ pc[r] # "confirming"
    /\ seat'     = SetSeats(want[r], "available")
    /\ holdRows' = Only(holdRows, r, {})
    /\ pc'       = IF pc[r] = "held" THEN Only(pc, r, "reaped") ELSE pc
    /\ snap'     = Only(snap, r, FALSE)
    /\ UNCHANGED <<want, bookRows, expired, liveAtCheck, nconf>>

\* Every request is finished: stutter, so TLC's deadlock check flags only a
\* genuinely stuck non-terminal state. ("confirmed"/"booked" are not terminal:
\* Cancel is still enabled there.)
Terminated ==
    /\ \A r \in Requests : pc[r] \in {"cancelled", "reaped", "hold_failed", "booking_failed"}
    /\ UNCHANGED vars

Next ==
    \/ \E r \in Requests :
         \/ AcquireHold(r) \/ DirectBook(r)
         \/ Expire(r)
         \/ ConfirmLock(r) \/ ConfirmCommit(r)
         \/ Reap(r) \/ SnapReap(r) \/ ApplyReap(r)
         \/ Cancel(r)
    \/ Terminated

Spec == Init /\ [][Next]_vars

\* The Reaper, for fairness: whichever form the mode gives it.
ReaperStep(r) == Reap(r) \/ ApplyReap(r)

\* Fairness assumptions, each named so the liveness controls can drop one.
FairReaper == \A r \in Requests : WF_vars(ReaperStep(r))     \* the Reaper keeps running
FairTime   == \A r \in Requests : WF_vars(Expire(r))         \* time keeps passing
FairCommit == \A r \in Requests : WF_vars(ConfirmCommit(r))  \* in-flight transactions finish

SpecReaperFair == Spec /\ FairReaper
SpecFair       == Spec /\ FairReaper /\ FairTime /\ FairCommit
\* One fairness assumption dropped each, for the liveness negative controls.
SpecNoTime     == Spec /\ FairReaper /\ FairCommit
SpecNoCommit   == Spec /\ FairReaper /\ FairTime

-----------------------------------------------------------------------------
TypeOK ==
    /\ want        \in [Requests -> SeatSets]
    /\ pc          \in [Requests -> {"idle", "held", "confirming", "confirmed", "booked",
                                     "cancelled", "reaped", "hold_failed", "booking_failed"}]
    /\ seat        \in [Seats -> {"available", "held", "booked"}]
    /\ holdRows    \in [Requests -> SUBSET Seats]
    /\ bookRows    \in [Requests -> SUBSET Seats]
    /\ expired     \in [Requests -> BOOLEAN]
    /\ liveAtCheck \in [Requests -> BOOLEAN]
    /\ nconf       \in [Requests -> 0..2]
    /\ snap        \in [Requests -> BOOLEAN]

Owned(r) == holdRows[r] \cup bookRows[r]

\* A seat belongs to at most one of {Booking, Hold}: no two requests own it,
\* and one request never owns it both ways.
SeatBelongsToAtMostOne ==
    /\ \A r1, r2 \in Requests : r1 # r2 => Owned(r1) \cap Owned(r2) = {}
    /\ \A r \in Requests : holdRows[r] \cap bookRows[r] = {}

\* seats.status agrees with the hold_seats / booking_seats rows.
SeatStatusAgrees ==
    \A s \in Seats :
        /\ seat[s] = "held"   <=> \E r \in Requests : s \in holdRows[r]
        /\ seat[s] = "booked" <=> \E r \in Requests : s \in bookRows[r]

\* A Hold is confirmed at most once.
HoldConfirmedAtMostOnce == \A r \in Requests : nconf[r] <= 1

\* No Confirm succeeds on an expired Hold: every confirm in flight or
\* finished saw the Hold unexpired when it checked.
NoConfirmOnExpired ==
    \A r \in Requests : pc[r] \in {"confirming", "confirmed"} => liveAtCheck[r]

\* The Reaper only releases Holds that have expired.
ReapOnlyExpired == \A r \in Requests : pc[r] = "reaped" => expired[r]

-----------------------------------------------------------------------------
\* Liveness (kept separable: Lifecycle*Live*.cfg only).
\* Under weak fairness on the Reaper alone, an expired Hold does not stay held.
ExpiredHoldResolved ==
    \A r \in Requests : [](pc[r] = "held" /\ expired[r] => <>(pc[r] # "held"))

\* With time passing and in-flight transactions finishing as well, no seat
\* stays 'held' forever (it ends up booked or available).
NoSeatHeldForever ==
    \A s \in Seats : [](seat[s] = "held" => <>(seat[s] # "held"))

-----------------------------------------------------------------------------
\* Vacuity guards, each expected to be VIOLATED (one per Witness cfg): they show
\* the races the invariants guard are actually reached, so a pass is not a pass
\* on a model that never gets there.

\* Expiry lands while a confirm holds its locks (between check and commit): the
\* window in which the Reaper's UPDATE must block and re-check.
NoExpiryDuringConfirm == ~(\E r \in Requests : pc[r] = "confirming" /\ expired[r])

\* ...and the confirm legitimately wins that race: confirmed with a Hold that
\* is, by then, expired (it was live when checked).
NoConfirmWonAfterExpiry == ~(\E r \in Requests : pc[r] = "confirmed" /\ expired[r])

\* A reaped Hold's seat is claimed again by someone else: release actually
\* returns seats to circulation.
NoReuseAfterReap ==
    ~(\E r1, r2 \in Requests :
        /\ r1 # r2 /\ pc[r1] = "reaped" /\ want[r1] \cap want[r2] # {}
        /\ pc[r2] \in {"held", "confirming", "confirmed", "booked"})

\* A direct booking loses to a live Hold on an overlapping seat.
NoBookingBlockedByHold ==
    ~(\E r1, r2 \in Requests :
        /\ r1 # r2 /\ pc[r1] = "booking_failed" /\ want[r1] \cap want[r2] # {}
        /\ pc[r2] \in {"held", "confirming"})

\* A confirmed Booking is cancelled, freeing its seats.
NoCancelAfterConfirm == ~(\E r \in Requests : pc[r] = "cancelled" /\ nconf[r] = 1)
=============================================================================
