-- Capacity enforcement for reservations (AGENTS.md / WS-02): Drizzle cannot
-- express a row-locked, joined aggregate check, so this is hand-written
-- alongside the generated migration, the same pattern the citext extension
-- and the play_pass_ledger append-only trigger established in 0000.
--
-- HELD, CONFIRMED, and CHECKED_IN consume a seat; CANCELLED and NO_SHOW do
-- not. That is what makes a cancellation free the seat with no extra
-- bookkeeping, and what makes a HELD row actually reserve capacity instead
-- of merely expressing interest.
CREATE FUNCTION "check_reservation_capacity"() RETURNS trigger AS $$
DECLARE
  effective_capacity integer;
  active_seats integer;
BEGIN
  -- Statuses that don't consume a seat never need enforcement. In
  -- particular this lets a cancellation proceed without taking the lock
  -- below, so freeing a seat is never blocked by contention for it.
  IF NEW.status NOT IN ('HELD', 'CONFIRMED', 'CHECKED_IN') THEN
    RETURN NEW;
  END IF;

  -- This lock is the entire mechanism. It serializes concurrent bookings
  -- for the same occurrence, so the count below cannot be read by two
  -- transactions simultaneously. Without it this trigger is decorative:
  -- two concurrent transactions could both read "one seat left" and both
  -- insert.
  SELECT coalesce(occurrences.capacity_override, offerings.default_capacity)
    INTO effective_capacity
    FROM occurrences
    JOIN offerings ON offerings.id = occurrences.offering_id
   WHERE occurrences.id = NEW.occurrence_id
   FOR UPDATE OF occurrences;

  -- Excludes the row being updated so moving an existing reservation
  -- between active statuses (e.g. HELD -> CONFIRMED) at exactly capacity
  -- does not double-count itself.
  SELECT coalesce(sum(seat_count), 0)
    INTO active_seats
    FROM reservations
   WHERE occurrence_id = NEW.occurrence_id
     AND status IN ('HELD', 'CONFIRMED', 'CHECKED_IN')
     AND id <> NEW.id;

  IF active_seats + NEW.seat_count > effective_capacity THEN
    -- Stable SQLSTATE rather than message matching, so callers (WS-06) can
    -- translate this into a typed domain error without parsing English.
    RAISE EXCEPTION 'capacity_exceeded' USING ERRCODE = 'KEKI1';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "reservations_capacity_check"
BEFORE INSERT OR UPDATE ON "reservations"
FOR EACH ROW EXECUTE FUNCTION "check_reservation_capacity"();
