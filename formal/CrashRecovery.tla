--------------------------- MODULE CrashRecovery -----------------------------
(***************************************************************************)
(* Faults, ambiguous commits and idempotent retry (RaceToSeat, Phase 6 /   *)
(* F4).                                                                    *)
(*                                                                         *)
(* A separate module on top of F3's picture (SeatLifecycle.tla): the same *)
(* Hold -> Confirm -> Booking flow, Expire, Reaper and Cancel for          *)
(* `pessimistic` (ADR-0017), now with                                      *)
(*   - Crash: the backend serving one request dies at any step             *)
(*   - an Ambiguous outcome: the commit is durable, the ack never arrives  *)
(*   - an Idempotency Key on every request and the real lookup-then-insert *)
(*     path, including its race with a concurrent same-key request.        *)
(*                                                                         *)
(* A "request" here is one ATTEMPT. Two attempts carrying the same key are *)
(* the same logical request, so a client retry, a double-click and a       *)
(* duplicate from another user are all just "another attempt with this      *)
(* key" -- nothing distinguishes them to the server. `prof[r]` fixes, at   *)
(* Init, what attempt r does:                                              *)
(*   book    POST /bookings  src/strategies/pessimistic.ts                 *)
(*   hold    POST /holds     src/strategies/pessimisticHold.ts             *)
(*   confirm POST /holds/:id/confirm  src/strategies/pessimisticConfirm.ts *)
(* A confirm has no client key: it is keyed by its Hold ("hold-confirm:    *)
(* <id>"), so two confirm attempts on one Hold are retries of each other.  *)
(* A Hold's id is the attempt that created it; a client can confirm only a *)
(* Hold whose id it has learned (an ack, or a replay).                     *)
(*                                                                         *)
(* One attempt, step by step (book/hold; confirm is analogous below):      *)
(*   Begin      the fast-path lookup of the key: a committed row with this *)
(*              key -> replay, no transaction at all                       *)
(*   Lock       SELECT ... FOR UPDATE NOWAIT: a seat locked by another     *)
(*              in-flight transaction, or not 'available' -> a refusal     *)
(*   Recheck    (RF2, ADR-0031) before a refusal is answered 409 the key   *)
(*              is read once more on a fresh read: a committed row with    *)
(*              it -> replay, a tombstone -> 410, else 409                 *)
(*   InsertKey  INSERT INTO bookings|holds (idempotency_key). The UNIQUE   *)
(*              index entry of an in-flight insert makes a same-key        *)
(*              inserter WAIT; if the other commits this one gets a        *)
(*              unique violation and resolves to a replay                  *)
(*              (resolveIdempotencyKeyRace); if it aborts this one goes on *)
(*   Commit     the writes become durable                                  *)
(*   Ack        the client hears 201                                       *)
(* Crash may fire at every in-flight step. Before Commit it discards the   *)
(* transaction's writes and releases its locks; at "unacked" the write is  *)
(* durable and only the ack is lost -- that is the Ambiguous outcome. The  *)
(* client cannot tell the two apart, so both land in pc = "crashed".       *)
(*                                                                         *)
(* The fault assumptions (Postgres releases a dead backend's locks and     *)
(* undoes its uncommitted writes; a commit that returned is durable) are   *)
(* CrashMode switches, each with a mutation that must be caught.           *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
    Requests,    \* attempts
    Seats,
    Keys,        \* idempotency keys clients may attach to book / hold attempts
    NoKey,       \* filler model values for profile fields a kind does not use
    NoTgt,
    MaxCrashes,  \* how many Faults may fire in one run ("no further faults" = budget spent)
    LookupMode,  \* "lookup" | "skip": does the retry path look the key up?
    KeyMode,     \* "unique" | "none": UNIQUE constraint on the key column?
    CrashMode,   \* "clean" | "loseCommitted" | "keepUncommitted" | "keepLocks" | "keepPending"
    ExpiryMode,  \* "checked" | "unchecked": does Confirm check the Hold's expiry?
    CancelMode,  \* "on" | "off"
    RecheckMode, \* "recheck" | "taken" | "none": is a refusal re-read against the key before it is answered 409? (RF2, ADR-0031)
                 \* "taken" re-reads only a refusal caused by a taken seat, not one caused by a lock another transaction holds
    TombMode,    \* "retain" | "forget": does a released Booking/Hold leave its key a tombstone? (RF1, ADR-0030)
    GuardMode,   \* "on" | "off": does the INSERT itself refuse a tombstoned key (the trigger)?
    TrackStage   \* TRUE only for the witness configs: remember the step a Crash hit

ASSUME LookupMode \in {"lookup", "skip"}
ASSUME KeyMode    \in {"unique", "none"}
ASSUME CrashMode  \in {"clean", "loseCommitted", "keepUncommitted", "keepLocks", "keepPending"}
ASSUME ExpiryMode \in {"checked", "unchecked"}
ASSUME CancelMode \in {"on", "off"}
ASSUME RecheckMode \in {"recheck", "taken", "none"}
ASSUME TombMode   \in {"retain", "forget"}
ASSUME GuardMode  \in {"on", "off"}
ASSUME TrackStage \in BOOLEAN

VARIABLES
    prof,         \* prof[r]: what attempt r is -- fixed at Init, see Profiles
    pc,           \* pc[r]: where attempt r is, see TypeOK
    seat,         \* seat[s]: seats.status (durable)
    locked,       \* locked[r]: row locks r's open transaction holds
    pendKey,      \* pendKey[r]: r's open transaction holds an uncommitted row with its key
    holdRows,     \* holdRows[r]: seats with a durable hold_seats row of the Hold r created
    bookRows,     \* bookRows[r]: seats with a durable booking_seats row of the Booking r created
    expired,      \* expired[h]: Hold h passed its TTL (monotonic, as in F3)
    known,        \* known[h]: some client has learned Hold h's id (ack or replay)
    liveAtCheck,  \* liveAtCheck[c]: confirm c saw its Hold unexpired when it checked
    nconf,        \* nconf[h]: Confirms that committed on Hold h
    reaped,       \* reaped[h]: the Reaper released Hold h
    cancelled,    \* cancelled[r]: the Booking r created was cancelled
    durable,      \* durable[r]: r's Commit happened (ghost: never cleared by a crash)
    solo,         \* solo[r]: no same-key attempt was ever in flight alongside r (ghost)
    sawKey,       \* sawKey[r]: a committed same-key row existed when r got its 409/404 (ghost)
    ncrash,       \* Faults fired so far
    crashedAt     \* crashedAt[r]: step r's Crash hit (only tracked under TrackStage)

vars == <<prof, pc, seat, locked, pendKey, holdRows, bookRows, expired, known, liveAtCheck,
          nconf, reaped, cancelled, durable, solo, sawKey, ncrash, crashedAt>>

SeatSets == {S \in SUBSET Seats : Cardinality(S) \in 1..2}

\* What an attempt is. Unused fields hold a filler so equal attempts are equal states.
Profiles ==
    { [kind |-> k, want |-> S, key |-> ky, tgt |-> NoTgt] :
          k \in {"book", "hold"}, S \in SeatSets, ky \in Keys }
    \cup
    { [kind |-> "confirm", want |-> {}, key |-> NoKey, tgt |-> h] : h \in Requests }

Kind(r) == prof[r].kind
Want(r) == prof[r].want
Key(r)  == prof[r].key
Tgt(r)  == prof[r].tgt

IsBooker(r) == Kind(r) \in {"book", "confirm"}      \* creates rows in `bookings`
\* The seats a Booking written by r holds: a confirm books its Hold's seats.
WantOf(r) == IF Kind(r) = "confirm" THEN Want(Tgt(r)) ELSE Want(r)

\* Two attempts that are the same logical request. Bookings and Holds have
\* separate UNIQUE columns, and a confirm's synthesized key ("hold-confirm:<id>")
\* is prefixed so it can never equal a client's key.
SameBKey(r, q) == r # q /\ IsBooker(r) /\ IsBooker(q)
                  /\ IF Kind(r) = "confirm"
                        THEN Kind(q) = "confirm" /\ Tgt(r) = Tgt(q)
                        ELSE Kind(q) = "book" /\ Key(r) = Key(q)
SameHKey(r, q) == r # q /\ Kind(r) = "hold" /\ Kind(q) = "hold" /\ Key(r) = Key(q)
SameKey(r, q)  == SameBKey(r, q) \/ SameHKey(r, q)

\* "refused": the Lock step found a conflict; the answer is not yet given (RF2's re-read comes first).
InFlight == {"begun", "locked", "keyed", "unacked", "clocked", "refused"}
\* "released": the key's Booking/Hold existed and was released (tombstone) -> 410 key_released.
\* "race_released": the same, found only at the INSERT (guard trigger -> unique violation -> resolve).
\* "late_replay": the same, found by the re-read that precedes a 409 (RF2).
Answered == {"created", "replay", "race_replay", "late_replay", "released", "race_released", "conflict", "not_found", "expired"}
Terminal == Answered \cup {"crashed"}

Avail(S) == \A s \in S : seat[s] = "available"
SetSeats(S, v) == [s \in Seats |-> IF s \in S THEN v ELSE seat[s]]
Only(f, r, v) == [f EXCEPT ![r] = v]

\* A committed row carries r's key (what findExisting*ByIdempotencyKey sees;
\* uncommitted rows are invisible to a plain read).
KeyCommitted(r) == \E q \in Requests : SameKey(r, q) /\ (bookRows[q] # {} \/ holdRows[q] # {})

\* The Booking/Hold r's key once created has been released (Cancel / Confirm / reap). Under
\* TombMode "retain" its tombstone, committed in the same statement as the release, is what
\* findPriorBookingForKey / findPriorHoldForKey and the guard trigger see (ADR-0030); under "forget"
\* (today's pre-RF1 behavior, kept as a negative control) the key leaves with its row.
\* Only a book / hold attempt consults it: a confirm's synthesized key never does (it answers
\* 404 once its hold is gone, as before). The retention horizon is not modeled -- the model is
\* "within the retention window".
RowReleased(q) == IF IsBooker(q) THEN cancelled[q] ELSE reaped[q] \/ nconf[q] > 0
KeyReleased(r) == /\ TombMode = "retain" /\ Kind(r) \in {"book", "hold"}
                  /\ \E q \in Requests : SameKey(r, q) /\ Kind(q) \in {"book", "hold"} /\ RowReleased(q)

\* A replay of a Hold teaches the client the Hold's id.
LearnHold(r) == [q \in Requests |->
                    known[q] \/ (Kind(r) = "hold" /\ SameHKey(r, q) /\ holdRows[q] # {})]

-----------------------------------------------------------------------------
Init ==
    /\ prof \in [Requests -> Profiles]
    /\ \A r \in Requests : Kind(r) = "confirm" => Kind(Tgt(r)) = "hold"
    /\ pc          = [r \in Requests |-> "idle"]
    /\ seat        = [s \in Seats |-> "available"]
    /\ locked      = [r \in Requests |-> {}]
    /\ pendKey     = [r \in Requests |-> FALSE]
    /\ holdRows    = [r \in Requests |-> {}]
    /\ bookRows    = [r \in Requests |-> {}]
    /\ expired     = [r \in Requests |-> FALSE]
    /\ known       = [r \in Requests |-> FALSE]
    /\ liveAtCheck = [r \in Requests |-> FALSE]
    /\ nconf       = [r \in Requests |-> 0]
    /\ reaped      = [r \in Requests |-> FALSE]
    /\ cancelled   = [r \in Requests |-> FALSE]
    /\ durable     = [r \in Requests |-> FALSE]
    /\ solo        = [r \in Requests |-> TRUE]
    /\ sawKey      = [r \in Requests |-> FALSE]
    /\ ncrash      = 0
    /\ crashedAt   = [r \in Requests |-> "none"]

\* Step 1 of every attempt: the fast-path key lookup. A committed row with this
\* key means the client gets that row back and no transaction is opened; a tombstone for it
\* (its row was released) means 410 key_released, again with no transaction. One query sees
\* both. `skip` (negative control) removes the lookup from the retry path.
\* solo[] records whether any same-key attempt overlapped this one.
Begin(r) ==
    /\ pc[r] = "idle"
    /\ IF Kind(r) = "confirm" THEN known[Tgt(r)] ELSE TRUE   \* the client must know the Hold id
    /\ solo' = [q \in Requests |->
                  IF q = r THEN \A p \in Requests : ~(SameKey(r, p) /\ pc[p] \in InFlight)
                  ELSE IF SameKey(r, q) /\ pc[q] \in InFlight THEN FALSE ELSE solo[q]]
    /\ IF LookupMode = "lookup" /\ KeyCommitted(r)
          THEN /\ pc'    = Only(pc, r, "replay")
               /\ known' = LearnHold(r)
          ELSE IF LookupMode = "lookup" /\ KeyReleased(r)
          THEN /\ pc'    = Only(pc, r, "released")
               /\ UNCHANGED known
          ELSE /\ pc'    = Only(pc, r, "begun")
               /\ UNCHANGED known
    /\ UNCHANGED <<prof, seat, locked, pendKey, holdRows, bookRows, expired, liveAtCheck,
                   nconf, reaped, cancelled, durable, sawKey, ncrash, crashedAt>>

\* SELECT id, status FROM seats WHERE id = ANY($1) FOR UPDATE NOWAIT (book / hold).
\* A seat locked by another open transaction fails the statement (55P03 -> 409);
\* a seat that is not 'available' fails the request (409). Otherwise the locks are taken.
Lock(r) ==
    /\ Kind(r) \in {"book", "hold"} /\ pc[r] = "begun"
    /\ IF (\E q \in Requests \ {r} : locked[q] \cap Want(r) # {}) \/ ~Avail(Want(r))
          THEN /\ IF RecheckMode = "recheck"
                      \/ (RecheckMode = "taken" /\ ~(\E q \in Requests \ {r} : locked[q] \cap Want(r) # {}))
                     THEN /\ pc'     = Only(pc, r, "refused")
                          /\ UNCHANGED sawKey
                     ELSE /\ pc'     = Only(pc, r, "conflict")
                          /\ sawKey' = Only(sawKey, r, KeyCommitted(r))
               /\ UNCHANGED locked
          ELSE /\ pc'     = Only(pc, r, "locked")
               /\ locked' = Only(locked, r, Want(r))
               /\ UNCHANGED sawKey
    /\ UNCHANGED <<prof, seat, pendKey, holdRows, bookRows, expired, known, liveAtCheck,
                   nconf, reaped, cancelled, durable, solo, ncrash, crashedAt>>

\* RF2 (ADR-0031): the step that closes the window. A refusal -- a seat locked by another
\* open transaction (an in-flight original, a losing attempt, a confirm) or already taken -- is
\* not answered 409 until the key has been read once more, on a fresh read taken AFTER the
\* refusal was observed (findPriorBookingForKey / findPriorHoldForKey on the connection that
\* just ended its transaction): a committed row with the key -> replay; a tombstone -> 410
\* key_released (as at Begin); neither -> 409. The attempt holds no locks here and has written
\* nothing, so a crash at this step is the same as one at "begun" and is not modeled separately.
\* sawKey records what this read saw, so an answered 409 carries "no committed row at that read".
Recheck(r) ==
    /\ pc[r] = "refused"
    /\ IF KeyCommitted(r)
          THEN /\ pc'     = Only(pc, r, "late_replay")
               /\ known'  = LearnHold(r)
               /\ UNCHANGED sawKey
          ELSE IF KeyReleased(r)
          THEN /\ pc'     = Only(pc, r, "released")
               /\ UNCHANGED <<known, sawKey>>
          ELSE /\ pc'     = Only(pc, r, "conflict")
               /\ sawKey' = Only(sawKey, r, KeyCommitted(r))
               /\ UNCHANGED known
    /\ UNCHANGED <<prof, seat, locked, pendKey, holdRows, bookRows, expired, liveAtCheck,
                   nconf, reaped, cancelled, durable, solo, ncrash, crashedAt>>

\* INSERT INTO bookings|holds (..., idempotency_key). With the UNIQUE constraint:
\*   - an uncommitted same-key row in another open transaction: the insert WAITS
\*     (not enabled) until that transaction ends;
\*   - a committed same-key row: unique violation, rollback, resolve to the winner's
\*     row (resolveIdempotencyKeyRace) -> "race_replay";
\*   - a tombstoned key (the original was released since this attempt's lookup): the guard
\*     trigger raises a unique violation, rollback, resolve -> "race_released" (410);
\*   - otherwise the row is written, uncommitted.
\* KeyMode "none" drops the constraint, GuardMode "off" the trigger (negative controls).
InsertKey(r) ==
    /\ Kind(r) \in {"book", "hold"} /\ pc[r] = "locked"
    /\ ~(KeyMode = "unique" /\ \E q \in Requests : pendKey[q] /\ SameKey(r, q))
    /\ IF KeyMode = "unique" /\ KeyCommitted(r)
          THEN /\ pc'      = Only(pc, r, "race_replay")
               /\ locked'  = Only(locked, r, {})
               /\ known'   = LearnHold(r)
               /\ UNCHANGED pendKey
          ELSE IF GuardMode = "on" /\ KeyReleased(r)
          THEN /\ pc'      = Only(pc, r, "race_released")
               /\ locked'  = Only(locked, r, {})
               /\ UNCHANGED <<pendKey, known>>
          ELSE /\ pc'      = Only(pc, r, "keyed")
               /\ pendKey' = Only(pendKey, r, TRUE)
               /\ UNCHANGED <<locked, known>>
    /\ UNCHANGED <<prof, seat, holdRows, bookRows, expired, liveAtCheck, nconf, reaped,
                   cancelled, durable, solo, sawKey, ncrash, crashedAt>>

\* COMMIT (book / hold): the booking_seats|hold_seats rows and the seats UPDATE
\* become visible together, the locks and the pending key row go away. From here
\* on the write is durable whether or not the client ever hears about it.
Commit(r) ==
    /\ Kind(r) \in {"book", "hold"} /\ pc[r] = "keyed"
    /\ IF Kind(r) = "book"
          THEN /\ seat'     = SetSeats(Want(r), "booked")
               /\ bookRows' = Only(bookRows, r, Want(r))
               /\ UNCHANGED holdRows
          ELSE /\ seat'     = SetSeats(Want(r), "held")
               /\ holdRows' = Only(holdRows, r, Want(r))
               /\ UNCHANGED bookRows
    /\ locked'  = Only(locked, r, {})
    /\ pendKey' = Only(pendKey, r, FALSE)
    /\ durable' = Only(durable, r, TRUE)
    /\ pc'      = Only(pc, r, "unacked")
    /\ UNCHANGED <<prof, expired, known, liveAtCheck, nconf, reaped, cancelled, solo, sawKey,
                   ncrash, crashedAt>>

\* The response reaches the client (201). For a Hold it also teaches the client the id.
Ack(r) ==
    /\ pc[r] = "unacked"
    /\ pc'    = Only(pc, r, "created")
    /\ known' = IF Kind(r) = "hold" THEN Only(known, r, TRUE) ELSE known
    /\ UNCHANGED <<prof, seat, locked, pendKey, holdRows, bookRows, expired, liveAtCheck, nconf,
                   reaped, cancelled, durable, solo, sawKey, ncrash, crashedAt>>

-----------------------------------------------------------------------------
\* POST /holds/:id/confirm, first half (confirmHoldPessimistic): after the key
\* fast path, one JOIN ... FOR UPDATE OF s NOWAIT statement over the Hold's seats.
\* The four outcomes are the four actions below.
\* (a) the Hold's seats are locked by another open transaction: 409
CLockConflict(r) ==
    /\ Kind(r) = "confirm" /\ pc[r] = "begun"
    /\ holdRows[Tgt(r)] # {}
    /\ \E q \in Requests \ {r} : locked[q] \cap holdRows[Tgt(r)] # {}
    /\ pc'     = Only(pc, r, "conflict")
    /\ sawKey' = Only(sawKey, r, KeyCommitted(r))
    /\ UNCHANGED <<prof, seat, locked, pendKey, holdRows, bookRows, expired, known, liveAtCheck,
                   nconf, reaped, cancelled, durable, solo, ncrash, crashedAt>>

\* (b) no hold_seats rows (never created, already confirmed, or reaped): the in-
\* transaction fallback key lookup -> replay the Booking if one carries the confirm
\* key, else 404. `skip` removes that lookup too.
CLockGone(r) ==
    /\ Kind(r) = "confirm" /\ pc[r] = "begun"
    /\ holdRows[Tgt(r)] = {}
    /\ IF LookupMode = "lookup" /\ KeyCommitted(r)
          THEN /\ pc' = Only(pc, r, "replay")
               /\ UNCHANGED sawKey
          ELSE /\ pc'     = Only(pc, r, "not_found")
               /\ sawKey' = Only(sawKey, r, KeyCommitted(r))
    /\ UNCHANGED <<prof, seat, locked, pendKey, holdRows, bookRows, expired, known, liveAtCheck,
                   nconf, reaped, cancelled, durable, solo, ncrash, crashedAt>>

\* (c) the lazy expiry check (ADR-0018): held_until <= now() -> 410.
\* ExpiryMode "unchecked" is a negative control.
CLockExpired(r) ==
    /\ Kind(r) = "confirm" /\ pc[r] = "begun"
    /\ holdRows[Tgt(r)] # {}
    /\ ~(\E q \in Requests \ {r} : locked[q] \cap holdRows[Tgt(r)] # {})
    /\ ExpiryMode = "checked" /\ expired[Tgt(r)]
    /\ pc' = Only(pc, r, "expired")
    /\ UNCHANGED <<prof, seat, locked, pendKey, holdRows, bookRows, expired, known, liveAtCheck,
                   nconf, reaped, cancelled, durable, solo, sawKey, ncrash, crashedAt>>

\* (d) the Hold is live: the row locks are held ("clocked"), expiry as of this check.
CLockOk(r) ==
    /\ Kind(r) = "confirm" /\ pc[r] = "begun"
    /\ holdRows[Tgt(r)] # {}
    /\ ~(\E q \in Requests \ {r} : locked[q] \cap holdRows[Tgt(r)] # {})
    /\ (ExpiryMode = "unchecked" \/ ~expired[Tgt(r)])
    /\ pc'          = Only(pc, r, "clocked")
    /\ locked'      = Only(locked, r, holdRows[Tgt(r)])
    /\ liveAtCheck' = Only(liveAtCheck, r, ~expired[Tgt(r)])
    /\ UNCHANGED <<prof, seat, pendKey, holdRows, bookRows, expired, known, nconf, reaped,
                   cancelled, durable, solo, sawKey, ncrash, crashedAt>>

CLock(r) == CLockConflict(r) \/ CLockGone(r) \/ CLockExpired(r) \/ CLockOk(r)

\* Second half: insertBookingForSeats (key = hold-confirm:<id>) + the DELETE of
\* hold_seats/holds, one transaction. No UNIQUE violation is reachable here: the
\* Hold's row locks serialize confirms, and the Hold's rows are gone once one commits.
CCommit(r) ==
    /\ Kind(r) = "confirm" /\ pc[r] = "clocked"
    /\ seat'     = SetSeats(Want(Tgt(r)), "booked")
    /\ holdRows' = Only(holdRows, Tgt(r), {})
    /\ bookRows' = Only(bookRows, r, Want(Tgt(r)))
    /\ nconf'    = Only(nconf, Tgt(r), nconf[Tgt(r)] + 1)
    /\ locked'   = Only(locked, r, {})
    /\ durable'  = Only(durable, r, TRUE)
    /\ pc'       = Only(pc, r, "unacked")
    /\ UNCHANGED <<prof, pendKey, expired, known, liveAtCheck, reaped, cancelled, solo, sawKey,
                   ncrash, crashedAt>>

-----------------------------------------------------------------------------
\* The Fault. The client sees one thing -- a severed connection -- whichever step it
\* hit, so every Crash ends in pc = "crashed". What differs is what Postgres keeps.
\*
\* Before COMMIT: the transaction is rolled back. Its locks and its pending key row
\* disappear, and nothing it wrote is visible.
\*   keepLocks / keepPending (negative controls): the dead backend's lock / in-flight
\*     unique-index entry is never released.
\*   keepUncommitted (negative control): the UPDATE of seats survives without the rows.
CrashBeforeCommit(r) ==
    /\ pc[r] \in {"begun", "locked", "keyed", "clocked"}
    /\ ncrash < MaxCrashes
    /\ pc'      = Only(pc, r, "crashed")
    /\ ncrash'  = ncrash + 1
    /\ locked'  = IF CrashMode = "keepLocks" THEN locked ELSE Only(locked, r, {})
    /\ pendKey' = IF CrashMode = "keepPending" THEN pendKey ELSE Only(pendKey, r, FALSE)
    /\ IF CrashMode = "keepUncommitted" /\ pc[r] \in {"keyed", "clocked"}
          THEN seat' = SetSeats(WantOf(r), IF Kind(r) = "hold" THEN "held" ELSE "booked")
          ELSE UNCHANGED seat
    /\ crashedAt' = IF TrackStage THEN Only(crashedAt, r, pc[r]) ELSE crashedAt
    /\ UNCHANGED <<prof, holdRows, bookRows, expired, known, liveAtCheck, nconf, reaped,
                   cancelled, durable, solo, sawKey>>

\* After COMMIT, before the ack: commit-then-crash. The write is durable and stays;
\* only the client's knowledge is lost (the Ambiguous outcome).
\*   loseCommitted (negative control): the crash un-commits a book / hold write.
CrashAfterCommit(r) ==
    /\ pc[r] = "unacked"
    /\ ncrash < MaxCrashes
    /\ pc'     = Only(pc, r, "crashed")
    /\ ncrash' = ncrash + 1
    /\ IF CrashMode = "loseCommitted" /\ Kind(r) \in {"book", "hold"}
          THEN /\ seat'     = SetSeats(Want(r), "available")
               /\ bookRows' = Only(bookRows, r, {})
               /\ holdRows' = Only(holdRows, r, {})
          ELSE UNCHANGED <<seat, bookRows, holdRows>>
    /\ crashedAt' = IF TrackStage THEN Only(crashedAt, r, "unacked") ELSE crashedAt
    /\ UNCHANGED <<prof, locked, pendKey, expired, known, liveAtCheck, nconf, reaped, cancelled,
                   durable, solo, sawKey>>

Crash(r) == CrashBeforeCommit(r) \/ CrashAfterCommit(r)

-----------------------------------------------------------------------------
\* Time passes for a Hold that still exists (monotonic flag, as in F3).
Expire(h) ==
    /\ Kind(h) = "hold" /\ holdRows[h] # {} /\ ~expired[h]
    /\ expired' = Only(expired, h, TRUE)
    /\ UNCHANGED <<prof, pc, seat, locked, pendKey, holdRows, bookRows, known, liveAtCheck, nconf,
                   reaped, cancelled, durable, solo, sawKey, ncrash, crashedAt>>

\* The Reaper (guarded form only; F3 covers its mutations): an expired Hold whose
\* seats no in-flight confirm has locked is released, seats back to 'available'.
Reap(h) ==
    /\ Kind(h) = "hold" /\ holdRows[h] # {} /\ expired[h]
    /\ ~(\E c \in Requests : Kind(c) = "confirm" /\ Tgt(c) = h /\ pc[c] = "clocked")
    /\ seat'     = SetSeats(holdRows[h], "available")
    /\ holdRows' = Only(holdRows, h, {})
    /\ reaped'   = Only(reaped, h, TRUE)
    /\ UNCHANGED <<prof, pc, locked, pendKey, bookRows, expired, known, liveAtCheck, nconf,
                   cancelled, durable, solo, sawKey, ncrash, crashedAt>>

\* DELETE /bookings/:id, for a Booking from either path. The row is deleted outright
\* (ADR-0020); its key survives as a tombstone written by the same statement (ADR-0030,
\* RowReleased / KeyReleased above). Likewise Confirm and the Reaper for a Hold's key.
Cancel(r) ==
    /\ CancelMode = "on"
    /\ IsBooker(r) /\ bookRows[r] # {}
    /\ seat'      = SetSeats(bookRows[r], "available")
    /\ bookRows'  = Only(bookRows, r, {})
    /\ cancelled' = Only(cancelled, r, TRUE)
    /\ UNCHANGED <<prof, pc, locked, pendKey, holdRows, expired, known, liveAtCheck, nconf,
                   reaped, durable, solo, sawKey, ncrash, crashedAt>>

\* Every attempt finished (or a confirm whose Hold id nobody learned and nobody can):
\* stutter, so TLC's deadlock check flags only a genuinely stuck attempt.
Terminated ==
    /\ \A r \in Requests :
         \/ pc[r] \in Terminal
         \/ (pc[r] = "idle" /\ Kind(r) = "confirm" /\ ~known[Tgt(r)])
    /\ UNCHANGED vars

Next ==
    \/ \E r \in Requests :
         \/ Begin(r) \/ Lock(r) \/ Recheck(r) \/ InsertKey(r) \/ Commit(r) \/ Ack(r)
         \/ CLock(r) \/ CCommit(r)
         \/ Crash(r)
         \/ Expire(r) \/ Reap(r) \/ Cancel(r)
    \/ Terminated

Spec == Init /\ [][Next]_vars

\* Fairness: every attempt that can take a step eventually does. Crashes, time and
\* cancellation have none -- the environment may or may not use them.
Progress(r) == Begin(r) \/ Lock(r) \/ Recheck(r) \/ InsertKey(r) \/ Commit(r) \/ Ack(r) \/ CLock(r) \/ CCommit(r)
SpecFair   == Spec /\ \A r \in Requests : WF_vars(Progress(r))

\* TLC symmetry: requests, seats and keys are interchangeable. Safety configs only
\* (TLC's symmetry reduction is unsound for liveness).
Sym == Permutations(Requests) \cup Permutations(Seats) \cup Permutations(Keys)

-----------------------------------------------------------------------------
TypeOK ==
    /\ prof        \in [Requests -> Profiles]
    /\ pc          \in [Requests -> {"idle"} \cup InFlight \cup Terminal]
    /\ seat        \in [Seats -> {"available", "held", "booked"}]
    /\ locked      \in [Requests -> SUBSET Seats]
    /\ pendKey     \in [Requests -> BOOLEAN]
    /\ holdRows    \in [Requests -> SUBSET Seats]
    /\ bookRows    \in [Requests -> SUBSET Seats]
    /\ expired     \in [Requests -> BOOLEAN]
    /\ known       \in [Requests -> BOOLEAN]
    /\ liveAtCheck \in [Requests -> BOOLEAN]
    /\ nconf       \in [Requests -> 0..2]
    /\ reaped      \in [Requests -> BOOLEAN]
    /\ cancelled   \in [Requests -> BOOLEAN]
    /\ durable     \in [Requests -> BOOLEAN]
    /\ solo        \in [Requests -> BOOLEAN]
    /\ sawKey      \in [Requests -> BOOLEAN]
    /\ ncrash      \in 0..MaxCrashes
    /\ crashedAt   \in [Requests -> {"none", "begun", "locked", "keyed", "unacked", "clocked"}]

Owned(r) == holdRows[r] \cup bookRows[r]

\* ---- F1 / F3 invariants, re-checked with Crash enabled ---------------------

\* A seat belongs to at most one of {Booking, Hold} (mutual exclusion).
SeatBelongsToAtMostOne ==
    /\ \A r1, r2 \in Requests : r1 # r2 => Owned(r1) \cap Owned(r2) = {}
    /\ \A r \in Requests : holdRows[r] \cap bookRows[r] = {}

\* seats.status agrees with the hold_seats / booking_seats rows.
SeatStatusAgrees ==
    \A s \in Seats :
        /\ seat[s] = "held"   <=> \E r \in Requests : s \in holdRows[r]
        /\ seat[s] = "booked" <=> \E r \in Requests : s \in bookRows[r]

\* A Booking holds exactly the seats it was for, a Hold exactly its own: never partial.
Atomicity ==
    \A r \in Requests :
        /\ bookRows[r] \in {{}, WantOf(r)}
        /\ holdRows[r] \in {{}, Want(r)}
        /\ (IsBooker(r)        \/ bookRows[r] = {})
        /\ (Kind(r) = "hold"   \/ holdRows[r] = {})

\* A Hold is confirmed at most once, however many confirms are retried or crash.
HoldConfirmedAtMostOnce == \A r \in Requests : nconf[r] <= 1

\* No Confirm succeeds (is in flight with its locks, or durable) on a Hold that was
\* already expired when the confirm checked it.
NoConfirmOnExpired ==
    \A c \in Requests : (Kind(c) = "confirm" /\ (pc[c] = "clocked" \/ durable[c])) => liveAtCheck[c]

\* The Reaper only releases expired Holds.
ReapOnlyExpired == \A r \in Requests : reaped[r] => expired[r]

\* ---- F4 invariants ----------------------------------------------------------

\* The UNIQUE constraint's consequence, as the Oracle sees it (ADR-0022, Oracle 3):
\* at most one live Booking per key, and at most one live Hold per key.
KeyAtMostOneBooking ==
    \A r, q \in Requests : SameBKey(r, q) => ~(bookRows[r] # {} /\ bookRows[q] # {})
KeyAtMostOneHold ==
    \A r, q \in Requests : SameHKey(r, q) => ~(holdRows[r] # {} /\ holdRows[q] # {})

\* Fault assumption 1: a dead backend leaves nothing behind. Only an open transaction
\* holds row locks or an in-flight key row.
NoOrphanState ==
    \A r \in Requests :
        /\ (locked[r] # {} => pc[r] \in {"locked", "keyed", "clocked"})
        /\ (pendKey[r]     => pc[r] = "keyed")

\* Fault assumption 2: a Commit survives its backend's death. Whatever committed
\* (acknowledged or ambiguous) is still there unless a legitimate later action removed it:
\* a Booking until Cancel, a Hold until Confirm or the Reaper.
CommittedPersists ==
    \A r \in Requests :
        durable[r] =>
          IF IsBooker(r) THEN bookRows[r] # {} \/ cancelled[r]
                         ELSE holdRows[r] # {} \/ reaped[r] \/ nconf[r] > 0

\* Recovery: a retry that overlapped no other same-key attempt never gets a 409/404
\* while a committed row carries its key -- if the key's row exists the retry must have
\* replayed it. (A retry that DID overlap another attempt may be told 409 by the race;
\* see KeyNeverFalselyRefused below.)
CleanConflict ==
    \A r \in Requests : (solo[r] /\ pc[r] \in {"conflict", "not_found"}) => ~sawKey[r]

\* Idempotency record lifetime: a key may create a second Booking/Hold only after the first
\* was released (Booking cancelled; Hold reaped or confirmed). True under both TombModes -- it
\* is the weak form, what the UNIQUE column alone gives. The strong form, which only the
\* tombstone gives, is BookingKeyCreatesAtMostOne / HoldKeyCreatesAtMostOne below.
\* Holds: with the UNIQUE constraint in force.
KeyReuseOnlyAfterRelease ==
    /\ \A r, q \in Requests :
         SameBKey(r, q) /\ durable[r] /\ durable[q] => cancelled[r] \/ cancelled[q]
    /\ \A r, q \in Requests :
         SameHKey(r, q) /\ durable[r] /\ durable[q] =>
           reaped[r] \/ reaped[q] \/ nconf[r] > 0 \/ nconf[q] > 0

\* The Ambiguous outcome specifically: if the client's earlier attempt with this key crashed
\* after COMMIT, a retry that overlapped nothing is never answered 409/404 -- it replays.
\* (Implied by CleanConflict; kept as its own name so the no-lookup control fails on the
\* statement the issue is about.)
AmbiguousRetryNotRefused ==
    \A r, q \in Requests :
        (SameKey(r, q) /\ solo[r] /\ pc[r] \in {"conflict", "not_found"}
         /\ pc[q] = "crashed" /\ durable[q]) => ~sawKey[r]

\* The same overlap cannot fool a confirm: its in-transaction fallback lookup (after the
\* locks, when the Hold's rows are gone) catches a Booking committed since the fast path.
ConfirmNeverFalselyRefused ==
    \A r \in Requests : (Kind(r) = "confirm" /\ pc[r] \in {"conflict", "not_found"}) => ~sawKey[r]

\* ---- RF1 (issue #60, ADR-0030): a key creates at most one Booking/Hold, EVER ---
\* History-based, the project glossary's "must never produce two Bookings or two Holds".
\* With the UNIQUE column as the key's only home (TombMode "forget", the behavior before
\* RF1) it was FALSE: after Cancel (Booking) or Reap / Confirm (Hold) the key was free
\* again (CrashForgetKeys / CrashForgetKeysHold keep that as a negative control). With
\* tombstones and the insert guard it holds (CrashFindingKeyReuse / CrashFindingHoldKeyReuse,
\* now positive checks); without the guard it fails on the lookup-then-insert window
\* (CrashNoInsertGuard*). Within the retention window -- the horizon is not modeled.
BookingKeyCreatesAtMostOne ==
    \A r, q \in Requests : SameBKey(r, q) => ~(durable[r] /\ durable[q])
HoldKeyCreatesAtMostOne ==
    \A r, q \in Requests : SameHKey(r, q) => ~(durable[r] /\ durable[q])

\* ---- RF2 (issue #61, ADR-0031): a concurrent same-key attempt is never falsely refused ----
\* A same-key book / hold attempt is never told 409 although the key's row is committed at the
\* moment the 409 is decided. Before the fix (RecheckMode "none": the 409 followed the lock
\* observation directly, with the key last read at Begin) it was FALSE: the original could commit
\* between the attempt's lookup and its lock (CrashNoRecheck keeps that as a negative control).
\* With the re-read it holds (CrashFindingSpuriousConflict, now a positive check).
KeyNeverFalselyRefused == \A r \in Requests : pc[r] \in {"conflict", "not_found"} => ~sawKey[r]

-----------------------------------------------------------------------------
\* Liveness (kept separable: CrashLive*.cfg only).

\* Nothing hangs: every in-flight attempt eventually finishes (commits, answers or crashes) --
\* including one waiting on another attempt's in-flight key row.
NoAttemptHangs ==
    \A r \in Requests : [](pc[r] \in InFlight => <>(pc[r] \notin InFlight))

\* Recovery (needs MaxCrashes = 1, i.e. "no further faults"): once an attempt has crashed,
\* any other attempt carrying its key that has yet to start gets a definite answer --
\* created, a replay of the existing row, or a conflict -- and does not hang or crash again.
RetryAfterCrashAnswers ==
    \A r, q \in Requests :
        [](( SameKey(r, q) /\ Kind(r) \in {"book", "hold"} /\ pc[r] = "crashed" /\ pc[q] = "idle")
           => <>(pc[q] \in Answered))

-----------------------------------------------------------------------------
\* Vacuity guards, each expected to be VIOLATED (CrashWitness*.cfg): the interesting
\* states -- the ones the invariants above are about -- are actually reached.

\* Commit-then-crash: durable, client never told.
NoAmbiguousCommit == ~(\E r \in Requests : pc[r] = "crashed" /\ durable[r])

\* A retry replays an ambiguous Booking / Hold (the whole point of the key).
NoReplayAfterAmbiguousBooking ==
    ~(\E r, q \in Requests : SameBKey(r, q) /\ Kind(r) = "book" /\ pc[q] = "crashed" /\ durable[q]
                             /\ pc[r] = "replay")
NoReplayAfterAmbiguousHold ==
    ~(\E r, q \in Requests : SameHKey(r, q) /\ pc[q] = "crashed" /\ durable[q] /\ pc[r] = "replay")

\* A retried Confirm replays the Booking an ambiguous Confirm committed.
NoReplayAfterAmbiguousConfirm ==
    ~(\E r, q \in Requests : SameBKey(r, q) /\ Kind(r) = "confirm" /\ pc[q] = "crashed" /\ durable[q]
                             /\ pc[r] = "replay")

\* RF1: a stale retry after Cancel / Confirm / reap is answered "released" (booking, hold),
\* including the race where it only learns so at the INSERT (the guard).
NoReleasedBooking == ~(\E r \in Requests : Kind(r) = "book" /\ pc[r] = "released")
NoReleasedHold    == ~(\E r \in Requests : Kind(r) = "hold" /\ pc[r] = "released")
NoReleasedRace    == ~(\E r \in Requests : pc[r] = "race_released")

\* RF2: the re-read before a 409 turns it into a replay, including the lock-failure half: the
\* attempt's seats are locked by another open transaction while the key's row is already committed.
NoLateReplay == ~(\E r \in Requests : pc[r] = "late_replay")
NoLateReplayWhileLocked ==
    ~(\E r, q \in Requests :
        /\ pc[r] = "refused" /\ KeyCommitted(r) /\ q # r /\ locked[q] \cap Want(r) # {})

\* The lookup-then-insert race ends in a unique violation resolved to a replay.
NoKeyRaceReplay == ~(\E r \in Requests : pc[r] = "race_replay")

\* An insert waits on another transaction's in-flight same-key row.
NoWaitOnKeyRow ==
    ~(\E r, q \in Requests : SameKey(r, q) /\ pc[r] = "locked" /\ pendKey[q])

\* The waiter is released by the other attempt's crash and then writes its own key row: some
\* attempt waits on a same-key in-flight row, the holder crashes BEFORE commit, the waiter proceeds to its
\* insert. (A PROPERTY, because it is about a path, not a state.)
NoUnblockedByCrash ==
    \A r, q \in Requests :
        [](( SameKey(r, q) /\ pc[r] = "locked" /\ pendKey[q])
           => [](~(pc[q] = "crashed" /\ ~durable[q] /\ pc[r] = "keyed")))

\* A crash mid-transaction (locks held) leaves its seats claimable by someone else:
\* the crashed attempt never committed, a different attempt got the same seats.
NoSeatReuseAfterMidCrash ==
    ~(\E r, q \in Requests :
        /\ pc[r] = "crashed" /\ ~durable[r] /\ crashedAt[r] \in {"locked", "keyed"} /\ q # r
        /\ Kind(r) \in {"book", "hold"} /\ Want(r) \cap WantOf(q) # {} /\ durable[q])

\* A Confirm crashes holding the Hold's row locks; afterwards the Reaper can release the
\* Hold, and a retried Confirm can commit it.
NoConfirmCrashMidTxn ==
    ~(\E c \in Requests : Kind(c) = "confirm" /\ pc[c] = "crashed" /\ crashedAt[c] = "clocked")
NoReapAfterConfirmCrash ==
    ~(\E c, h \in Requests : Kind(c) = "confirm" /\ Tgt(c) = h /\ pc[c] = "crashed"
                             /\ crashedAt[c] = "clocked" /\ reaped[h])
NoRetryConfirmAfterMidCrash ==
    ~(\E c, c2 \in Requests : Kind(c) = "confirm" /\ SameBKey(c, c2) /\ pc[c] = "crashed"
                             /\ crashedAt[c] = "clocked" /\ durable[c2])
=============================================================================
