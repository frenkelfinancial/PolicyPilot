#!/usr/bin/env node
/**
 * ProducerStack repricing — repoint plans.stripe_price_id (July 2026)
 * ===================================================================
 * Run this AFTER scripts/stripe-repricing-2026-07.mjs has created the new
 * prices. It resolves each new monthly price by its lookup_key straight from
 * Stripe and updates public.plans.stripe_price_id in Supabase, so new signups
 * are charged the new seat price ($79.99 / $129.99 / $199.99) instead of the
 * old one — no copying price IDs by hand.
 *
 * Auth:
 *   STRIPE_SECRET_KEY           — same key you used for the repricing script
 *                                 (use the LIVE key here to repoint live plans).
 *   SUPABASE_SERVICE_ROLE_KEY   — auto-loaded from .env.local if present,
 *                                 or set it in the environment.
 *   SUPABASE_URL                — optional; defaults to the linked project.
 *
 * Usage (PowerShell):
 *   $env:STRIPE_SECRET_KEY = "sk_live_..."
 *   node scripts/repoint-plans-2026-07.mjs            # DRY RUN — prints the plan, writes nothing
 *   node scripts/repoint-plans-2026-07.mjs --apply    # actually update plans.stripe_price_id
 */
import Stripe from 'stripe';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const APPLY = process.argv.includes('--apply');
const TAG = '2026-07';

// Each seat tier: which plans.slug it maps to, the Stripe lookup_key of the new
// monthly price, and a name substring used only as a fallback / sanity check.
const TIERS = [
  { slug: 'basic', lookupKey: `basic_monthly_${TAG}`,  nameHint: 'basic'  },
  { slug: 'pro',   lookupKey: `pro_monthly_${TAG}`,    nameHint: 'pro'    },
  { slug: 'max',   lookupKey: `leader_monthly_${TAG}`, nameHint: 'leader' },
];

// ── Load SUPABASE_SERVICE_ROLE_KEY from .env.local if it isn't already set ──
function loadEnvLocal() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const text = readFileSync(join(here, '..', '.env.local'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  } catch { /* no .env.local — rely on the environment */ }
}
loadEnvLocal();

const STRIPE_KEY   = process.env.STRIPE_SECRET_KEY;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cweiaibjigjwspmshcrj.supabase.co';

if (!STRIPE_KEY)  { console.error('Set STRIPE_SECRET_KEY (the same key you repriced with).'); process.exit(1); }
if (!SERVICE_KEY) { console.error('SUPABASE_SERVICE_ROLE_KEY not found (checked env + .env.local).'); process.exit(1); }

const stripe = new Stripe(STRIPE_KEY);
const sbHeaders = {
  'apikey': SERVICE_KEY,
  'Authorization': `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

async function getPlans() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/plans?select=id,slug,name,stripe_price_id`, { headers: sbHeaders });
  if (!res.ok) throw new Error(`Supabase read failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function priceIdForLookupKey(lookupKey) {
  const list = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  return list.data[0]?.id || null;
}

async function updatePlanPrice(slug, priceId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/plans?slug=eq.${encodeURIComponent(slug)}`, {
    method: 'PATCH',
    headers: { ...sbHeaders, 'Prefer': 'return=representation' },
    body: JSON.stringify({ stripe_price_id: priceId }),
  });
  if (!res.ok) throw new Error(`Supabase update failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function main() {
  console.log(`\nRepoint plans.stripe_price_id — ${APPLY ? '*** APPLY MODE ***' : 'dry run (pass --apply to execute)'}`);
  console.log(`Supabase: ${SUPABASE_URL}\n`);

  const plans = await getPlans();
  let changed = 0;

  for (const tier of TIERS) {
    // Match by slug first, then fall back to a name substring so a renamed
    // slug is surfaced loudly instead of silently skipped.
    let plan = plans.find(p => p.slug === tier.slug)
            || plans.find(p => (p.name || '').toLowerCase().includes(tier.nameHint));
    if (!plan) {
      console.log(`  ! no plan row for tier "${tier.slug}" (looked for slug=${tier.slug} / name~${tier.nameHint}) — skipped`);
      continue;
    }

    const newPriceId = await priceIdForLookupKey(tier.lookupKey);
    if (!newPriceId) {
      console.log(`  ! ${tier.lookupKey} not found in Stripe — run stripe-repricing-2026-07.mjs --apply first. Skipped ${plan.name}.`);
      continue;
    }

    if (plan.stripe_price_id === newPriceId) {
      console.log(`  = ${plan.name} (slug ${plan.slug}) already points at ${newPriceId}`);
      continue;
    }

    console.log(`  ${APPLY ? '~ updating' : '~ would update'}: ${plan.name} (slug ${plan.slug}): ${plan.stripe_price_id || '(none)'} -> ${newPriceId}`);
    if (APPLY) { await updatePlanPrice(plan.slug, newPriceId); changed++; }
  }

  console.log(`\n${APPLY ? `Done. ${changed} plan(s) updated.` : 'Nothing was changed — re-run with --apply.'}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
