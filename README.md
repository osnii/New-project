# PriceEdge — Subscription Brand Marketplace (MVP)

Customers, contractors, and wholesale distributors subscribe to a monthly plan,
then pick a brand (Samsung, LG, Sony, ...) and buy that brand's products at
member-only wholesale pricing. This is a deliberately simple MVP: no real
database, no password auth — just enough to validate the idea.

## How it works

- **Catalog & members live in a Google Sheet.** One spreadsheet, three tabs:
  `Brands`, `Products`, `Members`. Add/edit brands and products by editing the
  sheet directly; the `Members` tab fills up automatically as people subscribe.
- **Paystack handles billing.** Three recurring plans (Basic/Pro/Elite). On
  successful payment the backend verifies it with Paystack and appends a row
  to `Members`.
- **Access is gated by email**, not a password. A visitor who subscribed (or
  who looks up their email on `/account.html`) has their email saved in
  `localStorage`; the brand pages send that email to the API, which checks the
  `Members` tab for an `Active` row before revealing member pricing. This is
  intentionally weak (anyone who knows a member's email can view their
  pricing) — good enough to demo the model, not to launch publicly. Swap in
  real auth (magic link or OTP) before going live.

## Google Sheet setup

Create one spreadsheet with three tabs and these header rows (order matters
for the seed script, but the app matches by column name so you can reorder):

**Brands**
`BrandID | Name | Slug | LogoURL | Description | Active`

**Products**
`ProductID | BrandSlug | Name | Category | RetailPrice | MemberPrice | ImageURL | Description | Active`

**Members** (the backend writes to this one — just create the header row)
`MemberID | Name | Email | Phone | Role | BusinessName | Plan | AmountPaid | StartDate | RenewalDate | Status | PaystackReference`

Share the spreadsheet with your Google service account email (Editor access),
then copy the spreadsheet ID (the long string in its URL) into `.env`.

## Setup

1. `cp .env.example .env` and fill in:
   - Paystack public/secret keys and the three plan codes (create the plans
     under Paystack Dashboard → Payments → Plans first).
   - `GOOGLE_SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`
     from a Google Cloud service account with the Sheets API enabled.
2. `npm install`
3. `npm run seed` — pushes sample brands/products into the sheet so you have
   something to click through immediately. Safe to re-run; it overwrites the
   `Brands`/`Products` tabs, not `Members`.
4. `npm run dev` (or `npm start`) — serves the site and API at
   `http://localhost:5000`.
5. (Optional, for renewals/cancellations) Point a Paystack webhook at
   `https://<your-host>/api/paystack/webhook`.

## What's intentionally missing (by design, for an MVP)

- No password login — email lookup only (see above).
- No differentiated pricing between customers and contractors yet — both are
  just a `Role` label on the same member record, at the same catalog and
  price. Split this once you know it matters.
- No inventory/checkout flow — a subscribed member sees the wholesale price;
  actually placing an order still happens off-platform (WhatsApp, phone,
  etc.) until that's worth building.
- No admin UI for managing brands/products — edit the Google Sheet directly.
- Google Sheets as a database won't scale past a small catalog and low
  request volume, but it's fast to inspect and needs no server — right
  trade-off for validating demand before building a real backend.
