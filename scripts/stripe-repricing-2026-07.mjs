#!/usr/bin/env node
/**
 * ProducerStack repricing — July 2026
 * ====================================
 * Hand this to Claude Code (or run directly): `node stripe-repricing-2026-07.mjs`
 *
 * What it does, in order:
 *   1. Finds the three seat products (Basic Producer, Pro Producer, Team Leader).
 *   2. Creates the NEW prices (idempotent via lookup_keys):
 *        basic_monthly_2026-07   $79.99/mo     basic_annual_2026-07   $815.90/yr  (= $67.99/mo, 15% off)
 *        pro_monthly_2026-07     $129.99/mo    pro_annual_2026-07     $1,325.90/yr (= $110.49/mo, 15% off)
 *        leader_monthly_2026-07  $199.99/mo    leader_annual_2026-07  $2,039.90/yr (= $169.99/mo, 15% off)
 *   3. Archives (active=false) the OLD prices: $89.99 / $149.99 / $249.99 monthly.
 *   4. Migrates every active/trialing subscription on an old price to the new
 *      monthly price with proration_behavior='none' — nobody is charged or
 *      credited today; they simply renew at the NEW (lower) price at their next
 *      renewal date. Trials are untouched (7-day trial stays as-is at signup).
 *   5. Creates a DOWNLINE30 coupon: 30% off, duration=forever, for downline agent
 *      seats whose team leader is on Team Leader. SEATS ONLY — never apply it to
 *      wallet top-ups (top-ups are one-time payments, so a subscription coupon
 *      can't touch them, but never pass it to a top-up checkout either).
 *
 * What it does NOT do (wallet rates live in Supabase billing_config, not Stripe):
 *   see wallet-rates-2026-07.sql next to this file.
 *
 * Usage:
 *   export STRIPE_SECRET_KEY=sk_live_...        (use sk_test_ first!)
 *   node stripe-repricing-2026-07.mjs           # DRY RUN — prints the plan, changes nothing
 *   node stripe-repricing-2026-07.mjs --apply   # actually do it
 *
 * If product auto-detection picks the wrong products, pin them here:
 */
const PRODUCT_ID_OVERRIDES = {
  basic:  '',   // e.g. 'prod_XXXX'
  pro:    '',
  leader: '',
};

import Stripe from 'stripe';

const APPLY = process.argv.includes('--apply');
const key = process.env.STRIPE_SECRET_KEY;
if (!key) { console.error('Set STRIPE_SECRET_KEY first.'); process.exit(1); }
const stripe = new Stripe(key);

const TIERS = {
  basic:  { match: /basic/i,           monthly: 7999,  annual: 81590,  oldMonthly: 8999  },
  pro:    { match: /pro(?!d)/i,        monthly: 12999, annual: 132590, oldMonthly: 14999 },
  leader: { match: /leader|team/i,     monthly: 19999, annual: 203990, oldMonthly: 24999 },
};
const TAG = '2026-07';
const log = (...a) => console.log(...a);
const act = APPLY ? 'DOING' : 'DRY-RUN (would do)';

async function findProducts() {
  const products = (await stripe.products.list({ active: true, limit: 100 })).data;
  const out = {};
  for (const [tier, cfg] of Object.entries(TIERS)) {
    if (PRODUCT_ID_OVERRIDES[tier]) { out[tier] = await stripe.products.retrieve(PRODUCT_ID_OVERRIDES[tier]); continue; }
    const hit = products.find(p => cfg.match.test(p.name));
    if (!hit) throw new Error(`Could not auto-detect product for tier "${tier}". Set PRODUCT_ID_OVERRIDES.`);
    out[tier] = hit;
  }
  return out;
}

async function ensurePrice(product, tier, interval, unitAmount) {
  const lookupKey = `${tier}_${interval}_${TAG}`;
  const existing = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 });
  if (existing.data.length) { log(`  = ${lookupKey} already exists (${existing.data[0].id})`); return existing.data[0]; }
  log(`  + ${act}: create ${lookupKey} → $${(unitAmount / 100).toFixed(2)}/${interval === 'monthly' ? 'mo' : 'yr'} on ${product.name}`);
  if (!APPLY) return null;
  return stripe.prices.create({
    product: product.id,
    currency: 'usd',
    unit_amount: unitAmount,
    recurring: { interval: interval === 'monthly' ? 'month' : 'year' },
    lookup_key: lookupKey,
    nickname: `${product.name} ${interval} (${TAG} repricing)`,
    metadata: { repricing: TAG, tier },
  });
}

