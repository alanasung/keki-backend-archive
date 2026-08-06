-- Verifies the two database-level invariants that WS-03 hand-wrote into the
-- migration and that no test has ever executed: the play_pass_ledger
-- append-only trigger, and the reservation_participants CHECK constraint.
--
-- Every assertion RAISEs EXCEPTION on failure, so a nonzero psql exit means a
-- real defect.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------- fixtures
INSERT INTO households (id, name) VALUES
  ('11111111-1111-4111-8111-111111111111', 'Test Household');

INSERT INTO customers (id, household_id, cognito_sub, first_name, last_name) VALUES
  ('22222222-2222-4222-8222-222222222222',
   '11111111-1111-4111-8111-111111111111', 'sub-test', 'Test', 'Customer');

INSERT INTO children (id, household_id, first_name, last_name, date_of_birth) VALUES
  ('33333333-3333-4333-8333-333333333333',
   '11111111-1111-4111-8111-111111111111', 'Test', 'Child', '2020-01-01');

INSERT INTO play_passes (id, household_id, total_credits, remaining_credits) VALUES
  ('44444444-4444-4444-8444-444444444444',
   '11111111-1111-4111-8111-111111111111', 10, 10);

INSERT INTO offerings (id, slug, name, type, duration_minutes, default_capacity, price_cents) VALUES
  ('55555555-5555-4555-8555-555555555555', 'test-class', 'Test Class', 'CLASS', 60, 12, 2500);

INSERT INTO occurrences (id, offering_id, starts_at, ends_at) VALUES
  ('66666666-6666-4666-8666-666666666666', '55555555-5555-4555-8555-555555555555',
   now() + interval '1 day', now() + interval '1 day 1 hour');

INSERT INTO reservations (id, occurrence_id, household_id, created_by_customer_id, status) VALUES
  ('77777777-7777-4777-8777-777777777777', '66666666-6666-4666-8666-666666666666',
   '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'CONFIRMED');

INSERT INTO play_pass_ledger (id, play_pass_id, delta_credits, reason) VALUES
  ('88888888-8888-4888-8888-888888888888',
   '44444444-4444-4444-8444-444444444444', 10, 'PURCHASE');

-- ------------------------------------------- 1. ledger rejects UPDATE
DO $$
BEGIN
  UPDATE play_pass_ledger SET delta_credits = 999
   WHERE id = '88888888-8888-4888-8888-888888888888';
  RAISE EXCEPTION 'FAIL: UPDATE on play_pass_ledger succeeded; ledger is not append-only';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF;
  RAISE NOTICE 'PASS 1: UPDATE rejected (%)', SQLERRM;
WHEN others THEN
  RAISE NOTICE 'PASS 1: UPDATE rejected (%)', SQLERRM;
END $$;

-- ------------------------------------------- 2. ledger rejects DELETE
DO $$
BEGIN
  DELETE FROM play_pass_ledger WHERE id = '88888888-8888-4888-8888-888888888888';
  RAISE EXCEPTION 'FAIL: DELETE on play_pass_ledger succeeded; ledger is not append-only';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF;
  RAISE NOTICE 'PASS 2: DELETE rejected (%)', SQLERRM;
WHEN others THEN
  RAISE NOTICE 'PASS 2: DELETE rejected (%)', SQLERRM;
END $$;

-- ------------------------------------------- 3. the row survived both
DO $$
DECLARE v integer;
BEGIN
  SELECT delta_credits INTO v FROM play_pass_ledger
   WHERE id = '88888888-8888-4888-8888-888888888888';
  IF v IS NULL THEN RAISE EXCEPTION 'FAIL: ledger row was deleted'; END IF;
  IF v <> 10 THEN RAISE EXCEPTION 'FAIL: ledger row was mutated to %', v; END IF;
  RAISE NOTICE 'PASS 3: ledger row intact (delta_credits=%)', v;
END $$;

-- ------------------------------------------- 4. INSERT still allowed
DO $$
BEGIN
  INSERT INTO play_pass_ledger (play_pass_id, delta_credits, reason)
  VALUES ('44444444-4444-4444-8444-444444444444', -1, 'REDEMPTION');
  RAISE NOTICE 'PASS 4: INSERT still permitted (append-only, not read-only)';
EXCEPTION WHEN others THEN
  RAISE EXCEPTION 'FAIL: INSERT rejected, ledger is unusable: %', SQLERRM;
END $$;

-- ------------------------- 5. participant with BOTH refs is rejected
DO $$
BEGIN
  INSERT INTO reservation_participants (reservation_id, customer_id, child_id)
  VALUES ('77777777-7777-4777-8777-777777777777',
          '22222222-2222-4222-8222-222222222222',
          '33333333-3333-4333-8333-333333333333');
  RAISE EXCEPTION 'FAIL: participant with both customer_id and child_id was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS 5: both-refs rejected by CHECK';
WHEN raise_exception THEN RAISE;
END $$;

-- ------------------------ 6. participant with NEITHER ref is rejected
DO $$
BEGIN
  INSERT INTO reservation_participants (reservation_id)
  VALUES ('77777777-7777-4777-8777-777777777777');
  RAISE EXCEPTION 'FAIL: participant with neither customer_id nor child_id was accepted';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS 6: neither-ref rejected by CHECK';
WHEN raise_exception THEN RAISE;
END $$;

-- --------------------- 7/8. exactly one ref is accepted, both ways
DO $$
BEGIN
  INSERT INTO reservation_participants (reservation_id, customer_id)
  VALUES ('77777777-7777-4777-8777-777777777777',
          '22222222-2222-4222-8222-222222222222');
  RAISE NOTICE 'PASS 7: customer-only participant accepted';

  INSERT INTO reservation_participants (reservation_id, child_id)
  VALUES ('77777777-7777-4777-8777-777777777777',
          '33333333-3333-4333-8333-333333333333');
  RAISE NOTICE 'PASS 8: child-only participant accepted';
EXCEPTION WHEN others THEN
  RAISE EXCEPTION 'FAIL: a valid single-ref participant was rejected: %', SQLERRM;
END $$;

SELECT 'ALL INVARIANTS VERIFIED' AS result;
