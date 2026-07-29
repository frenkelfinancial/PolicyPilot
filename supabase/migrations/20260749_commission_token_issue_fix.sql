-- ============================================================
-- Back Office Phase 1b — fix: the token guard was eating its own write.
--
-- THE BUG, found by the first real inbound email.
--
-- `issue_commission_email_token()` is SECURITY DEFINER, so it is allowed to
-- write `agents.commission_email_token`. But `auth.role()` reads the JWT
-- CLAIM, and the claim is still 'authenticated' INSIDE a definer function
-- invoked by a browser. So `agents_protect_commission_token` — which reverts
-- the column for any authenticated caller — reverted the definer's own
-- UPDATE.
--
-- The function then returned the token it had just generated, so the caller
-- saw a plausible address. Nothing was persisted. The first real email to that
-- address resolved to nobody and was filed `unresolved`.
--
-- 20260736 records this exact trap, in this exact schema, about
-- `set_my_agency_profile`:
--
--   "auth.role() reads the JWT claim, so it is still 'authenticated' inside a
--    SECURITY DEFINER RPC invoked from the browser — a blanket freeze would
--    also revert the UPDATE that set_my_agency_profile itself performs."
--
-- The fix is the same one that file used: GATE, do not freeze. The guard must
-- let the one legitimate writer through and revert everything else.
--
-- The gate is a transaction-local setting the issuing function sets
-- immediately before its UPDATE — the same idiom `20260731` already uses for
-- `app.a2p_allow_id_change`. It cannot be set from PostgREST (no SQL there),
-- and it is `is_local => true`, so it cannot outlive the statement that set
-- it.
-- ============================================================

create or replace function public.agents_protect_commission_token()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  -- The issuing function announces itself for exactly one transaction. Any
  -- other authenticated write is reverted, which is the whole point of the
  -- guard: a client must not be able to choose, clear or re-enable its own
  -- forwarding address.
  if coalesce(current_setting('app.commission_token_issue', true), '') = 'on' then
    return new;
  end if;

  if coalesce(auth.role(), '') in ('authenticated', 'anon') then
    new.commission_email_token      := old.commission_email_token;
    new.commission_email_rotated_at := old.commission_email_rotated_at;
    new.commission_email_enabled    := old.commission_email_enabled;
  end if;
  return new;
end
$fn$;


create or replace function public.issue_commission_email_token(
  p_rotate boolean default false
)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  uid uuid := auth.uid();
  existing text;
  candidate text;
  tries int := 0;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select commission_email_token into existing from public.agents where id = uid;
  if existing is not null and not p_rotate then
    return existing;
  end if;

  -- 32 hex chars = 128 bits, from CORE gen_random_uuid() rather than
  -- pgcrypto's gen_random_bytes(), which lives in the `extensions` schema this
  -- function's pinned search_path cannot see.
  loop
    tries := tries + 1;
    candidate := replace(gen_random_uuid()::text, '-', '');
    exit when not exists (
      select 1 from public.agents where commission_email_token = candidate
    );
    if tries > 5 then
      raise exception 'could not allocate a commission email token';
    end if;
  end loop;

  -- Open the gate for this statement only, then close it immediately. Leaving
  -- it open for the rest of the transaction would let any later UPDATE in the
  -- same request write the column too.
  perform set_config('app.commission_token_issue', 'on', true);

  update public.agents
     set commission_email_token = candidate,
         commission_email_rotated_at = case when existing is null then null else now() end,
         commission_email_enabled = true
   where id = uid;

  perform set_config('app.commission_token_issue', 'off', true);

  -- Read the value BACK rather than returning what we meant to write. That is
  -- the assertion that would have caught this bug the first time: if a guard
  -- ever reverts this write again, the caller gets null instead of a
  -- confident, non-existent address.
  select commission_email_token into existing from public.agents where id = uid;
  return existing;
end
$fn$;

grant execute on function public.issue_commission_email_token(boolean) to authenticated;
