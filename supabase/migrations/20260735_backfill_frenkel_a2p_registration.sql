-- ============================================================
-- 20260735_backfill_frenkel_a2p_registration.sql
--
-- Data backfill only. No DDL.
--
-- Creates the one public.a2p_registrations row that links Jace's agent
-- account to the Telnyx brand and campaign that already exist and have
-- already been paid for:
--
--     brand     4b20019f-a5df-2721-e3c1-cea9522125a0   BBTQ508   VERIFIED
--     campaign  4b30019f-a9df-e17b-3529-70677db27ec4   CD2166Q
--
-- WHY BY HAND AND NOT THROUGH a2p-register
-- ----------------------------------------
-- Both objects were created through the Telnyx portal, outside this system.
-- a2p-register's job is to CREATE a brand and campaign and debit the wallet
-- for them; pointing it at this agent would try to make a second billable
-- pair. The row is the only thing missing, so the row is the only thing made.
--
-- WHAT THIS FIXES
-- ---------------
-- a2p_registrations held ZERO rows, and two things read it:
--
--   * runComplianceGate() refuses every SMS unless a row for the sending
--     agent reads status = 'approved'. With no row, that could never pass —
--     so even a perfect campaign enabled exactly no texts.
--   * a2p-status-poll sweeps this table. With no row it had nothing to
--     match on, so CD2166Q could be approved, suspended or expired and the
--     app would never notice.
--
-- STATUS IS 'pending', DELIBERATELY, AND IS NOT HAND-STAMPED
-- ---------------------------------------------------------
-- 'pending' is the state that means "ask Telnyx". a2p-status-poll picks up
-- exactly status in ('pending','approved') with a non-null brand_id and
-- campaign_id, reads the live brand identityStatus and campaign
-- campaignStatus, and writes whatever those normalize to. Writing 'approved'
-- here would assert a carrier outcome from a SQL file instead of observing
-- it, and 'approved' is the single value the send gate allowlists.
--
-- At the time of writing Telnyx reports identityStatus VERIFIED and
-- campaignStatus TCR_ACCEPTED, which normalizeStatus() maps to 'approved'.
-- So the poll is expected to promote this row on its next run. That promotion
-- is the system reading Telnyx, which is the point.
--
-- THE FEE COLUMNS ARE SET, AND THEY HAVE TO BE
-- --------------------------------------------
-- brand_fee_charged_at / campaign_fee_charged_at are the ONLY guards that
-- stop advanceRegistration() calling wallet_debit. They are checked before
-- each charge (a2p-registration.ts steps 2 and 5); a NULL means "not yet
-- charged, charge it now". Leaving them null would mean the Retry button on
-- the status wizard — or any future a2p-register call for this agent —
-- debits Jace's wallet $4 + $14.50 for a brand and campaign he has already
-- paid Telnyx for directly.
--
-- They are set to Telnyx's own billing timestamps. The fee is genuinely
-- settled; it was settled on Telnyx's invoice rather than through the
-- ProducerStack wallet, and business_info records that in as many words.
-- wallet_ledger holds 0 rows with ref_type in ('a2p_brand','a2p_campaign')
-- before and after this file, and this file does not add any — nothing here
-- moves money.
--
-- Idempotent: on conflict (agent_id) do nothing. Re-running changes nothing,
-- and in particular cannot overwrite a status the poll has since updated.
-- ============================================================

insert into public.a2p_registrations (
  agent_id,
  brand_id,
  campaign_id,
  tcr_brand_id,
  tcr_campaign_id,
  status,
  brand_type,
  telnyx_env,
  website_url,
  brand_fee_mills,
  campaign_fee_mills,
  monthly_fee_mills,
  brand_submitted_at,
  campaign_submitted_at,
  brand_fee_charged_at,
  campaign_fee_charged_at,
  registered_at,
  business_info
)
select
  a.id,
  '4b20019f-a5df-2721-e3c1-cea9522125a0',
  '4b30019f-a9df-e17b-3529-70677db27ec4',
  'BBTQ508',
  'CD2166Q',
  'pending',
  'standard',
  'production',
  'https://trust.producerstackcrm.com/a/frenkel-financial-agency/privacy-policy',
  4000,
  14500,
  1500,
  '2026-07-27T23:18:14.830Z',   -- Telnyx brand createdAt
  '2026-07-28T18:00:15.000Z',   -- Telnyx campaign createDate
  '2026-07-27T23:18:14.830Z',   -- settled on Telnyx's invoice, not the wallet
  '2026-07-28T00:00:00.000Z',   -- Telnyx campaign billedDate
  '2026-07-28T18:00:15.000Z',
  jsonb_build_object(
    'backfill', true,
    'backfilled_on', '2026-07-29',
    'source', 'Created in the Telnyx portal, outside a2p-register. Row added by 20260735_backfill_frenkel_a2p_registration.sql.',
    'fees_paid_via', 'Telnyx invoice, directly. NOT debited from the ProducerStack wallet — wallet_ledger has no a2p_brand/a2p_campaign rows for this agent. The *_fee_charged_at columns are set so advanceRegistration() does not charge a second time for objects already paid for.',
    'brand_display_name', 'Frenkel Financial Agency',
    'telnyx_state_at_backfill', jsonb_build_object(
      'brand_identity_status', 'VERIFIED',
      'campaign_status', 'TCR_ACCEPTED',
      'campaign_submission_status', 'CREATED',
      'is_t_mobile_registered', false,
      'note', 'campaignStatus was TELNYX_FAILED until the messageFlow + optinMessage were corrected in place on 2026-07-29; it moved to TCR_ACCEPTED on that PUT.'
    )
  )
from public.agents a
where a.compliance_slug = 'frenkel-financial-agency'
on conflict (agent_id) do nothing;

-- Verification.
do $$
declare
  r record;
begin
  select ar.status, ar.brand_id, ar.campaign_id, ar.telnyx_env,
         ar.brand_fee_charged_at, ar.campaign_fee_charged_at
    into r
    from public.a2p_registrations ar
    join public.agents a on a.id = ar.agent_id
   where a.compliance_slug = 'frenkel-financial-agency';

  if not found then
    raise exception 'backfill: no a2p_registrations row for frenkel-financial-agency';
  end if;
  if r.brand_id is null or r.campaign_id is null then
    raise exception 'backfill: brand_id/campaign_id null — a2p-status-poll would skip this row';
  end if;
  if r.status not in ('pending', 'approved', 'rejected', 'suspended', 'expired') then
    raise exception 'backfill: unexpected status %', r.status;
  end if;
  if r.brand_fee_charged_at is null or r.campaign_fee_charged_at is null then
    raise exception 'backfill: a fee guard is null — advanceRegistration would double-charge';
  end if;
  raise notice 'backfill OK: status=% env=% brand=% campaign=%', r.status, r.telnyx_env, r.brand_id, r.campaign_id;
end $$;
