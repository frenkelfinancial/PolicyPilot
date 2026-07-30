-- ============================================================
-- Agency leaderboards, records & achievements  (PROMPT_17)
--
-- Feature doc: docs/agency-leaderboards.md
--
-- ADDITIVE ONLY. Six `create table if not exists`, one `add column if not
-- exists`, indexes, RLS + SELECT-only policies, a seed with `on conflict do
-- update`, and functions. No DROP of a table, column, function or row; no
-- DELETE, no TRUNCATE; nothing in auth.* or storage.* (the `references
-- auth.users(id)` foreign keys are how every table in this schema keys a
-- tenant — that is reading auth, not writing it). Re-running the whole file
-- is a no-op.
--
-- ------------------------------------------------------------------
-- THE ONE RULE THIS FILE EXISTS TO OBEY
-- ------------------------------------------------------------------
-- The Agency screen already has ONE definition of a sale, one AP guard and
-- one period engine (docs/agency-team-screen.md). A leaderboard that
-- recomputed AP its own way would be the second opinion that produced the
-- 8,610x overstatement fixed in 20260736 — except this time both numbers
-- would be on the same page, so an agent would see their team AP and their
-- board AP disagree.
--
-- So `lb_agent_metrics()` below carries the sale predicate, the sale-date
-- chain and the AP regex guard BYTE-IDENTICAL to get_team_summary's `pol`
-- CTE as 20260741 left it. test/leaderboards.test.mjs extracts both from the
-- migration text and compares them character for character; if either moves,
-- the test fails rather than the screens quietly disagreeing.
--
-- Every board, the snapshot job and the Most Improved baseline read that one
-- function. There is no second computation of AP or dials in this file.
--
-- ------------------------------------------------------------------
-- AUTHORIZATION SHAPE
-- ------------------------------------------------------------------
-- Same posture as get_team_summary / apply_producer_codes /
-- get_downline_commission_rollup:
--
--   * No function an `authenticated` caller may execute takes a parameter
--     naming an agent or a leader. The agency is resolved solely from
--     auth.uid() via lb_leader_for(). There is nothing to point at somebody
--     else's team.
--   * The internal helpers that DO take an agent array (lb_agent_metrics,
--     lb_members, lb_evaluate, …) are REVOKEd from anon/authenticated. They
--     are reachable only from inside the definer functions above them.
--   * Every peer-visible table is SELECT-only-your-own or has no policy at
--     all (RLS-enabled-with-no-policy is how "reachable only through a
--     definer function" is expressed in Postgres — same idiom as
--     reputation_config, lead_transfers and the four commission tables).
--     There is no INSERT/UPDATE/DELETE policy on ANY table in this file.
--   * A hidden agent (agents.hide_from_leaderboards) is filtered out inside
--     lb_visible_members(), which every peer-visible read goes through — not
--     in the UI, and not in the browser.
--
-- ------------------------------------------------------------------
-- WHAT THE BOARD RPC DELIBERATELY DOES NOT RETURN
-- ------------------------------------------------------------------
-- get_agency_leaderboards() returns ranks 1-10 plus the caller's own row,
-- and nothing else. "Never show a full bottom-to-top ranking" is enforced by
-- what the query emits, not by what the UI chooses to render — a peer cannot
-- read the tail out of the network tab because it was never sent.
-- ============================================================


-- ------------------------------------------------------------
-- 0. The opt-out toggle.
--
-- On `agents`, because it is a property of the agent, not of a board.
--
-- Deliberately NOT added to agents_protect_privileged_columns (20260703c):
-- this is a column the agent is SUPPOSED to write, and the whole point of
-- the toggle is that it is theirs. `agents_update_own` is row-ownership
-- only, which is exactly right here.
--
-- Peer visibility is new. Until now a downline consented to sharing
-- performance data with their LEADER; a board shows it to PEERS. Defaulting
-- to false (visible) matches the locked product decision that boards render
-- for everyone in an agency, and the UI is required to say so plainly the
-- first time an agent's data would appear.
-- ------------------------------------------------------------
ALTER TABLE public.agents
  ADD COLUMN IF NOT EXISTS hide_from_leaderboards boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.agents.hide_from_leaderboards IS
  'Agent-controlled. true = excluded from every public board, agency record and milestone feed in their agency. Their own records and achievements keep updating privately. Enforced in lb_visible_members(), not in the UI.';


-- ------------------------------------------------------------
-- 1. achievement_definitions — the catalogue.
--
-- A table rather than a constant in app.html because the gallery has to show
-- UNEARNED badges with their criteria (they function as the goal map), and
-- because the evaluator needs the thresholds server-side. `criteria` is the
-- sentence rendered under a greyed badge, so it is content, not a comment.
--
-- No tenant data: SELECT is granted to every authenticated user.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.achievement_definitions (
  key         text PRIMARY KEY,
  name        text        NOT NULL,
  description text        NOT NULL,
  criteria    text        NOT NULL,
  family      text        NOT NULL,
  metric      text        NOT NULL,
  threshold   numeric,
  tier        int         NOT NULL DEFAULT 1,
  sort_order  int         NOT NULL DEFAULT 100,
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.achievement_definitions IS
  'Seeded catalogue of achievement badges. `metric` names the value lb_evaluate() computes; `threshold` is the bar. Unearned badges render greyed with `criteria` visible, so that text is user-facing.';


-- ------------------------------------------------------------
-- 2. agent_achievements — one-time unlocks.
--
-- UNIQUE (agent_id, achievement_key) is the whole idempotency story: the
-- evaluator inserts with ON CONFLICT DO NOTHING, so re-running it — nightly,
-- from the Agency tab, or as the launch backfill — never double-awards and
-- never moves an earned_at that already exists.
--
-- earned_on is the HISTORICAL date the criteria was met, which is not the
-- same as earned_at (when we noticed). The backfill computes it from the
-- agent's own history so an existing user does not start at zero with
-- today's date stamped on twelve badges.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.agent_achievements (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  achievement_key text        NOT NULL REFERENCES public.achievement_definitions(key),
  earned_at       timestamptz NOT NULL DEFAULT now(),
  earned_on       date,
  value           numeric,
  UNIQUE (agent_id, achievement_key)
);

CREATE INDEX IF NOT EXISTS agent_achievements_agent_idx
  ON public.agent_achievements (agent_id, earned_at DESC);


-- ------------------------------------------------------------
-- 3. agent_records — personal bests. One row per (agent, record_key).
--
-- For every key except fastest_lead_to_sale, higher is better; that one is a
-- number of DAYS and lower is better, which is why lb_record_is_better()
-- exists rather than a bare `>` scattered through the evaluator.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.agent_records (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  record_key  text        NOT NULL,
  value       numeric     NOT NULL,
  occurred_on date,
  detail      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  set_at      timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, record_key)
);

CREATE INDEX IF NOT EXISTS agent_records_agent_idx ON public.agent_records (agent_id);


-- ------------------------------------------------------------
-- 4. agency_records — the agency's all-time bests.
--
-- Keyed on leader_id because that is what an agency IS in this schema: a
-- leader plus their accepted invitees. There is no agencies table, and
-- inventing one here would be a second definition of membership.
--
-- holder_agent_id is ON DELETE SET NULL and holder_name is denormalized:
-- an agent leaving the agency must not erase the fact that the record was
-- set, nor blank the name beside it.
--
-- NO CLIENT NAME, POLICY NUMBER OR CARRIER IS STORED HERE, on purpose.
-- docs/agency-team-screen.md draws that line for every cross-agent surface
-- and a record row is one. "Biggest policy ever written" is an amount, a
-- date and a name — never whose policy it was.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.agency_records (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  leader_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  record_key      text        NOT NULL,
  value           numeric     NOT NULL,
  holder_agent_id uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  holder_name     text,
  occurred_on     date,
  detail          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  set_at          timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (leader_id, record_key)
);

CREATE INDEX IF NOT EXISTS agency_records_leader_idx ON public.agency_records (leader_id);


-- ------------------------------------------------------------
-- 5. leaderboard_snapshots — closed periods, frozen.
--
-- Powers the Hall of Fame and freezes history against later edits: a policy
-- whose status changes in September must not rewrite who won July.
--
-- agent_name is stored, not joined. A Hall of Fame that forgets a winner's
-- name when they leave the agency is not a hall of fame.
--
-- The uniqueness grain is the AGENT, not the rank, and that is a correction:
-- the first version of this file keyed on `rank`, which made the rollover
-- idempotent but ALSO made it lossy. Ties share a rank by design, so a board
-- with two agents at rank 6 offered the same key twice and the second row was
-- silently swallowed by ON CONFLICT DO NOTHING — a ten-place board froze with
-- nine rows in it, and the missing one was somebody's tied placement. Found by
-- the behavioural pass before the table ever held a row.
--
-- Keyed on agent_id it is still exactly as idempotent (one row per agent per
-- board per period) and a tie survives.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.leaderboard_snapshots (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  leader_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  period_kind  text        NOT NULL,
  period_start date        NOT NULL,
  period_end   date        NOT NULL,
  board_key    text        NOT NULL,
  rank         int         NOT NULL,
  agent_id     uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  agent_name   text,
  value        numeric     NOT NULL,
  captured_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (leader_id, period_kind, period_start, board_key, agent_id)
);

