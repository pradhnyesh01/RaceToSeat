--------------------------- MODULE DeadlockFreedom ---------------------------
(***************************************************************************)
(* Deadlock-freedom A/B model (RaceToSeat, Phase 6 / F2).                  *)
(*                                                                         *)
(* A separate module from SeatBooking.tla on purpose: SeatBooking models   *)
(* the claim as a single atomic step and so cannot express waiting. Here   *)
(* each Request acquires one lock per wanted Seat, one step at a time,     *)
(* holding every lock it has until it commits. A lock stands for whatever  *)
(* a mechanism blocks on: a seats row lock (UPDATE / FOR UPDATE) or an      *)
(* in-flight unique-index entry (INSERT ... unnest, Exhibit D).            *)
(*                                                                         *)
(* AcqMode, how a lock that is already held by someone else is treated:    *)
(*                                                                         *)
(*   "unsorted" BLOCK, in the order the client sent the seat_ids. This is  *)
(*              naive/unique_constraint/optimistic/serializable as they    *)
(*              were before ADR-0014's fix. Negative control: TLC must     *)
(*              find a wait-for cycle.                                     *)
(*   "sorted"   BLOCK, but every request acquires in ascending seat        *)
(*              order (ADR-0014's primary defense). Must be cycle-free.    *)
(*   "nowait"   never block: a held lock aborts the request and releases   *)
(*              what it holds (FOR UPDATE NOWAIT / pg_try_advisory_xact_   *)
(*              lock, ADR-0006). Acquisition order is client-chosen, as    *)
(*              in "unsorted": freedom must not depend on ordering.        *)
(*                                                                         *)
(* No deadlock detector is modeled. A wait-for cycle here is the state     *)
(* Postgres's detector would have to break by aborting one side (40P01,    *)
(* ADR-0015); "sorted" proves the detector is never needed, it does NOT    *)
(* model that fallback (withDeadlockRetry).                                *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    Requests,   \* the set of concurrent multi-seat booking requests
    Seats,      \* a set of natural numbers: their < is the global lock order
    AcqMode     \* "unsorted" | "sorted" | "nowait"

ASSUME AcqMode \in {"unsorted", "sorted", "nowait"}
ASSUME Seats \subseteq Nat

VARIABLES
    order,   \* order[r]: the sequence of seats r acquires, fixed at Init
    idx,     \* idx[r]: how many of order[r] r has acquired so far
    holder,  \* holder[s]: the request holding seat s's lock, or "none"
    pc       \* pc[r]: "active" | "committed" | "aborted"

vars == <<order, idx, holder, pc>>

SeatSets == {S \in SUBSET Seats : Cardinality(S) \in 1..2}

\* Every ordering of S, as a sequence without repeats.
Orderings(S) == {q \in [1..Cardinality(S) -> S] :
                    \A i, j \in DOMAIN q : i # j => q[i] # q[j]}
Ascending(q) == \A i, j \in DOMAIN q : i < j => q[i] < q[j]

AllowedOrders ==
    UNION {IF AcqMode = "sorted"
              THEN {q \in Orderings(S) : Ascending(q)}
              ELSE Orderings(S)
           : S \in SeatSets}

Range(q) == {q[i] : i \in DOMAIN q}

-----------------------------------------------------------------------------
Init ==
    /\ order  \in [Requests -> AllowedOrders]
    /\ idx    = [r \in Requests |-> 0]
    /\ holder = [s \in Seats |-> "none"]
    /\ pc     = [r \in Requests |-> "active"]

Wants(r)   == idx[r] < Len(order[r])
NextSeat(r) == order[r][idx[r] + 1]
HeldBy(r)  == {s \in Seats : holder[s] = r}
Release(r) == [s \in Seats |-> IF holder[s] = r THEN "none" ELSE holder[s]]

\* r's next lock is held by someone else (it can only be someone else:
\* order has no repeats, so r never asks for a seat it already holds).
Contended(r) == pc[r] = "active" /\ Wants(r) /\ holder[NextSeat(r)] # "none"

Acquire(r) ==
    /\ pc[r] = "active" /\ Wants(r)
    /\ holder[NextSeat(r)] = "none"
    /\ holder' = [holder EXCEPT ![NextSeat(r)] = r]
    /\ idx'    = [idx EXCEPT ![r] = @ + 1]
    /\ UNCHANGED <<order, pc>>

\* "nowait" only. In the blocking modes a contended Acquire is simply not
\* enabled: the request waits.
Fail(r) ==
    /\ AcqMode = "nowait"
    /\ Contended(r)
    /\ holder' = Release(r)
    /\ pc'     = [pc EXCEPT ![r] = "aborted"]
    /\ UNCHANGED <<order, idx>>

Commit(r) ==
    /\ pc[r] = "active" /\ ~Wants(r)
    /\ holder' = Release(r)
    /\ pc'     = [pc EXCEPT ![r] = "committed"]
    /\ UNCHANGED <<order, idx>>

\* All requests resolved: stutter, so TLC's built-in deadlock check flags only
\* a genuinely stuck non-terminal state.
Terminated ==
    /\ \A r \in Requests : pc[r] \in {"committed", "aborted"}
    /\ UNCHANGED vars

Next ==
    \/ \E r \in Requests : Acquire(r) \/ Fail(r) \/ Commit(r)
    \/ Terminated

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
\* r is waiting: contended, and the only thing it can do is wait. In "nowait" a
\* contended request is never waiting - its Fail step is enabled, it aborts.
Waiting(r) == Contended(r) /\ AcqMode # "nowait"

\* The wait-for graph: r1 -> r2 when r1 is waiting on a lock r2 holds. In
\* "nowait" it is empty by construction, so NoWaitForCycle there is trivially
\* true; the substantive checks for that mode are TLC's stuck-state check (a
\* request left waiting would be a non-terminal state with no step) and the
\* NoConflictAbort vacuity guard showing contention really happens.
WaitsOn(r1, r2) == Waiting(r1) /\ holder[NextSeat(r1)] = r2

RECURSIVE Reach(_, _)
Reach(S, n) ==
    IF n = 0 THEN S
    ELSE Reach(S \cup {r2 \in Requests : \E r1 \in S : WaitsOn(r1, r2)}, n - 1)

\* r lies on a wait-for cycle: r is reachable from its own successors. A
\* cycle through r can need at most Cardinality(Requests) hops.
InCycle(r) == r \in Reach({r2 \in Requests : WaitsOn(r, r2)}, Cardinality(Requests))

TypeOK ==
    /\ order  \in [Requests -> AllowedOrders]
    /\ idx    \in [Requests -> Nat]
    /\ \A r \in Requests : idx[r] <= Len(order[r])
    /\ holder \in [Seats -> Requests \cup {"none"}]
    /\ pc     \in [Requests -> {"active", "committed", "aborted"}]
    \* A held lock is held by a request that has it in its acquired prefix.
    /\ \A s \in Seats : holder[s] # "none" =>
          \E i \in 1..idx[holder[s]] : order[holder[s]][i] = s

\* The property under test: no reachable state has a wait-for cycle.
NoWaitForCycle == \A r \in Requests : ~InCycle(r)

\* Vacuity guards, expected to be VIOLATED. Without them "no cycle" could be
\* passing on a model whose requests never actually contend.
\*
\* Blocking modes: a request is stuck waiting while already holding a lock.
\* Hold-and-wait is the necessary ingredient of a deadlock; "sorted" must
\* reach it (and still have no cycle).
NoHoldAndWait == \A r \in Requests : ~(Waiting(r) /\ HeldBy(r) # {})

\* "nowait": a request actually lost a conflict and aborted while another
\* request went on to commit the seats it was contending for.
NoConflictAbort ==
    ~( (\E r \in Requests : pc[r] = "aborted")
       /\ (\E r \in Requests : pc[r] = "committed") )
=============================================================================
