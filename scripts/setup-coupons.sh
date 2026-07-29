#!/usr/bin/env bash
#
# One-time Stripe coupon setup for ProducerStack (run against LIVE mode).
#
#   1. DOWNLINE30 — 30% off forever. The app auto-applies this to every downline
#      agent at checkout; it MUST exist or their checkout fails with
#      "No such coupon: 'DOWNLINE30'". (Same id/shape as
#      supabase/functions/stripe-create-checkout/index.ts.)
#
#   2. TESTER45   — $34.99 off forever. Applied by hand to a single tester's
#      subscription so Basic ($79.99) nets out to exactly $45.00/mo.
#
# Idempotent: if a coupon already exists it is left untouched.
#
# USAGE:
#   export STRIPE_SECRET_KEY=sk_live_...        # your standard secret key
#   bash scripts/setup-coupons.sh
#
set -euo pipefail

KEY="${STRIPE_SECRET_KEY:-}"
if [ -z "$KEY" ]; then
  echo "ERROR: set STRIPE_SECRET_KEY first, e.g.:"
  echo "  export STRIPE_SECRET_KEY=sk_live_..."
  exit 1
fi
case "$KEY" in
  sk_live_*) MODE="LIVE" ;;
  sk_test_*) MODE="TEST" ;;
  *) echo "ERROR: key should start with sk_live_ (or sk_test_). Got something else."; exit 1 ;;
esac
echo "Using $MODE key ...${KEY: -4}"
echo

# ensure_coupon <id> <human label> <extra curl -d args...>
ensure_coupon() {
  local id="$1"; shift
  local label="$1"; shift
  # Does it already exist?
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" "https://api.stripe.com/v1/coupons/$id" -u "$KEY:")
  if [ "$code" = "200" ]; then
    echo "= $id already exists — leaving it untouched."
    return
  fi
  echo "+ creating $id ($label)..."
  curl -s "https://api.stripe.com/v1/coupons" -u "$KEY:" \
    -d "id=$id" "$@" \
    | sed 's/,/,\n  /g' | grep -E '"id"|"percent_off"|"amount_off"|"duration"|"name"|"error"|"message"' || true
  echo
}

ensure_coupon "DOWNLINE30" "30% off forever — downline seats" \
  -d "percent_off=30" \
  -d "duration=forever" \
  -d "name=Downline agent seat — 30% off (Team Leader upline)"

ensure_coupon "TESTER45" "\$34.99 off forever — Basic at \$45/mo for testers" \
  -d "amount_off=3499" \
  -d "currency=usd" \
  -d "duration=forever" \
  -d "name=Tester — Basic at \$45/mo"

echo "Done. Verify at https://dashboard.stripe.com/coupons"
