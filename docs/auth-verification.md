# Verify to activate — password rules, email confirmation, phone check

Shipped 2026-07-31 (prompt H, part F). Schema:
`supabase/migrations/20260804_sms_attestation_and_verification.sql`.
Tests: `supabase/functions/_shared/auth-verify.test.ts` (`npm run test:auth`).

---

## 🔴 Every account that existed on 2026-07-31 is grandfathered

Section 3 of the migration stamps `email_verified_at` and `phone_verified_at`
on **every** `public.agents` row present when it runs. Verified at apply time:
9 agents, 9 email-verified, 9 phone-verified. Nobody using the product today
lost access to anything, the owner included.

This is why both columns are **nullable timestamptz** and not
`boolean not null default false`. A boolean default would have been the same
migration with all nine live agents locked out of calling, texting and the AI
dialer the moment it applied.

The flow below therefore only ever runs for accounts created *after* that
migration.

---

## 1. Password rules

Minimum 8 characters, at least one number, at least one special character.

- **One definition, two copies.** `supabase/functions/_shared/auth-verify.ts`
  and the `// <password-core>` block in `app.html`. The browser copy exists
  because the agent has to see a live checklist as they type; the server copy
  is the one any server-side password path uses. `auth-verify.test.ts` runs
  **several hundred** shared passwords through both and compares
  `passwordOk`, `passwordProblem` and the per-rule met/not-met list. Change
  one, change the other — same arrangement as `pcNormalizeCode()` and the AI
  call meter.
- **"Special" is any printable non-alphanumeric**, including a space. A
  whitelist of a dozen punctuation marks is exactly why every password on
  earth ends in `!`, and it rejects good passphrases over a character the
  author did not think of.
- **All four password fields validate through it** — the signup wizard, the
  legacy signup form, the reset-link screen, and Settings → Change Password.
  Before this round all four said only "at least 8 characters", in four
  separately-written checks. A test asserts that string is gone.
- **`passwordProblem()` names everything missing at once**, not one rule per
  attempt.

### ⚠️ Owner action — the server-side half

Supabase enforces password policy at the auth layer, and it is a
**dashboard-only setting** on this plan. The browser rule above is complete
and enforced on every path the app owns, but `sb.auth.signUp()` talks to
GoTrue directly, so GoTrue has to be told the same rule:

1. Supabase dashboard → project **cweiaibjigjwspmshcrj**
2. **Authentication → Sign In / Providers → Email**
3. **Minimum password length** → `8`
4. **Password Requirements** → *Lowercase, uppercase, digits and symbols*
   (the closest built-in option to "a number and a special character")
5. **Save**

Until that is set, a password that fails our rule is still refused by the app
— it just would not also be refused if someone called the auth API directly.

---

## 2. Email — a hard gate

- The account is created and signed in immediately. The dashboard then sits
  behind `#verify-email-gate` until the confirmation link is clicked.
- **Resend** calls `sb.auth.resend({ type: 'signup' })` and disables itself
  for 30 seconds. A resend button that can be held down is a mail-bomb button.
- **"I've confirmed — continue"** calls `sb.auth.getUser()`, which re-reads
  from the server rather than the cached session — the session in that tab
  predates the click, so nothing else would notice.
- `vgEmailVerified()` passes on **either** `auth.users.email_confirmed_at`
  **or** `agents.email_verified_at`. Supabase's own flag is the authority for
  a new signup; the column is the grandfather override, so switching email
  confirmation on in the dashboard later cannot lock out an account that
  predates the setting.
- `agents.email_verified_at` is **not a mirror** and must not become one.
  Nothing writes it but the migration and the service role.

---

## 3. Phone — a soft gate

The app works; **calling and texting** are locked until a 6-digit SMS code is
entered. Same shape as the tier-upgrade gate, so the pattern is familiar.

- **`vgRequirePhone()` is the single question** every entry point asks:
  `softphone.dial`, `softphone.dialNumber`, the Power Dialer, Preview Dial and
  the SMS thread. It is advisory — `phone-verify` re-checks server-side.
- **A banner, not a hidden button.** `vgRenderLocks()` paints a lock strip on
  the Web Dialer, Leads, AI dialer and Messaging screens. Removing the Power
  Dial button would leave an agent hunting for something they were sold.
- **An unreadable state never paints a lock.** `_vgState.loaded` is false when
  the read failed; an agent who cannot reach the server is already having a
  bad time and a gate they cannot clear is the wrong thing to add.

### The code

`supabase/functions/phone-verify` — actions `send`, `check`, `status`. The
agent comes **from the JWT**; there is no agent id in any body.

- **A HASH and never the code.** `sha256(code + ':' + row.id)`, hex. The salt
  is the row's own id, so two agents issued the same code get different
  digests and a stolen table cannot be attacked with one precomputed set of a
  million hashes. Not bcrypt: the secret lives ten minutes and allows five
  guesses, and a deliberately slow hash would add latency to every signup for
  no gain.
- **Three bounds, all server-side:** ~10 minutes, 5 wrong guesses, 45 seconds
  between sends.
- **Used / expired / exhausted is decided BEFORE the hash is compared**, so a
  dead code cannot be told apart from a wrong one by response timing.
  `codeUsable(row, nowMs)` does not even take the typed code.
- **A malformed code does not burn an attempt.** Five typos should not cost a
  code.
- **The code is consumed BEFORE the grant.** If the grant fails the agent
  retries with a fresh code, which is recoverable; a `consumed_at` that never
  got written is a replayable code, which is not.
- **A send Telnyx rejected retires its row**, so the cooldown is not spent
  guarding a code nobody can read.
- **`phone_verifications` is SELECT-only.** A client that can bump `attempts`
  or move `expires_at` can brute-force six digits at leisure. Do not add an
  INSERT or UPDATE policy.
- **`agents_protect_verification_columns`** refuses a client write to either
  verified column, with **no admin exemption** — "an administrator marked this
  phone verified" is not a verification.

### 🔴 Owner action — the sending number

`PLATFORM_SMS_FROM` is set to **`+12029981783`**.

Of the nine DIDs on this Telnyx account, that is the **only** one attached to
a messaging profile ("Jarvis"). Verified by probe on 2026-07-31: sending from
`+12029703699` (the shared caller ID) returns **400 / code 40305, "Invalid
'from' address"** — Telnyx refuses it *before* queuing, so a wrong number here
means every code silently fails to send.

**It has no 10DLC campaign** (`messaging_campaign_id` is null), so US carriers
may filter A2P traffic from it. A send Telnyx accepts can still be dropped
downstream. To make delivery dependable, attach `+12029981783` to an approved
campaign in the Telnyx portal (Messaging → Programs/Campaigns), or point
`PLATFORM_SMS_FROM` at a number that already is.

Until then this is contained, not dangerous:

- every existing account is grandfathered and never sees the gate;
- the phone gate is **soft** — "Not now, I'll do this later" closes it and the
  app stays fully usable, only calling and texting are locked;
- a failed send says so plainly instead of pretending a code went out.
