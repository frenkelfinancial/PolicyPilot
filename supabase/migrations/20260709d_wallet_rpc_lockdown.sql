-- ============================================================
-- 018_wallet_rpc_lockdown.sql
-- CRITICAL fix: every wallet_* RPC (016/017) was directly callable by
-- `anon` and `authenticated` on the live database, despite each one
-- ending with `revoke all on function ... from public;`.
--
-- Root cause: Supabase's default privilege configuration grants EXECUTE
-- on newly created functions in the public schema directly to the anon,
-- authenticated, and service_role roles (not through the PUBLIC
-- pseudo-role). `revoke ... from public` only revokes what was granted
-- to PUBLIC — it does nothing to a grant already held directly by anon/
-- authenticated, so those grants silently survived every wallet_*
-- function from the moment it was created.
--
-- Impact while live: anyone with the public anon key (embedded in
-- app.html, inherently public) could call e.g.
--   wallet_topup(p_agent: '<any agent uuid>', p_amount_mills: 999999999, ...)
-- directly from a browser console and credit ANY agent's wallet with an
-- arbitrary amount — no login, no dev-account match, no Stripe payment.
-- This is a strictly larger hole than the dev-email bypass found in the
-- same incident (that one only affected the single hardcoded dev account;
-- this one was open to anyone).
--
-- Run once in the Supabase SQL Editor, after 016 and 017. Idempotent —
-- revoking a privilege that's already absent is a no-op, not an error.
-- ============================================================

revoke execute on function public.wallet_topup(uuid, bigint, text, text) from anon, authenticated;
revoke execute on function public.wallet_debit(uuid, text, numeric, bigint, text, text, text) from anon, authenticated;
revoke execute on function public.wallet_hold(uuid, text, numeric, bigint, text, text, text) from anon, authenticated;
revoke execute on function public.wallet_settle(uuid) from anon, authenticated;
revoke execute on function public.wallet_void(uuid) from anon, authenticated;
revoke execute on function public.wallet_credit_topup(uuid, bigint, text, text) from anon, authenticated;
revoke execute on function public.wallet_settle_call(uuid, bigint, numeric, text, text, text) from anon, authenticated;

-- Verify after running (all rows should show can_execute = false for
-- anon/authenticated, true for service_role):
--
-- select p.proname, r.rolname as grantee, has_function_privilege(r.oid, p.oid, 'EXECUTE') as can_execute
--   from pg_proc p cross join pg_roles r
--  where p.proname like 'wallet_%' and r.rolname in ('anon','authenticated','service_role')
--  order by p.proname, r.rolname;
