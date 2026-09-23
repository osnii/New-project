# PriceEdge — Subscription Brand Marketplace (MVP)

Customers, contractors, and wholesale distributors subscribe to a monthly plan,
then pick a brand (Samsung, LG, Sony, ...) and buy that brand's products at
member-only wholesale pricing. This is a deliberately simple MVP: no real
database, no password auth — just enough to validate the idea.

## How it works

- **Catalog & members live in a Google Sheet.** One spreadsheet, three tabs:
  `Brands`, `Products`, `Members`. Add/edit brands and products by editing the
  sheet directly; the `Members` tab fills up automatically as people subscribe.
- **Two payment options at checkout: Paystack or Squad.** Three plan tiers
  (Basic/Pro/Elite), each with a monthly and an annual price (annual is 10x
  monthly — 2 months free, an untested starting guess, not settled pricing)
  either way. They work differently under the hood:
  - **Paystack** auto-bills the member's card every month on its own (its
    "Plan" feature) — no extra work from us after signup.
  - **Squad has no equivalent auto-billing plan.** Checkout is a one-off
    hosted-page payment (full-page redirect, since Squad has no inline JS
    widget like Paystack's). A Squad member's subscription does **not**
    renew itself — when `RenewalDate` passes, they need to be prompted to
    pay again through the same flow. (Squad does support card tokenization
    + an on-demand `charge_card` call, which could power real auto-renewal
    later — not built here to keep the MVP scope small.)
  Either path verifies the payment server-side, appends a row to `Members`
  with which `PaymentProvider` was used, and emails the member a
  confirmation.
- **Access is gated by email**, not a password. A visitor who subscribed (or
  who looks up their email on `/account.html`) has their email saved in
  `localStorage`; the brand pages send that email to the API, which checks the
  `Members` tab for an `Active` row before revealing member pricing. This is
  intentionally weak (anyone who knows a member's email can view their
  pricing) — good enough to demo the model, not to launch publicly. Swap in
  real auth (magic link or OTP) before going live.

## Google Sheet setup

Create a blank Google Sheet, share it with your service account email
(Editor access), and copy its spreadsheet ID (the long string in its URL)
into `.env` as `GOOGLE_SHEET_ID`. You don't need to create tabs by hand —
`npm run seed` creates the `Brands`, `Products`, and `Members` tabs (with
correct headers) automatically if they don't already exist:

**Brands** (`Category` groups brands on the Brands page — e.g. "Electronics",
"Fashion & Apparel"; blank falls under "Other")
`BrandID | Name | Category | Slug | LogoURL | Description | Active`

**Products** (`Category` here is the product's category within its brand,
e.g. "Televisions" — unrelated to the brand's own Category above)
`ProductID | BrandSlug | Name | Category | RetailPrice | MemberPrice | BuyPrice | Supplier | GrossProfit | ImageURL | Description | Active | FreeAccess`

`BuyPrice`, `Supplier`, and `GrossProfit` are for your own cost/margin
tracking — the app never reads or exposes them; they're not part of the API
response. Fill them in as you lock down real supplier pricing. `FreeAccess`
(`TRUE`/`FALSE`) marks a small curated sample that no-payment "Free" members
(see `/api/subscribe/free`) can see at member pricing — everything else stays
locked for them to nudge the upgrade to a paid plan.

**Members** (the backend writes to this one as people subscribe)
`MemberID | Name | Email | Phone | Role | BusinessName | Plan | AmountPaid | StartDate | RenewalDate | Status | PaymentProvider | PaymentReference`

## Setup

1. `cp .env.example .env` and fill in:
   - Paystack public/secret keys and the six plan codes — monthly and annual
     for each tier (create the plans under Paystack Dashboard → Payments →
     Plans first).
   - `SQUAD_SECRET_KEY` (sandbox key from Squad Dashboard → Settings → API
     Keys) and, optionally, `SQUAD_BASE_URL` if you're going live.
   - `GOOGLE_SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`
     from a Google Cloud service account with the Sheets API enabled.
   - `SMTP_USER` (a Gmail address) and `SMTP_PASS` — not your normal Gmail
     password, a 16-character **App Password**. Turn on 2-Step Verification
     on that Google account first, then generate one at
     myaccount.google.com/apppasswords. Without this, subscriptions still
     work — the server just logs a warning and skips the email.
2. `npm install`
3. `npm run seed` — creates the sheet tabs if missing, then pushes sample
   brands/products in so you have something to click through immediately.
   Safe to re-run; it overwrites the `Brands`/`Products` tabs, never touches
   rows already in `Members`.
4. `npm run dev` (or `npm start`) — serves the site and API at
   `http://localhost:5000`.
5. (Optional, for renewals/cancellations) Point a Paystack webhook at
   `https://<your-host>/api/paystack/webhook`, and a Squad webhook at
   `https://<your-host>/api/squad/webhook`.

## What's intentionally missing (by design, for an MVP)

- No password login — email lookup only (see above).
- Squad signups in progress are tracked in an in-memory map (not the Sheet),
  so a server restart between "customer starts Squad checkout" and "customer
  is redirected back" loses that pending signup. If it happens, the customer
  paid but has no Members row — check the Squad dashboard and add them by hand.
- No automatic renewal billing for Squad members (see above) — Paystack
  members renew themselves; Squad members need a manual nudge each cycle.
- No differentiated pricing between customers and contractors yet — both are
  just a `Role` label on the same member record, at the same catalog and
  price. Split this once you know it matters.
- No inventory/checkout flow — a subscribed member sees the wholesale price;
  actually placing an order still happens off-platform (WhatsApp, phone,
  etc.) until that's worth building.
- No admin UI for managing brands/products — edit the Google Sheet directly.
- Confirmation emails send via plain Gmail SMTP — fine for testing, but
  expect Spam-folder placement (no custom domain, no SPF/DKIM/DMARC
  reputation) and a ~500/day sending cap. Before a real launch, switch to a
  transactional email service (Resend, SendGrid, Mailgun) on your own domain.
- Google Sheets as a database won't scale past a small catalog and low
  request volume, but it's fast to inspect and needs no server — right
  trade-off for validating demand before building a real backend.