async function main() {
  log(`\nProducerStack Stripe repricing — ${APPLY ? '*** APPLY MODE ***' : 'dry run (pass --apply to execute)'}\n`);
  const products = await findProducts();
  for (const [tier, p] of Object.entries(products)) log(`Product [${tier}]: ${p.name} (${p.id})`);

  // 2. Create new prices
  log('\n— New prices —');
  const newPrices = {};
  for (const [tier, cfg] of Object.entries(TIERS)) {
    newPrices[tier] = {
      monthly: await ensurePrice(products[tier], tier, 'monthly', cfg.monthly),
      annual:  await ensurePrice(products[tier], tier, 'annual',  cfg.annual),
    };
  }

  // 3. Archive old prices
  log('\n— Archive old prices —');
  const oldPriceIds = {};   // priceId -> tier
  for (const [tier, cfg] of Object.entries(TIERS)) {
    const prices = await stripe.prices.list({ product: products[tier].id, active: true, limit: 100 });
    for (const price of prices.data) {
      const isNew = price.metadata?.repricing === TAG;
      if (isNew) continue;
      if (price.recurring?.interval === 'month' && price.unit_amount === cfg.oldMonthly) {
        oldPriceIds[price.id] = tier;
        log(`  - ${act}: archive ${price.id} ($${(price.unit_amount / 100).toFixed(2)}/mo on ${products[tier].name})`);
        if (APPLY) await stripe.prices.update(price.id, { active: false });
      } else if (!isNew) {
        log(`  ? leaving untouched (unexpected amount): ${price.id} $${(price.unit_amount / 100).toFixed(2)}/${price.recurring?.interval}`);
      }
    }
  }

  // 4. Migrate subscribers at next renewal
  log('\n— Migrate active subscribers (new price takes effect at next renewal, no proration) —');
  let migrated = 0;
  for await (const sub of stripe.subscriptions.list({ status: 'active', limit: 100 })) {
    await migrateSub(sub);
  }
  for await (const sub of stripe.subscriptions.list({ status: 'trialing', limit: 100 })) {
    await migrateSub(sub);
  }
  async function migrateSub(sub) {
    for (const item of sub.items.data) {
      const tier = oldPriceIds[item.price.id];
      if (!tier) continue;
      const target = newPrices[tier]?.monthly;
      log(`  ~ ${act}: sub ${sub.id} (${sub.status}) item ${item.id}: ${item.price.id} → ${tier}_monthly_${TAG}`);
      migrated++;
      if (APPLY && target) {
        await stripe.subscriptions.update(sub.id, {
          items: [{ id: item.id, price: target.id }],
          proration_behavior: 'none',       // no mid-cycle charge/credit — new price bills at next renewal
          metadata: { ...sub.metadata, repriced: TAG },
        });
      }
    }
  }
  log(`  ${migrated} subscription item(s) matched old prices.`);

  // 5. Downline coupon
  log('\n— Downline recruiting perk —');
  try {
    await stripe.coupons.retrieve('DOWNLINE30');
    log('  = coupon DOWNLINE30 already exists');
  } catch {
    log(`  + ${act}: create coupon DOWNLINE30 (30% off forever — seats only, never usage)`);
    if (APPLY) await stripe.coupons.create({
      id: 'DOWNLINE30', percent_off: 30, duration: 'forever',
      name: 'Downline agent seat — 30% off (Team Leader upline)',
      metadata: { note: 'Apply to seat subscriptions of downline agents whose leader is on Team Leader. Seats only — never wallet top-ups.' },
    });
  }

  log(`\nDone. ${APPLY ? '' : 'Nothing was changed — re-run with --apply.'}
Remaining manual/app-side steps:
  1. Run wallet-rates-2026-07.sql against Supabase (dialer $0.012/min, numbers $2/mo).
  2. Wire AI voice minutes at $0.075/min (volume rate $0.065/min above 2,000 AI min/mo)
     into billing_config + wallet_debit — new usage type, not a Stripe price.
  3. Point signup checkout at the new lookup_keys (\`*_monthly_${TAG}\` / \`*_annual_${TAG}\`)
     and keep trial_period_days: 7.
  4. Enforce the downline discount server-side: only grant DOWNLINE30 while the
     agent's team leader has an active Team Leader seat; remove it if the leader downgrades.`);
}

main().catch(e => { console.error(e); process.exit(1); });