-- The correction, for a database that already took the first version of the
-- CREATE TABLE above (this one did, minutes earlier, with the table at 0
-- rows). Guarded on the auto-generated constraint name, so it is a no-op
-- everywhere else and on every re-run.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.leaderboard_snapshots'::regclass
                AND conname  = 'leaderboard_snapshots_leader_id_period_kind_period_start_bo_key') THEN
    ALTER TABLE public.leaderboard_snapshots
      DROP CONSTRAINT leaderboard_snapshots_leader_id_period_kind_period_start_bo_key;
    ALTER TABLE public.leaderboard_snapshots
      ADD CONSTRAINT leaderboard_snapshots_grain_key
      UNIQUE (leader_id, period_kind, period_start, board_key, agent_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS leaderboard_snapshots_lookup_idx
  ON public.leaderboard_snapshots (leader_id, period_kind, period_start DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leaderboard_snapshots_kind_check') THEN
    ALTER TABLE public.leaderboard_snapshots
      ADD CONSTRAINT leaderboard_snapshots_kind_check
      CHECK (period_kind IN ('week','month','quarter'));
  END IF;
END $$;


-- ------------------------------------------------------------
-- 6. agency_milestones — the feed.
--
-- The app's existing "activity feed" is localStorage only (DS_LS.activities
-- in app.html: per-agent, capped at 500, and requiring a clientId), so an
-- agency record written there would be visible to exactly one person — the
-- agent who set it. That is the opposite of the point. This table is the
-- server-side feed the Agency tab renders.
--
-- dedupe_key is the idempotency grain and it encodes the EVENT rather than
-- the row: 'agency_record:team_day_ap:4200'. Re-running the evaluator over
-- unchanged data produces the same key and writes nothing; a genuinely new
-- record produces a different one.
--
-- A hidden agent produces no row here at all — enforced in lb_evaluate() and
-- lb_evaluate_agency(), which are the only things that write it.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.agency_milestones (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  leader_id   uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_id    uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  agent_name  text,
  kind        text        NOT NULL,
  ref_key     text        NOT NULL,
  title       text        NOT NULL,
  body        text,
  value       numeric,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  dedupe_key  text        NOT NULL,
  UNIQUE (leader_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS agency_milestones_feed_idx
  ON public.agency_milestones (leader_id, occurred_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agency_milestones_kind_check') THEN
    ALTER TABLE public.agency_milestones
      ADD CONSTRAINT agency_milestones_kind_check
      CHECK (kind IN ('agency_record','personal_record','achievement','season'));
  END IF;
END $$;


-- ------------------------------------------------------------
-- 7. RLS.
--
-- achievement_definitions   SELECT to all authenticated (a static catalogue)
-- agent_achievements        SELECT your own
-- agent_records             SELECT your own
-- agency_records            no policy  -> definer functions only
-- leaderboard_snapshots     no policy  -> definer functions only
-- agency_milestones         no policy  -> definer functions only
--
-- There is NO INSERT, UPDATE or DELETE policy on any of the six. Every write
-- goes through a SECURITY DEFINER function that resolves the agent from
-- auth.uid(). A policy wide enough to let the browser record an achievement
-- is wide enough to let it record one it did not earn; a policy wide enough
-- to let it write agency_records is wide enough to let it claim somebody
-- else's record.
--
-- The last three have no SELECT policy either, because their rows are
-- cross-agent by nature: an agency record is about the agency, not about the
-- reader, and "which rows may this reader see" is exactly the question
-- lb_visible_members() answers inside the definer functions.
-- ------------------------------------------------------------
ALTER TABLE public.achievement_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_achievements      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_records           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agency_records          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leaderboard_snapshots   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agency_milestones       ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS achievement_definitions_select_all ON public.achievement_definitions;
CREATE POLICY achievement_definitions_select_all
  ON public.achievement_definitions FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS agent_achievements_select_own ON public.agent_achievements;
CREATE POLICY agent_achievements_select_own
  ON public.agent_achievements FOR SELECT TO authenticated
  USING (agent_id = auth.uid());

DROP POLICY IF EXISTS agent_records_select_own ON public.agent_records;
CREATE POLICY agent_records_select_own
  ON public.agent_records FOR SELECT TO authenticated
  USING (agent_id = auth.uid());


-- ------------------------------------------------------------
-- 8. Seed the catalogue.
--
-- 18 rows. `on conflict (key) do update` rather than `do nothing`, so a
-- correction to a criteria sentence ships by re-running the file; the EARNED
-- rows in agent_achievements are untouched either way.
--
-- Early Bird and Closer from the original spec are deliberately ABSENT.
-- There is no sale-time timestamp anywhere in this schema — dateSubmitted
-- and draft are dates, and the only time-of-day signal is when the row was
-- typed into the CRM. A badge for "policy before 10:00 AM" would have
-- rewarded early data entry and called it early selling. Decided by Jace
-- 2026-07-30 after discovery; see docs/agency-leaderboards.md.
--
-- Weekend Warrior survives because it reads the sale DATE, not a clock: a
-- Saturday sale date is genuinely a Saturday sale whenever it was typed in.
-- ------------------------------------------------------------
INSERT INTO public.achievement_definitions
  (key, name, description, criteria, family, metric, threshold, tier, sort_order)
VALUES
  ('first_sale',      'First Sale',           'Your first policy.',                                    'Write your first policy.',                             'sales',       'first_sale',        1,      1,  10),
  ('first_1k_day',    'First $1k AP Day',     'A thousand dollars of annual premium in a single day.', 'Write $1,000 or more of AP in one day.',               'sales',       'day_ap',            1000,   1,  20),
  ('hat_trick',       'Hat Trick',            'Three policies between one sunrise and the next.',      'Write 3 policies in one day.',                         'sales',       'day_policies',      3,      1,  30),
  ('producers_10',    'Producer''s Club 10',  'Ten policies written.',                                 'Write 10 policies, lifetime.',                         'volume',      'lifetime_policies', 10,     1,  40),
  ('producers_25',    'Producer''s Club 25',  'Twenty-five policies written.',                         'Write 25 policies, lifetime.',                         'volume',      'lifetime_policies', 25,     2,  41),
  ('producers_50',    'Producer''s Club 50',  'Fifty policies written.',                               'Write 50 policies, lifetime.',                         'volume',      'lifetime_policies', 50,     3,  42),
  ('producers_100',   'Producer''s Club 100', 'One hundred policies written.',                         'Write 100 policies, lifetime.',                        'volume',      'lifetime_policies', 100,    4,  43),
  ('producers_250',   'Producer''s Club 250', 'Two hundred and fifty policies written.',               'Write 250 policies, lifetime.',                        'volume',      'lifetime_policies', 250,    5,  44),
  ('ap_50k',          '$50k Club',            'Fifty thousand in annual premium.',                     'Write $50,000 of AP, lifetime.',                       'volume',      'lifetime_ap',       50000,  1,  50),
  ('ap_100k',         '$100k Club',           'One hundred thousand in annual premium.',               'Write $100,000 of AP, lifetime.',                      'volume',      'lifetime_ap',       100000, 2,  51),
  ('ap_250k',         '$250k Club',           'A quarter million in annual premium.',                  'Write $250,000 of AP, lifetime.',                      'volume',      'lifetime_ap',       250000, 3,  52),
  ('streak_5',        '5-Day Streak',         'A sale on five business days running.',                 'Write a policy on 5 consecutive business days. Weekend sales extend a streak; weekend gaps do not break one.', 'consistency', 'sale_streak', 5, 1, 60),
  ('consistency_30',  '30-Day Consistency',   'Thirty business days without missing a dial.',          'Place at least one dial on 30 consecutive business days.', 'consistency', 'dial_streak',   30,     1,  61),
  ('weekend_warrior', 'Weekend Warrior',      'Business written on a Saturday or Sunday.',             'Write a policy dated on a Saturday or Sunday.',        'consistency', 'weekend_sale',      1,      1,  62),
  ('comeback',        'Comeback',             'Back on the board after a quiet stretch.',              'Write a policy after 10 or more days without one (requires a prior sale).', 'consistency', 'comeback', 1, 1, 63),
  ('iron_dialer',     'Iron Dialer',          'Five hundred dials inside one week.',                   'Place 500 dials in a single week.',                    'activity',    'week_dials',        500,    1,  70),
  ('marathon',        'Marathon',             'Five hours on the phone in one day.',                   'Log 5 hours of talk time in one day.',                 'activity',    'day_talk_sec',      18000,  1,  71),
  ('placed_and_paid', 'Placed & Paid',        'Ten policies in a row that stuck.',                     'Have 10 consecutive resolved policies reach placed with no fall-off.', 'quality', 'placed_streak', 10, 1, 80)
ON CONFLICT (key) DO UPDATE SET
  name        = EXCLUDED.name,
  description = EXCLUDED.description,
  criteria    = EXCLUDED.criteria,
  family      = EXCLUDED.family,
  metric      = EXCLUDED.metric,
  threshold   = EXCLUDED.threshold,
  tier        = EXCLUDED.tier,
  sort_order  = EXCLUDED.sort_order,
  active      = true;


-- ============================================================
-- 9. PURE HELPERS.
-- ============================================================

-- Weekday index. Counts Mon-Fri days and folds Saturday and Sunday onto the
-- FOLLOWING Monday's index. That single trick gives the brief's streak rule
-- for free: a weekend sale extends a streak (it shares an index with the
-- Monday beside it) and a weekend gap does not break one (Friday and Monday
-- are consecutive indices).
--
-- 1970-01-05 is a Monday and every date this app can hold is after it, so
-- the modulo never goes negative.
CREATE OR REPLACE FUNCTION public.lb_biz_index(d date)
RETURNS int
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ((d - DATE '1970-01-05') / 7) * 5 + LEAST((d - DATE '1970-01-05') % 7, 5);
$$;

-- Higher is better everywhere except fastest_lead_to_sale, which is a number
-- of days. One function so no caller has to remember the exception.
CREATE OR REPLACE FUNCTION public.lb_record_is_better(p_key text, p_new numeric, p_old numeric)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_new IS NULL THEN false
    WHEN p_old IS NULL THEN true
    WHEN p_key = 'fastest_lead_to_sale' THEN p_new < p_old
    ELSE p_new > p_old
  END;
$$;

-- Labels live in SQL as well as in app.html because a milestone BODY is
-- written server-side and stored. A feed line reading "best_day_ap — 4200"
-- would be the database talking to itself in public.
CREATE OR REPLACE FUNCTION public.lb_record_label(p_key text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_key
    WHEN 'best_day_ap'          THEN 'Best day (AP)'
    WHEN 'best_day_policies'    THEN 'Best day (policies)'
    WHEN 'best_week_ap'         THEN 'Best week'
    WHEN 'best_month_ap'        THEN 'Best month'
    WHEN 'biggest_policy_ap'    THEN 'Biggest policy'
    WHEN 'longest_sale_streak'  THEN 'Longest sales streak'
    WHEN 'fastest_lead_to_sale' THEN 'Fastest lead to sale'
    WHEN 'team_day_ap'          THEN 'Best day, whole agency'
    WHEN 'agent_day_ap'         THEN 'Best day by one agent'
    WHEN 'team_week_ap'         THEN 'Best week, whole agency'
    WHEN 'team_month_ap'        THEN 'Best month, whole agency'
    WHEN 'agent_day_policies'   THEN 'Most policies in one day'
    ELSE p_key
  END;
$$;

CREATE OR REPLACE FUNCTION public.lb_record_display(p_key text, p_value numeric)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_key IN ('best_day_policies','agent_day_policies')
      THEN p_value::bigint::text || ' policies'
    WHEN p_key = 'longest_sale_streak'
      THEN p_value::bigint::text || ' days'
    WHEN p_key = 'fastest_lead_to_sale'
      THEN p_value::bigint::text || ' days'
    ELSE '$' || to_char(round(p_value), 'FM999,999,999')
  END;
$$;


-- ============================================================
-- 10. MEMBERSHIP HELPERS — all internal, all REVOKEd below.
-- ============================================================

-- Which agency does this agent belong to, expressed as its leader id?
--
-- Leading your own agency wins over being somebody's downline. The hierarchy
-- is flat and in practice nobody is both, but if it ever happens the answer
-- that surprises nobody is "your own agency".
--
-- NULL means solo: no accepted invite in either direction. A solo agent gets
-- personal records and achievements and no board, which is a real state and
-- not an error.
CREATE OR REPLACE FUNCTION public.lb_leader_for(p_agent uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT p_agent
       FROM public.agency_invites ai
      WHERE ai.leader_id = p_agent
        AND ai.status = 'accepted'
        AND ai.invitee_id IS NOT NULL
      LIMIT 1),
    (SELECT ai.leader_id
       FROM public.agency_invites ai
      WHERE ai.invitee_id = p_agent
        AND ai.status = 'accepted'
      ORDER BY COALESCE(ai.accepted_at, ai.created_at)
      LIMIT 1)
  );
$$;

-- Everyone in the agency, hidden or not.
CREATE OR REPLACE FUNCTION public.lb_members(p_leader uuid)
RETURNS TABLE (agent_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_leader WHERE p_leader IS NOT NULL
  UNION
  SELECT ai.invitee_id
    FROM public.agency_invites ai
   WHERE ai.leader_id = p_leader
     AND ai.status = 'accepted'
     AND ai.invitee_id IS NOT NULL;
$$;

-- Everyone who may APPEAR on a board, in a record feed, or as a record
-- holder. This is the single enforcement point for the opt-out, and it sits
-- below every peer-visible read in this file — including the caller's own
-- rank, which is why a hidden agent is not ranked even to themselves. Being
-- hidden means not being in the running; a private ranking only you can see
-- would still be a ranking of a book you asked us not to rank.
CREATE OR REPLACE FUNCTION public.lb_visible_members(p_leader uuid)
RETURNS TABLE (agent_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.agent_id
    FROM public.lb_members(p_leader) m
    LEFT JOIN public.agents a ON a.id = m.agent_id
   WHERE COALESCE(a.hide_from_leaderboards, false) = false;
$$;

-- Display name, resolved the same way get_team_summary resolves it, so a row
-- on a board and a row on the team table cannot be labelled differently.
CREATE OR REPLACE FUNCTION public.lb_agent_name(p_agent uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(NULLIF(ag.display_name,''),
                  NULLIF(au.raw_user_meta_data->>'display_name',''),
                  au.email)
    FROM auth.users au
    LEFT JOIN public.agents ag ON ag.id = au.id
   WHERE au.id = p_agent;
$$;


-- ============================================================
-- 11. THE METRICS ENGINE.
--
-- Every board, the snapshot job and the Most Improved baseline read this and
-- only this. See the header: three expressions below are byte-identical to
-- get_team_summary's `pol` CTE and a test asserts it.
--
-- p_basis:
--   'net'    — the sale predicate the whole app already uses. A lapsed or
--              charged-back policy is not a sale, so it is not in the total:
--              that IS the "subtract chargebacks and lapses" rule, expressed
--              the way this codebase has always expressed it rather than as
--              a second subtraction that could disagree with the first.
--   'placed' — PERSIST_KEPT from the persistency work (issued/paid/placed/
--              claim). The same four statuses, so the AP board's Placed
--              toggle and the persistency screen cannot drift.
--
-- Policy windows compare a DATE to p_start::date, exactly as
-- get_team_summary does. Call windows compare a timestamptz to the instant,
-- also exactly as get_team_summary does. Neither is an accident: the browser
-- sends local-midnight instants and both functions must bucket them the same
-- way, or the team table and the boards would disagree at a boundary.
-- ============================================================
CREATE OR REPLACE FUNCTION public.lb_agent_metrics(
  p_agents uuid[],
  p_start  timestamptz,
  p_end    timestamptz,
  p_basis  text DEFAULT 'net'
)
RETURNS TABLE (
  agent_id uuid,
  ap       numeric,
  policies bigint,
  dials    bigint,
  talk_sec numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH m AS (SELECT unnest(COALESCE(p_agents, ARRAY[]::uuid[])) AS uid),
  pol AS (
    SELECT po.agent_id AS uid,
           (COALESCE(NULLIF(po.data->>'dateSubmitted',''), NULLIF(po.data->>'draft','')))::date AS sub_date,
           CASE WHEN COALESCE(po.data->>'ap','') ~ '^-?[0-9]+(\.[0-9]+)?$'
                THEN (po.data->>'ap')::numeric ELSE 0 END AS ap
    FROM public.policies po
    JOIN m ON m.uid = po.agent_id
    WHERE (CASE WHEN p_basis = 'placed'
                THEN COALESCE(po.data->>'status','') IN ('issued','paid','placed','claim')
                ELSE COALESCE(po.data->>'status','') NOT IN ('lapsed','chargeback','denied','withdrawn')
           END)
      AND COALESCE(NULLIF(po.data->>'dateSubmitted',''), NULLIF(po.data->>'draft','')) ~ '^\d{4}-\d{2}-\d{2}'
  ),
  pol_agg AS (
    SELECT p.uid,
           COALESCE(SUM(p.ap), 0)::numeric AS ap,
           COUNT(*)::bigint                AS policies
      FROM pol p
     WHERE (p_start IS NULL OR p.sub_date >= p_start::date)
       AND (p_end   IS NULL OR p.sub_date <  p_end::date)
     GROUP BY p.uid
  ),
  cl AS (
    -- Talk time is `duration_sec`, the same expression get_team_summary's
    -- call_time_sec uses. `calls` does carry answered_at, so connected time
    -- IS distinguishable — but duration_sec is only written when a call
    -- completes, and across all 1,298 production rows the two definitions
    -- differ by 13 seconds. Two "call time" numbers on the same screen
    -- differing at all is the bug class this schema keeps paying for, so the
    -- board reports the number the team table reports.
    SELECT c.agent_id AS uid,
           COUNT(*)::bigint                         AS dials,
           COALESCE(SUM(c.duration_sec),0)::numeric AS talk_sec
      FROM public.calls c
      JOIN m ON m.uid = c.agent_id
     WHERE (p_start IS NULL OR c.started_at >= p_start)
       AND (p_end   IS NULL OR c.started_at <  p_end)
     GROUP BY c.agent_id
  )
  SELECT m.uid,
         COALESCE(pol_agg.ap, 0),
         COALESCE(pol_agg.policies, 0),
         COALESCE(cl.dials, 0),
         COALESCE(cl.talk_sec, 0)
    FROM m
    LEFT JOIN pol_agg ON pol_agg.uid = m.uid
    LEFT JOIN cl      ON cl.uid      = m.uid;
$$;


-- ============================================================
-- 12. BOARD ASSEMBLY.
--
-- Kept separate from the RPC so the live board and the snapshot job rank
-- identically. If these were two queries, July's frozen winner could differ
-- from the winner the board showed all July, which is the worst thing a Hall
-- of Fame can do.
--
-- Rate boards enforce their minimum volume by dropping the agent from the
-- board entirely — a below-threshold agent is not ranked last, they are not
-- ranked. The UI states the bar ("Qualify with 50+ dials this period").
--
-- Zero and negative values are excluded from every board. A leaderboard of
-- agents who wrote nothing is not a leaderboard, and the alternative — a
-- visible tail of $0 rows — is the public bottom-to-top ranking the brief
-- forbids.
--
-- rank() rather than dense_rank(): ties SHARE a rank and the next rank skips,
-- which is how a scoreboard has always worked.
-- ============================================================
CREATE OR REPLACE FUNCTION public.lb_board_rows(
  p_agents     uuid[],
  p_start      timestamptz,
  p_end        timestamptz,
  p_prev_start timestamptz,
  p_prev_end   timestamptz,
  p_basis      text DEFAULT 'net'
)
RETURNS TABLE (
  board_key text,
  rank      int,
  agent_id  uuid,
  value     numeric,
  secondary numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH cur AS (
    SELECT * FROM public.lb_agent_metrics(p_agents, p_start, p_end, p_basis)
  ),
  prv AS (
    SELECT * FROM public.lb_agent_metrics(p_agents, p_prev_start, p_prev_end, p_basis)
  ),
  raw AS (
    SELECT 'ap'::text AS bk, c.agent_id AS aid, c.ap AS val, NULL::numeric AS sec
      FROM cur c WHERE c.ap > 0
    UNION ALL
    SELECT 'policies', c.agent_id, c.policies::numeric, NULL
      FROM cur c WHERE c.policies > 0
    UNION ALL
    SELECT 'dials', c.agent_id, c.dials::numeric, NULL
      FROM cur c WHERE c.dials > 0
    UNION ALL
    SELECT 'talk', c.agent_id, c.talk_sec, NULL
      FROM cur c WHERE c.talk_sec > 0
    UNION ALL
    -- Close rate: policies per hundred dials. The denominator is dials
    -- rather than appointments because `calls.outcome = 'appointment'` has
    -- exactly one row in all of production — a rate over that denominator
    -- would be noise wearing a percentage sign.
    SELECT 'close_rate', c.agent_id,
           ROUND((c.policies::numeric / c.dials) * 100, 2), c.dials::numeric
      FROM cur c WHERE c.dials >= 50 AND c.policies > 0
    UNION ALL
    SELECT 'ap_per_dial', c.agent_id,
           ROUND(c.ap / c.dials, 2), c.dials::numeric
      FROM cur c WHERE c.dials >= 50 AND c.ap > 0
    UNION ALL
    -- Most Improved. Unavailable on All-Time (no comparable prior period, so
    -- p_prev_start is null and this branch yields nothing), and gated on a
    -- $500 prior-period baseline so nothing-to-something cannot win.
    SELECT 'improved', c.agent_id,
           ROUND(((c.ap - p.ap) / p.ap) * 100, 1), p.ap
      FROM cur c
      JOIN prv p ON p.agent_id = c.agent_id
     WHERE p_prev_start IS NOT NULL
       AND p.ap >= 500
       AND c.ap > p.ap
  )
  SELECT r.bk,
         (RANK() OVER (PARTITION BY r.bk ORDER BY r.val DESC))::int,
         r.aid,
         r.val,
         r.sec
    FROM raw r;
$$;


-- ============================================================
-- 13. get_agency_leaderboards — the browser's board RPC.
--
-- No parameter names an agent or a leader. The agency comes from
-- lb_leader_for(auth.uid()); a solo caller gets zero rows.
--
-- Returns ranks 1-10 PLUS the caller's own row and nothing else. The
-- below-top-10 viewer's private row is a row the QUERY chose to send, not a
-- row the UI chose to keep — a peer reading the response cannot reconstruct
-- the tail because it is not in it.
--
-- top_value is the value standing at rank 10, so the UI can say "$840 AP
-- from the top 10" without being handed the tenth-place agent's identity.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_agency_leaderboards(
  p_start      timestamptz DEFAULT NULL,
  p_end        timestamptz DEFAULT NULL,
  p_prev_start timestamptz DEFAULT NULL,
  p_prev_end   timestamptz DEFAULT NULL,
  p_basis      text        DEFAULT 'net'
)
RETURNS TABLE (
  board_key  text,
  rank       int,
  agent_id   uuid,
  agent_name text,
  value      numeric,
  secondary  numeric,
  is_you     boolean,
  in_top     boolean,
  top_value  numeric,
  entrants   int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (SELECT auth.uid() AS uid),
  led AS (SELECT public.lb_leader_for((SELECT uid FROM me)) AS leader),
  vis AS (
    SELECT array_agg(v.agent_id) AS agents
      FROM public.lb_visible_members((SELECT leader FROM led)) v
  ),
  brd AS (
    SELECT * FROM public.lb_board_rows(
      (SELECT agents FROM vis), p_start, p_end, p_prev_start, p_prev_end,
      CASE WHEN p_basis = 'placed' THEN 'placed' ELSE 'net' END)
  ),
  meta AS (
    SELECT b.board_key AS bk,
           MIN(b.value) FILTER (WHERE b.rank <= 10) AS top_value,
           COUNT(*)::int                            AS entrants
      FROM brd b GROUP BY b.board_key
  )
  SELECT b.board_key,
         b.rank,
         b.agent_id,
         public.lb_agent_name(b.agent_id),
         b.value,
         b.secondary,
         b.agent_id = (SELECT uid FROM me),
         b.rank <= 10,
         meta.top_value,
         meta.entrants
    FROM brd b
    JOIN meta ON meta.bk = b.board_key
   WHERE b.rank <= 10 OR b.agent_id = (SELECT uid FROM me)
   ORDER BY b.board_key, b.rank;
$$;


-- ============================================================
-- 14. lb_my_agency_state — one round trip for "what am I looking at".
--
-- The Agency tab needs three facts before it can render anything: am I in an
-- agency, how many people are on the board, and am I hidden from it. Three
-- separate queries would be three chances for the screen to paint a board
-- for an agent who opted out.
-- ============================================================
CREATE OR REPLACE FUNCTION public.lb_my_agency_state()
RETURNS TABLE (
  leader_id     uuid,
  is_leader     boolean,
  member_count  int,
  visible_count int,
  hidden        boolean,
  agency_name   text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (SELECT auth.uid() AS uid),
  led AS (SELECT public.lb_leader_for((SELECT uid FROM me)) AS leader)
  SELECT (SELECT leader FROM led),
         (SELECT leader FROM led) = (SELECT uid FROM me),
         (SELECT COUNT(*)::int FROM public.lb_members((SELECT leader FROM led))),
         (SELECT COUNT(*)::int FROM public.lb_visible_members((SELECT leader FROM led))),
         COALESCE((SELECT a.hide_from_leaderboards FROM public.agents a WHERE a.id = (SELECT uid FROM me)), false),
         (SELECT a.agency_name FROM public.agents a WHERE a.id = (SELECT leader FROM led));
$$;


-- ============================================================
-- 15. The remaining read surfaces.
-- ============================================================

-- Agency records plus the caller's own personal records, in one call so the
-- two halves of the Records screen cannot be fetched at different moments
-- and disagree about what "NEW" means.
--
-- is_new drives the quiet 7-day marker, computed here rather than in the
-- browser so a wrong client clock cannot brighten a three-month-old record.
CREATE OR REPLACE FUNCTION public.get_agency_records()
RETURNS TABLE (
  scope       text,
  record_key  text,
  value       numeric,
  occurred_on date,
  holder_id   uuid,
  holder_name text,
  set_at      timestamptz,
  is_new      boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (SELECT auth.uid() AS uid),
  led AS (SELECT public.lb_leader_for((SELECT uid FROM me)) AS leader)
  SELECT 'personal'::text, r.record_key, r.value, r.occurred_on,
         (SELECT uid FROM me), public.lb_agent_name((SELECT uid FROM me)),
         r.set_at, r.set_at > now() - interval '7 days'
    FROM public.agent_records r
   WHERE r.agent_id = (SELECT uid FROM me)
  UNION ALL
  SELECT 'agency', ar.record_key, ar.value, ar.occurred_on,
         ar.holder_agent_id, ar.holder_name,
         ar.set_at, ar.set_at > now() - interval '7 days'
    FROM public.agency_records ar
   WHERE (SELECT leader FROM led) IS NOT NULL
     AND ar.leader_id = (SELECT leader FROM led);
$$;

CREATE OR REPLACE FUNCTION public.get_agency_milestones(p_limit int DEFAULT 20)
RETURNS TABLE (
  id          uuid,
  agent_id    uuid,
  agent_name  text,
  kind        text,
  ref_key     text,
  title       text,
  body        text,
  value       numeric,
  occurred_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH led AS (SELECT public.lb_leader_for(auth.uid()) AS leader)
  SELECT m.id, m.agent_id, m.agent_name, m.kind, m.ref_key,
         m.title, m.body, m.value, m.occurred_at
    FROM public.agency_milestones m
   WHERE (SELECT leader FROM led) IS NOT NULL
     AND m.leader_id = (SELECT leader FROM led)
   ORDER BY m.occurred_at DESC
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100));
$$;

-- The Hall of Fame: the #1 finisher of each board in each closed period.
-- Reads the frozen snapshot, never the live data, which is the point of
-- having taken one.
CREATE OR REPLACE FUNCTION public.get_agency_hall_of_fame(p_limit int DEFAULT 40)
RETURNS TABLE (
  period_kind  text,
  period_start date,
  period_end   date,
  board_key    text,
  agent_id     uuid,
  agent_name   text,
  value        numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH led AS (SELECT public.lb_leader_for(auth.uid()) AS leader)
  SELECT s.period_kind, s.period_start, s.period_end, s.board_key,
         s.agent_id, s.agent_name, s.value
    FROM public.leaderboard_snapshots s
   WHERE (SELECT leader FROM led) IS NOT NULL
     AND s.leader_id = (SELECT leader FROM led)
     AND s.rank = 1
   ORDER BY s.period_start DESC, s.period_kind, s.board_key
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 40), 200));
$$;

-- SECURITY INVOKER on purpose: it reads agent_achievements through the
-- caller's own RLS, so it cannot return another agent's unlocks even by
-- accident. Same reasoning as get_ingestion_summary.
CREATE OR REPLACE FUNCTION public.get_my_achievements()
RETURNS TABLE (
  key         text,
  name        text,
  description text,
  criteria    text,
  family      text,
  tier        int,
  sort_order  int,
  threshold   numeric,
  earned_at   timestamptz,
  earned_on   date,
  value       numeric
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT d.key, d.name, d.description, d.criteria, d.family, d.tier,
         d.sort_order, d.threshold, a.earned_at, a.earned_on, a.value
    FROM public.achievement_definitions d
    LEFT JOIN public.agent_achievements a
           ON a.achievement_key = d.key AND a.agent_id = auth.uid()
   WHERE d.active
   ORDER BY d.sort_order;
$$;


-- ============================================================
-- 16. THE EVALUATOR — personal records and achievements.
--
-- Idempotent by construction, three times over:
--   * achievements  — UNIQUE (agent_id, achievement_key) + DO NOTHING
--   * records       — written only when strictly better than what is stored
--   * milestones    — UNIQUE (leader_id, dedupe_key), where the key encodes
--                     the event, so re-running over unchanged data is a
--                     no-op and a genuine new record is a new key
--
-- p_silent suppresses the feed. That is the launch backfill's whole safety
-- property: eighteen badges and seven records per agent, computed from years
-- of history, would otherwise flood the feed with events nobody experienced.
--
-- DAY BUCKETS FOR CALLS ARE AMERICA/CHICAGO. `started_at` is a timestamptz
-- and a 7 PM Central dial is tomorrow in UTC — bucketing on the server's own
-- zone would put an evening's work on the wrong day and silently break a
-- dial streak. Policy dates need no conversion; they are already dates.
-- ============================================================
CREATE OR REPLACE FUNCTION public.lb_evaluate(p_agent uuid, p_silent boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_leader  uuid;
  v_hidden  boolean;
  v_name    text;
  v_awarded int := 0;
  v_records int := 0;
  v_rec     record;
  v_old     numeric;
  v_label   text;
BEGIN
  IF p_agent IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_agent'); END IF;

  v_leader := public.lb_leader_for(p_agent);
  v_hidden := COALESCE((SELECT a.hide_from_leaderboards FROM public.agents a WHERE a.id = p_agent), false);
  v_name   := public.lb_agent_name(p_agent);

  -- ================= PERSONAL RECORDS =================
  FOR v_rec IN
    WITH pol AS (
      SELECT (COALESCE(NULLIF(po.data->>'dateSubmitted',''), NULLIF(po.data->>'draft','')))::date AS sub_date,
             CASE WHEN COALESCE(po.data->>'ap','') ~ '^-?[0-9]+(\.[0-9]+)?$'
                  THEN (po.data->>'ap')::numeric ELSE 0 END AS ap,
             COALESCE(po.data->>'status','') AS status,
             (SELECT (l.created_at AT TIME ZONE 'America/Chicago')::date
                FROM public.leads l
               WHERE l.agent_id = po.agent_id
                 AND l.client_id = po.data->>'soldLeadId') AS lead_created
        FROM public.policies po
       WHERE po.agent_id = p_agent
         AND COALESCE(NULLIF(po.data->>'dateSubmitted',''), NULLIF(po.data->>'draft','')) ~ '^\d{4}-\d{2}-\d{2}'
    ),
    sale AS (
      SELECT * FROM pol WHERE status NOT IN ('lapsed','chargeback','denied','withdrawn')
    ),
    days   AS (SELECT sub_date d, SUM(ap) ap, COUNT(*) n FROM sale GROUP BY 1),
    weeks  AS (SELECT date_trunc('week',  sub_date)::date d, SUM(ap) ap FROM sale GROUP BY 1),
    months AS (SELECT date_trunc('month', sub_date)::date d, SUM(ap) ap FROM sale GROUP BY 1),
    -- Longest run of consecutive business-day indices. Gaps-and-islands:
    -- subtracting a row number from a consecutive integer sequence yields a
    -- constant, so the islands group on it.
    islands AS (
      SELECT d, bi - ROW_NUMBER() OVER (ORDER BY bi) AS grp
        FROM (SELECT DISTINCT sub_date d, public.lb_biz_index(sub_date) bi FROM sale) a
    ),
    streak AS (SELECT COUNT(*) len, MAX(d) ended FROM islands GROUP BY grp),
    l2s AS (
      SELECT (sub_date - lead_created) days, sub_date d
        FROM sale
       WHERE lead_created IS NOT NULL AND sub_date >= lead_created
    )
    SELECT 'best_day_ap' AS k,
           (SELECT ap FROM days ORDER BY ap DESC, d LIMIT 1) AS v,
           (SELECT d  FROM days ORDER BY ap DESC, d LIMIT 1) AS on_date
    UNION ALL SELECT 'best_day_policies', (SELECT n  FROM days ORDER BY n DESC, d LIMIT 1),
                                          (SELECT d  FROM days ORDER BY n DESC, d LIMIT 1)
    UNION ALL SELECT 'best_week_ap',      (SELECT ap FROM weeks ORDER BY ap DESC, d LIMIT 1),
                                          (SELECT d  FROM weeks ORDER BY ap DESC, d LIMIT 1)
    UNION ALL SELECT 'best_month_ap',     (SELECT ap FROM months ORDER BY ap DESC, d LIMIT 1),
                                          (SELECT d  FROM months ORDER BY ap DESC, d LIMIT 1)
    UNION ALL SELECT 'biggest_policy_ap', (SELECT ap       FROM sale ORDER BY ap DESC, sub_date LIMIT 1),
                                          (SELECT sub_date FROM sale ORDER BY ap DESC, sub_date LIMIT 1)
    UNION ALL SELECT 'longest_sale_streak', (SELECT len   FROM streak ORDER BY len DESC, ended LIMIT 1),
                                            (SELECT ended FROM streak ORDER BY len DESC, ended LIMIT 1)
    UNION ALL SELECT 'fastest_lead_to_sale', (SELECT days FROM l2s ORDER BY days, d LIMIT 1),
                                             (SELECT d    FROM l2s ORDER BY days, d LIMIT 1)
  LOOP
    -- A zero-day lead-to-sale (sold the day it arrived) is a real record, so
    -- that key allows zero; every other record is a magnitude and a zero
    -- there means "no data", not "a record of nothing".
    CONTINUE WHEN v_rec.v IS NULL;
    CONTINUE WHEN v_rec.v <= 0 AND v_rec.k <> 'fastest_lead_to_sale';
    CONTINUE WHEN v_rec.on_date IS NULL;

    SELECT r.value INTO v_old FROM public.agent_records r
     WHERE r.agent_id = p_agent AND r.record_key = v_rec.k;

    IF public.lb_record_is_better(v_rec.k, v_rec.v, v_old) THEN
      INSERT INTO public.agent_records (agent_id, record_key, value, occurred_on)
      VALUES (p_agent, v_rec.k, v_rec.v, v_rec.on_date)
      ON CONFLICT (agent_id, record_key) DO UPDATE
        SET value = EXCLUDED.value, occurred_on = EXCLUDED.occurred_on,
            set_at = now(), updated_at = now();
      v_records := v_records + 1;

      -- A personal best is worth a feed line only when it BEAT something.
      -- The first time a record is set there was nothing to break, and an
      -- agency that has just switched the feature on would otherwise see
      -- seven "records" per member on day one.
      IF NOT p_silent AND v_old IS NOT NULL AND v_leader IS NOT NULL AND NOT v_hidden THEN
        INSERT INTO public.agency_milestones
          (leader_id, agent_id, agent_name, kind, ref_key, title, body, value, dedupe_key)
        VALUES (v_leader, p_agent, v_name, 'personal_record', v_rec.k,
                v_name || ' set a personal best',
                public.lb_record_label(v_rec.k) || ' — ' || public.lb_record_display(v_rec.k, v_rec.v),
                v_rec.v,
                'personal_record:' || p_agent::text || ':' || v_rec.k || ':' || v_rec.v::text)
        ON CONFLICT (leader_id, dedupe_key) DO NOTHING;
      END IF;
    END IF;
  END LOOP;

  -- ================= ACHIEVEMENTS =================
  FOR v_rec IN
    WITH pol AS (
      SELECT (COALESCE(NULLIF(po.data->>'dateSubmitted',''), NULLIF(po.data->>'draft','')))::date AS sub_date,
             CASE WHEN COALESCE(po.data->>'ap','') ~ '^-?[0-9]+(\.[0-9]+)?$'
                  THEN (po.data->>'ap')::numeric ELSE 0 END AS ap,
             COALESCE(po.data->>'status','') AS status
        FROM public.policies po
       WHERE po.agent_id = p_agent
         AND COALESCE(NULLIF(po.data->>'dateSubmitted',''), NULLIF(po.data->>'draft','')) ~ '^\d{4}-\d{2}-\d{2}'
    ),
    sale AS (
      SELECT * FROM pol WHERE status NOT IN ('lapsed','chargeback','denied','withdrawn')
    ),
    cday AS (
      SELECT (c.started_at AT TIME ZONE 'America/Chicago')::date d,
             COUNT(*) dials, COALESCE(SUM(c.duration_sec),0) talk
        FROM public.calls c WHERE c.agent_id = p_agent GROUP BY 1
    ),
    days AS (SELECT sub_date d, SUM(ap) ap, COUNT(*) n FROM sale GROUP BY 1),
    ordered AS (
      SELECT sub_date d,
             ROW_NUMBER() OVER (ORDER BY sub_date, ap) rn,
             SUM(ap)      OVER (ORDER BY sub_date, ap ROWS UNBOUNDED PRECEDING) running_ap
        FROM sale
    ),
    sale_isl AS (
      SELECT d, bi - ROW_NUMBER() OVER (ORDER BY bi) grp
        FROM (SELECT DISTINCT sub_date d, public.lb_biz_index(sub_date) bi FROM sale) a
    ),
    sale_run AS (
      SELECT d, ROW_NUMBER() OVER (PARTITION BY grp ORDER BY d) n FROM sale_isl
    ),
    dial_isl AS (
      SELECT d, bi - ROW_NUMBER() OVER (ORDER BY bi) grp
        FROM (SELECT DISTINCT d, public.lb_biz_index(d) bi FROM cday WHERE dials > 0) a
    ),
    dial_run AS (
      SELECT d, ROW_NUMBER() OVER (PARTITION BY grp ORDER BY d) n FROM dial_isl
    ),
    weeks_dials AS (SELECT date_trunc('week', d)::date wk, SUM(dials) n FROM cday GROUP BY 1),
    gaps AS (
      SELECT d, d - LAG(d) OVER (ORDER BY d) gap
        FROM (SELECT DISTINCT sub_date d FROM sale) z
    ),
    -- Placed & Paid. Only RESOLVED policies participate: a pending or
    -- Approved-Not-Paid application has not fallen off, it simply has not
    -- landed yet, so it neither counts toward the run nor breaks it.
    resolved AS (
      SELECT sub_date d,
             CASE WHEN status IN ('issued','paid','placed','claim') THEN 1 ELSE 0 END ok,
             ROW_NUMBER() OVER (ORDER BY sub_date) rn
        FROM pol
       WHERE status IN ('issued','paid','placed','claim','lapsed','chargeback','denied','withdrawn')
    ),
    resolved_grp AS (
      SELECT d, ok, rn, rn - ROW_NUMBER() OVER (PARTITION BY ok ORDER BY rn) grp FROM resolved
    ),
    placed_run AS (
      SELECT d, ok, ROW_NUMBER() OVER (PARTITION BY ok, grp ORDER BY rn) n FROM resolved_grp
    )
    SELECT 'first_sale' AS k, (SELECT MIN(sub_date) FROM sale) AS on_date, 1::numeric AS v
    UNION ALL SELECT 'first_1k_day',    (SELECT MIN(d) FROM days WHERE ap >= 1000), (SELECT MAX(ap) FROM days)
    UNION ALL SELECT 'hat_trick',       (SELECT MIN(d) FROM days WHERE n  >= 3),    (SELECT MAX(n)  FROM days)
    UNION ALL SELECT 'producers_10',    (SELECT d FROM ordered WHERE rn = 10),  (SELECT MAX(rn) FROM ordered)
    UNION ALL SELECT 'producers_25',    (SELECT d FROM ordered WHERE rn = 25),  (SELECT MAX(rn) FROM ordered)
    UNION ALL SELECT 'producers_50',    (SELECT d FROM ordered WHERE rn = 50),  (SELECT MAX(rn) FROM ordered)
    UNION ALL SELECT 'producers_100',   (SELECT d FROM ordered WHERE rn = 100), (SELECT MAX(rn) FROM ordered)
    UNION ALL SELECT 'producers_250',   (SELECT d FROM ordered WHERE rn = 250), (SELECT MAX(rn) FROM ordered)
    UNION ALL SELECT 'ap_50k',          (SELECT MIN(d) FROM ordered WHERE running_ap >= 50000),  (SELECT MAX(running_ap) FROM ordered)
    UNION ALL SELECT 'ap_100k',         (SELECT MIN(d) FROM ordered WHERE running_ap >= 100000), (SELECT MAX(running_ap) FROM ordered)
    UNION ALL SELECT 'ap_250k',         (SELECT MIN(d) FROM ordered WHERE running_ap >= 250000), (SELECT MAX(running_ap) FROM ordered)
    UNION ALL SELECT 'streak_5',        (SELECT MIN(d) FROM sale_run WHERE n >= 5),  5
    UNION ALL SELECT 'consistency_30',  (SELECT MIN(d) FROM dial_run WHERE n >= 30), 30
    UNION ALL SELECT 'weekend_warrior', (SELECT MIN(sub_date) FROM sale WHERE EXTRACT(dow FROM sub_date) IN (0,6)), 1
    UNION ALL SELECT 'comeback',        (SELECT MIN(d) FROM gaps WHERE gap >= 10), 1
    UNION ALL SELECT 'iron_dialer',     (SELECT MIN(wk) FROM weeks_dials WHERE n >= 500), (SELECT MAX(n) FROM weeks_dials)
    UNION ALL SELECT 'marathon',        (SELECT MIN(d) FROM cday WHERE talk >= 18000),    (SELECT MAX(talk) FROM cday)
    UNION ALL SELECT 'placed_and_paid', (SELECT MIN(d) FROM placed_run WHERE ok = 1 AND n >= 10), 10
  LOOP
    CONTINUE WHEN v_rec.on_date IS NULL;

    INSERT INTO public.agent_achievements (agent_id, achievement_key, earned_on, value, earned_at)
    VALUES (p_agent, v_rec.k, v_rec.on_date, v_rec.v,
            -- Noon on the historical day, never midnight: earned_at is a
            -- timestamptz rendered in the reader's local zone, and midnight
            -- shows the PREVIOUS day for every agent west of UTC. This
            -- schema has paid for that lesson once already (20260741).
            (v_rec.on_date + TIME '12:00') AT TIME ZONE 'UTC')
    ON CONFLICT (agent_id, achievement_key) DO NOTHING;

    IF FOUND THEN
      v_awarded := v_awarded + 1;
      IF NOT p_silent AND v_leader IS NOT NULL AND NOT v_hidden THEN
        SELECT d.name INTO v_label FROM public.achievement_definitions d WHERE d.key = v_rec.k;
        INSERT INTO public.agency_milestones
          (leader_id, agent_id, agent_name, kind, ref_key, title, body, value, dedupe_key)
        VALUES (v_leader, p_agent, v_name, 'achievement', v_rec.k,
                v_name || ' earned ' || COALESCE(v_label, v_rec.k), NULL, v_rec.v,
                'achievement:' || p_agent::text || ':' || v_rec.k)
        ON CONFLICT (leader_id, dedupe_key) DO NOTHING;
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'agent', p_agent,
                            'achievements', v_awarded, 'records', v_records,
                            'leader', v_leader, 'hidden', v_hidden);
END;
$$;


-- ============================================================
-- 17. AGENCY RECORDS.
--
-- Recomputed across the agency rather than derived from one agent's pass,
-- because three of the seven ("best single-day agency AP") are a SUM across
-- members and no single agent's evaluation can see them.
--
-- Only VISIBLE members contribute. A hidden agent does not hold agency
-- records and does not lift the team-combined ones — being off the boards
-- has to mean off the boards, or the opt-out would leak production back in
-- through a record row.
-- ============================================================
CREATE OR REPLACE FUNCTION public.lb_evaluate_agency(p_leader uuid, p_silent boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rec   record;
  v_old   numeric;
  v_count int := 0;
  v_hold  text;
BEGIN
  IF p_leader IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_agency'); END IF;

  FOR v_rec IN
    WITH vis AS (SELECT agent_id FROM public.lb_visible_members(p_leader)),
    pol AS (
      SELECT po.agent_id AS uid,
             (COALESCE(NULLIF(po.data->>'dateSubmitted',''), NULLIF(po.data->>'draft','')))::date AS sub_date,
             CASE WHEN COALESCE(po.data->>'ap','') ~ '^-?[0-9]+(\.[0-9]+)?$'
                  THEN (po.data->>'ap')::numeric ELSE 0 END AS ap,
             (SELECT (l.created_at AT TIME ZONE 'America/Chicago')::date
                FROM public.leads l
               WHERE l.agent_id = po.agent_id AND l.client_id = po.data->>'soldLeadId') AS lead_created
        FROM public.policies po
        JOIN vis ON vis.agent_id = po.agent_id
       WHERE COALESCE(po.data->>'status','') NOT IN ('lapsed','chargeback','denied','withdrawn')
         AND COALESCE(NULLIF(po.data->>'dateSubmitted',''), NULLIF(po.data->>'draft','')) ~ '^\d{4}-\d{2}-\d{2}'
    ),
    team_day   AS (SELECT sub_date d, SUM(ap) ap FROM pol GROUP BY 1),
    team_week  AS (SELECT date_trunc('week',  sub_date)::date d, SUM(ap) ap FROM pol GROUP BY 1),
    team_month AS (SELECT date_trunc('month', sub_date)::date d, SUM(ap) ap FROM pol GROUP BY 1),
    agent_day  AS (SELECT uid, sub_date d, SUM(ap) ap, COUNT(*) n FROM pol GROUP BY 1,2),
    l2s        AS (SELECT uid, sub_date d, (sub_date - lead_created) days FROM pol
                    WHERE lead_created IS NOT NULL AND sub_date >= lead_created)
    SELECT 'team_day_ap' AS k,
           (SELECT ap FROM team_day ORDER BY ap DESC, d LIMIT 1) AS v,
           (SELECT d  FROM team_day ORDER BY ap DESC, d LIMIT 1) AS on_date,
           NULL::uuid AS holder
    UNION ALL SELECT 'team_week_ap',  (SELECT ap FROM team_week  ORDER BY ap DESC, d LIMIT 1),
                                      (SELECT d  FROM team_week  ORDER BY ap DESC, d LIMIT 1), NULL
    UNION ALL SELECT 'team_month_ap', (SELECT ap FROM team_month ORDER BY ap DESC, d LIMIT 1),
                                      (SELECT d  FROM team_month ORDER BY ap DESC, d LIMIT 1), NULL
    UNION ALL SELECT 'agent_day_ap',  (SELECT ap  FROM agent_day ORDER BY ap DESC, d LIMIT 1),
                                      (SELECT d   FROM agent_day ORDER BY ap DESC, d LIMIT 1),
                                      (SELECT uid FROM agent_day ORDER BY ap DESC, d LIMIT 1)
    UNION ALL SELECT 'agent_day_policies', (SELECT n   FROM agent_day ORDER BY n DESC, d LIMIT 1),
                                           (SELECT d   FROM agent_day ORDER BY n DESC, d LIMIT 1),
                                           (SELECT uid FROM agent_day ORDER BY n DESC, d LIMIT 1)
    UNION ALL SELECT 'biggest_policy_ap',  (SELECT ap       FROM pol ORDER BY ap DESC, sub_date LIMIT 1),
                                           (SELECT sub_date FROM pol ORDER BY ap DESC, sub_date LIMIT 1),
                                           (SELECT uid      FROM pol ORDER BY ap DESC, sub_date LIMIT 1)
    UNION ALL SELECT 'fastest_lead_to_sale', (SELECT days FROM l2s ORDER BY days, d LIMIT 1),
                                             (SELECT d    FROM l2s ORDER BY days, d LIMIT 1),
                                             (SELECT uid  FROM l2s ORDER BY days, d LIMIT 1)
  LOOP
    CONTINUE WHEN v_rec.v IS NULL;
    CONTINUE WHEN v_rec.v <= 0 AND v_rec.k <> 'fastest_lead_to_sale';
    CONTINUE WHEN v_rec.on_date IS NULL;

    SELECT ar.value INTO v_old FROM public.agency_records ar
     WHERE ar.leader_id = p_leader AND ar.record_key = v_rec.k;

    IF public.lb_record_is_better(v_rec.k, v_rec.v, v_old) THEN
      v_hold := public.lb_agent_name(v_rec.holder);

      INSERT INTO public.agency_records
        (leader_id, record_key, value, holder_agent_id, holder_name, occurred_on)
      VALUES (p_leader, v_rec.k, v_rec.v, v_rec.holder, v_hold, v_rec.on_date)
      ON CONFLICT (leader_id, record_key) DO UPDATE
        SET value = EXCLUDED.value, holder_agent_id = EXCLUDED.holder_agent_id,
            holder_name = EXCLUDED.holder_name, occurred_on = EXCLUDED.occurred_on,
            set_at = now(), updated_at = now();
      v_count := v_count + 1;

      IF NOT p_silent AND v_old IS NOT NULL THEN
        INSERT INTO public.agency_milestones
          (leader_id, agent_id, agent_name, kind, ref_key, title, body, value, dedupe_key)
        VALUES (p_leader, v_rec.holder, v_hold, 'agency_record', v_rec.k,
                'New agency record',
                public.lb_record_label(v_rec.k) || ' — ' || public.lb_record_display(v_rec.k, v_rec.v)
                  || COALESCE(' · ' || v_hold, ''),
                v_rec.v,
                'agency_record:' || v_rec.k || ':' || v_rec.v::text)
        ON CONFLICT (leader_id, dedupe_key) DO NOTHING;
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'leader', p_leader, 'records', v_count);
END;
$$;


-- ============================================================
-- 18. lb_refresh_me — the browser's only write path.
--
-- No parameters, anchored on auth.uid(). Same shape and reasoning as
-- apply_producer_codes: the tables it writes have no INSERT policy and must
-- not get one, so the write is a definer function that cannot be pointed at
-- anybody else.
-- ============================================================
CREATE OR REPLACE FUNCTION public.lb_refresh_me()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me     uuid := auth.uid();
  v_leader uuid;
  v_agent  jsonb;
  v_agency jsonb := '{}'::jsonb;
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'no_session'); END IF;
  v_agent  := public.lb_evaluate(v_me, false);
  v_leader := public.lb_leader_for(v_me);
  IF v_leader IS NOT NULL THEN
    v_agency := public.lb_evaluate_agency(v_leader, false);
  END IF;
  RETURN jsonb_build_object('ok', true, 'agent', v_agent, 'agency', v_agency);
END;
$$;


-- ============================================================
-- 19. lb_evaluate_all — the backfill and the nightly sweep.
--
-- p_silent = true is the LAUNCH BACKFILL: it computes every historical
-- record and unlock and writes ZERO feed events, so an existing agent opens
-- the gallery to a filled-in history instead of arriving at zero, and
-- nobody's feed is flooded with badges they earned last spring.
--
-- Re-running with p_silent = false afterwards writes nothing new either: the
-- records are already at their historical maxima and the achievement rows
-- already exist, so no milestone fires. That is the idempotency proof.
-- ============================================================
CREATE OR REPLACE FUNCTION public.lb_evaluate_all(p_silent boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row     record;
  v_agents  int := 0;
  v_leaders int := 0;
BEGIN
  FOR v_row IN SELECT a.id FROM public.agents a ORDER BY a.created_at LOOP
    PERFORM public.lb_evaluate(v_row.id, p_silent);
    v_agents := v_agents + 1;
  END LOOP;

  FOR v_row IN
    SELECT DISTINCT ai.leader_id AS id
      FROM public.agency_invites ai
     WHERE ai.status = 'accepted' AND ai.invitee_id IS NOT NULL
  LOOP
    PERFORM public.lb_evaluate_agency(v_row.id, p_silent);
    v_leaders := v_leaders + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'agents', v_agents, 'agencies', v_leaders, 'silent', p_silent);
END;
$$;


-- ============================================================
-- 20. SNAPSHOTS + ROLLOVER.
--
-- A closed period is frozen so a policy edited in September cannot rewrite
-- who won July. The snapshot reads lb_board_rows() — the same function the
-- live board reads — so the frozen standings and the standings that were on
-- screen all month are the same computation, not two.
--
-- The prior period is passed in so `improved` snapshots correctly too.
-- ============================================================
CREATE OR REPLACE FUNCTION public.lb_snapshot_period(
  p_leader uuid, p_kind text, p_start date, p_end date
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev_start date;
  v_n int := 0;
BEGIN
  IF p_leader IS NULL OR p_start IS NULL OR p_end IS NULL THEN RETURN 0; END IF;

  v_prev_start := CASE p_kind
    WHEN 'week'    THEN p_start - 7
    WHEN 'month'   THEN (p_start - INTERVAL '1 month')::date
    WHEN 'quarter' THEN (p_start - INTERVAL '3 months')::date
  END;

  WITH ags AS (SELECT array_agg(agent_id) a FROM public.lb_visible_members(p_leader)),
  brd AS (
    SELECT * FROM public.lb_board_rows(
      (SELECT a FROM ags),
      p_start::timestamptz, p_end::timestamptz,
      v_prev_start::timestamptz, p_start::timestamptz, 'net')
  ),
  ins AS (
    INSERT INTO public.leaderboard_snapshots
      (leader_id, period_kind, period_start, period_end, board_key, rank, agent_id, agent_name, value)
    SELECT p_leader, p_kind, p_start, p_end, b.board_key, b.rank, b.agent_id,
           public.lb_agent_name(b.agent_id), b.value
      FROM brd b
     WHERE b.rank <= 10
    ON CONFLICT (leader_id, period_kind, period_start, board_key, agent_id) DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*)::int INTO v_n FROM ins;

  -- The season line: one feed entry naming the AP winner, and only when this
  -- run actually created the snapshot. A re-run inserts nothing above, so
  -- v_n is 0 and no second announcement is made.
  IF v_n > 0 THEN
    INSERT INTO public.agency_milestones
      (leader_id, agent_id, agent_name, kind, ref_key, title, body, value, occurred_at, dedupe_key)
    SELECT p_leader, s.agent_id, s.agent_name, 'season', p_kind,
           'Top Producer — ' || CASE p_kind
              WHEN 'week'  THEN 'week of ' || to_char(p_start, 'Mon FMDD')
              WHEN 'month' THEN to_char(p_start, 'FMMonth YYYY')
              ELSE 'Q' || to_char(p_start, 'Q YYYY') END,
           s.agent_name || ' — $' || to_char(round(s.value), 'FM999,999,999') || ' AP',
           s.value, (p_end + TIME '12:00') AT TIME ZONE 'UTC',
           'season:' || p_kind || ':' || p_start::text || ':ap'
      FROM public.leaderboard_snapshots s
     WHERE s.leader_id = p_leader AND s.period_kind = p_kind
       AND s.period_start = p_start AND s.board_key = 'ap' AND s.rank = 1
    ON CONFLICT (leader_id, dedupe_key) DO NOTHING;
  END IF;

  RETURN v_n;
END;
$$;

-- The cron entry point. One job, three checks, driven by the Chicago
-- calendar rather than the server's UTC clock — a job firing at 01:10
-- Central must agree with the agent about which day it is.
--
-- Every branch is idempotent through the snapshot's unique key, so a missed
-- night is not a lost period: the next run re-checks the same conditions,
-- and re-running by hand any number of times writes the period once.
CREATE OR REPLACE FUNCTION public.lb_rollover(p_today date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today  date := COALESCE(p_today, (now() AT TIME ZONE 'America/Chicago')::date);
  v_leader record;
  v_week   int := 0;
  v_month  int := 0;
  v_qtr    int := 0;
BEGIN
  FOR v_leader IN
    SELECT DISTINCT ai.leader_id AS id
      FROM public.agency_invites ai
     WHERE ai.status = 'accepted' AND ai.invitee_id IS NOT NULL
  LOOP
    IF EXTRACT(dow FROM v_today) = 1 THEN
      v_week := v_week + public.lb_snapshot_period(v_leader.id, 'week', v_today - 7, v_today);
    END IF;

    IF EXTRACT(day FROM v_today) = 1 THEN
      v_month := v_month + public.lb_snapshot_period(
        v_leader.id, 'month', (v_today - INTERVAL '1 month')::date, v_today);

      IF EXTRACT(month FROM v_today) IN (1,4,7,10) THEN
        v_qtr := v_qtr + public.lb_snapshot_period(
          v_leader.id, 'quarter', (v_today - INTERVAL '3 months')::date, v_today);
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'today', v_today,
                            'week_rows', v_week, 'month_rows', v_month, 'quarter_rows', v_qtr);
END;
$$;


-- ============================================================
-- 21. GRANTS.
--
-- The split IS the security boundary, not a tidy-up: everything that takes
-- an agent or a leader as a parameter is unreachable from a browser session.
-- ============================================================
REVOKE ALL ON FUNCTION public.lb_leader_for(uuid)                                      FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lb_members(uuid)                                         FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lb_visible_members(uuid)                                 FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lb_agent_name(uuid)                                      FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lb_agent_metrics(uuid[], timestamptz, timestamptz, text)  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lb_board_rows(uuid[], timestamptz, timestamptz, timestamptz, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lb_evaluate(uuid, boolean)                               FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lb_evaluate_agency(uuid, boolean)                        FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lb_evaluate_all(boolean)                                 FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lb_snapshot_period(uuid, text, date, date)               FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lb_rollover(date)                                        FROM PUBLIC;

REVOKE ALL ON FUNCTION public.lb_leader_for(uuid)                                      FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.lb_members(uuid)                                         FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.lb_visible_members(uuid)                                 FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.lb_agent_name(uuid)                                      FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.lb_agent_metrics(uuid[], timestamptz, timestamptz, text)  FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.lb_board_rows(uuid[], timestamptz, timestamptz, timestamptz, timestamptz, text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.lb_evaluate(uuid, boolean)                               FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.lb_evaluate_agency(uuid, boolean)                        FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.lb_evaluate_all(boolean)                                 FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.lb_snapshot_period(uuid, text, date, date)               FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.lb_rollover(date)                                        FROM anon, authenticated;

GRANT EXECUTE ON FUNCTION public.lb_leader_for(uuid)                                     TO service_role;
GRANT EXECUTE ON FUNCTION public.lb_members(uuid)                                        TO service_role;
GRANT EXECUTE ON FUNCTION public.lb_visible_members(uuid)                                TO service_role;
GRANT EXECUTE ON FUNCTION public.lb_agent_name(uuid)                                     TO service_role;
GRANT EXECUTE ON FUNCTION public.lb_agent_metrics(uuid[], timestamptz, timestamptz, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.lb_board_rows(uuid[], timestamptz, timestamptz, timestamptz, timestamptz, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.lb_evaluate(uuid, boolean)                              TO service_role;
GRANT EXECUTE ON FUNCTION public.lb_evaluate_agency(uuid, boolean)                       TO service_role;
GRANT EXECUTE ON FUNCTION public.lb_evaluate_all(boolean)                                TO service_role;
GRANT EXECUTE ON FUNCTION public.lb_snapshot_period(uuid, text, date, date)              TO service_role;
GRANT EXECUTE ON FUNCTION public.lb_rollover(date)                                       TO service_role;

-- Pure formatters, no data access at all.
GRANT EXECUTE ON FUNCTION public.lb_biz_index(date)                         TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.lb_record_is_better(text, numeric, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.lb_record_label(text)                      TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.lb_record_display(text, numeric)           TO authenticated, service_role;

-- Browser-callable. Not one of them takes a parameter naming an agent.
GRANT EXECUTE ON FUNCTION public.get_agency_leaderboards(timestamptz, timestamptz, timestamptz, timestamptz, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.lb_my_agency_state()         TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_agency_records()         TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_agency_milestones(int)   TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_agency_hall_of_fame(int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_achievements()        TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.lb_refresh_me()              TO authenticated, service_role;
