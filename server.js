import "dotenv/config";

import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

import { readRows, appendRow, updateRowWhere } from "./lib/sheetsClient.js";
import {
  PLANS,
  verifyTransaction as verifyPaystackTransaction,
  isValidWebhookSignature as isValidPaystackSignature,
} from "./lib/paystack.js";
import {
  initiateTransaction as initiateSquadTransaction,
  verifyTransaction as verifySquadTransaction,
  isValidWebhookSignature as isValidSquadSignature,
} from "./lib/squad.js";
import {
  sendSubscriptionConfirmation,
  sendContractorLeadConfirmation,
  notifyAdminOfContractorLead,
  notifyReferralReward,
  sendGroupBuySuccessEmail,
} from "./lib/email.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5000;
const REFERRAL_REWARD_NAIRA = Number(process.env.REFERRAL_REWARD_NAIRA) || 500;
const PRICE_LOCK_DAYS = Number(process.env.PRICE_LOCK_DAYS) || 14;

// Squad has no client-side checkout widget: the frontend redirects the
// browser to a hosted page and Squad redirects back to our callback with a
// transaction_ref. We stash the signup form details here between those two
// requests. In-memory, so it's lost on server restart — acceptable for an
// MVP, but a real deploy should move this to the Sheet or a real store.
const pendingSquadSignups = new Map();

app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// Config the frontend needs (public key only, never the secret key)
app.get("/api/config", (req, res) => {
  res.json({
    paystackPublicKey: process.env.PAYSTACK_PUBLIC_KEY,
    priceLockDays: PRICE_LOCK_DAYS,
    plans: Object.fromEntries(
      Object.entries(PLANS).map(([key, p]) => [
        key,
        { name: p.name, amountNaira: p.amountNaira, period: p.period || "month", code: p.code },
      ])
    ),
  });
});

// Funnel instrumentation: fire-and-forget, never blocks or fails the caller.
app.post("/api/track", express.json(), async (req, res) => {
  const { event, email, plan, brandSlug, provider, detail } = req.body || {};
  res.sendStatus(204);

  try {
    await appendRow("Events", {
      Timestamp: new Date().toISOString(),
      Event: event || "",
      Email: email || "",
      Plan: plan || "",
      BrandSlug: brandSlug || "",
      Provider: provider || "",
      Detail: detail || "",
    });
  } catch (err) {
    console.error("Error logging event:", err.message);
  }
});

async function memberExistsWithReference(reference) {
  const members = await readRows("Members");
  return members.some((m) => m.PaymentReference === reference);
}

// Free-tier members only get member pricing on products flagged
// FreeAccess=TRUE (a curated sample) — everything else stays locked to
// nudge the upgrade. Paid members unlock the whole catalog.
function computeMemberAccess(email, members) {
  const activeMember = email
    ? members.find(
        (m) =>
          (m.Email || "").toLowerCase() === String(email).toLowerCase() &&
          (m.Status || "").toLowerCase() === "active"
      )
    : null;

  return {
    activeMember,
    isPaidMember: !!activeMember && activeMember.Plan !== "free",
    isFreeMember: !!activeMember && activeMember.Plan === "free",
  };
}

function buildMemberRow({ reference, provider, name, email, phone, role, businessName, plan, amountPaid, referredBy }) {
  const startDate = new Date();
  const renewalDate = new Date(startDate);
  if (PLANS[plan]?.period === "year") {
    renewalDate.setFullYear(renewalDate.getFullYear() + 1);
  } else {
    renewalDate.setMonth(renewalDate.getMonth() + 1);
  }
  const renewalDateStr = renewalDate.toISOString().split("T")[0];

  const row = {
    MemberID: reference,
    Name: name,
    Email: email,
    Phone: phone || "",
    Role: role === "contractor" ? "contractor" : "customer",
    BusinessName: businessName || "",
    Plan: plan,
    AmountPaid: amountPaid,
    StartDate: startDate.toISOString().split("T")[0],
    RenewalDate: renewalDateStr,
    Status: "Active",
    PaymentProvider: provider,
    PaymentReference: reference,
    ReferredBy: referredBy || "",
  };

  return { row, renewalDate: renewalDateStr };
}

// Email failures shouldn't fail a payment that already succeeded and is
// already recorded — log and move on.
async function notifyNewMember({ email, name, plan, provider, renewalDate }) {
  try {
    console.log(`Sending confirmation email to ${email} via ${provider}...`);
    await sendSubscriptionConfirmation({ to: email, name, plan, provider, renewalDate });
    console.log(`Confirmation email sent to ${email}.`);
  } catch (err) {
    console.error("Error sending confirmation email:", err.message);
  }
}

// Rewards an existing member when someone they referred completes a paid
// signup. Only fires on an unambiguous match — `referredBy` must be the
// referrer's exact member email, since a plain name typed into that field
// can't be safely auto-matched — and only paid signups count, so a free
// account can't be farmed for credit. Credits are a running ledger only;
// there's no wallet/discount-code system, so they're redeemed manually
// against an order like everything else in this MVP.
async function creditReferralReward({ referredBy, newMemberEmail, amountPaid }) {
  if (!referredBy || !amountPaid || !referredBy.includes("@")) return;
  if (referredBy.toLowerCase() === newMemberEmail.toLowerCase()) return;

  try {
    const members = await readRows("Members");
    const referrer = members.find(
      (m) =>
        (m.Email || "").toLowerCase() === referredBy.toLowerCase() &&
        (m.Status || "").toLowerCase() === "active"
    );
    if (!referrer) return;

    const newCount = (Number(referrer.ReferralCount) || 0) + 1;
    const newCredits = (Number(referrer.ReferralCredits) || 0) + REFERRAL_REWARD_NAIRA;

    await updateRowWhere(
      "Members",
      (m) => (m.Email || "").toLowerCase() === referredBy.toLowerCase(),
      { ReferralCount: newCount, ReferralCredits: newCredits }
    );

    notifyReferralReward({
      to: referrer.Email,
      name: referrer.Name,
      rewardAmount: REFERRAL_REWARD_NAIRA,
      totalCredits: newCredits,
    }); // fire-and-forget
  } catch (err) {
    console.error("Error crediting referral reward:", err.message);
  }
}

// ---- Brands & products (Google Sheets as the catalog) ----

app.get("/api/brands", async (req, res) => {
  try {
    const brands = await readRows("Brands");
    const active = brands.filter((b) => (b.Active || "").toLowerCase() !== "false");
    res.json(active);
  } catch (err) {
    console.error("Error reading brands:", err.message);
    res.status(500).json({ error: "Could not load brands" });
  }
});

app.get("/api/brands/:slug/products", async (req, res) => {
  const { slug } = req.params;
  const { email } = req.query;

  try {
    const [products, members, priceLocks] = await Promise.all([
      readRows("Products"),
      email ? readRows("Members") : Promise.resolve([]),
      email ? readRows("PriceLocks") : Promise.resolve([]),
    ]);

    const { isPaidMember, isFreeMember } = computeMemberAccess(email, members);

    // Active, unexpired locks this visitor holds, keyed by product — used
    // below to floor their price at what they locked in even if it's since
    // gone up (see POST /api/price-lock).
    const now = new Date();
    const activeLocksByProduct = new Map();
    if (email) {
      priceLocks
        .filter(
          (l) =>
            (l.Email || "").toLowerCase() === String(email).toLowerCase() &&
            (l.Status || "").toLowerCase() === "active" &&
            new Date(l.ExpiresAt) >= now
        )
        .forEach((l) => activeLocksByProduct.set(l.ProductID, l));
    }

    const brandProducts = products
      .filter(
        (p) =>
          (p.BrandSlug || "").toLowerCase() === slug.toLowerCase() &&
          (p.Active || "").toLowerCase() !== "false"
      )
      .map((p) => {
        const isFreeSample = (p.FreeAccess || "").toLowerCase() === "true";
        const unlocked = isPaidMember || (isFreeMember && isFreeSample);
        const retailPrice = Number(p.RetailPrice) || 0;
        const memberPrice = Number(p.MemberPrice) || 0;

        // Shown to everyone (even locked out) as a conversion hook, but
        // bucketed to the nearest 5% rather than exact — the retail price is
        // already public, so an exact percentage would let anyone back out
        // the precise member price without signing up.
        const savingsPercent =
          retailPrice > 0 && memberPrice > 0 && memberPrice < retailPrice
            ? Math.round((1 - memberPrice / retailPrice) * 20) * 5
            : null;

        const lock = unlocked ? activeLocksByProduct.get(p.ProductID) : null;
        const effectivePrice = lock ? Math.min(Number(lock.LockedPrice) || memberPrice, memberPrice) : memberPrice;

        return {
          id: p.ProductID,
          name: p.Name,
          category: p.Category,
          imageUrl: p.ImageURL,
          description: p.Description,
          retailPrice,
          memberPrice: unlocked ? effectivePrice : null,
          savingsPercent,
          priceLockExpiresAt: lock ? lock.ExpiresAt : null,
        };
      });

    res.json({ locked: !isPaidMember, products: brandProducts });
  } catch (err) {
    console.error("Error reading products:", err.message);
    res.status(500).json({ error: "Could not load products" });
  }
});

// ---- Subscription / membership ----

app.post("/api/subscribe/verify", express.json(), async (req, res) => {
  const { reference, name, email, phone, role, businessName, plan, referredBy } = req.body;

  if (!reference || !name || !email || !plan || !PLANS[plan]) {
    return res.status(400).json({ success: false, error: "Missing or invalid fields" });
  }

  try {
    if (await memberExistsWithReference(reference)) {
      return res.json({ success: true });
    }

    const verification = await verifyPaystackTransaction(reference);

    if (!verification.status || verification.data.status !== "success") {
      return res.json({ success: false, error: "Payment not verified" });
    }

    const { row, renewalDate } = buildMemberRow({
      reference,
      provider: "paystack",
      name,
      email,
      phone,
      role,
      businessName,
      plan,
      amountPaid: verification.data.amount / 100,
      referredBy,
    });
    await appendRow("Members", row);
    notifyNewMember({ email, name, plan, provider: "Paystack", renewalDate }); // fire-and-forget: SMTP shouldn't block a paid response
    creditReferralReward({ referredBy, newMemberEmail: email, amountPaid: verification.data.amount / 100 }); // fire-and-forget

    res.json({ success: true });
  } catch (err) {
    console.error("Error verifying payment:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: "Verification failed" });
  }
});

// No payment: just captures the lead and unlocks the small FreeAccess=TRUE
// sample of products. Idempotent on email — re-signing up with the same
// email that's already an active member (free or paid) is a no-op success
// rather than a duplicate row.
app.post("/api/subscribe/free", express.json(), async (req, res) => {
  const { name, email, phone, role, businessName, referredBy } = req.body;

  if (!name || !email) {
    return res.status(400).json({ success: false, error: "Name and email are required" });
  }

  try {
    const members = await readRows("Members");
    const alreadyActive = members.some(
      (m) =>
        (m.Email || "").toLowerCase() === email.toLowerCase() &&
        (m.Status || "").toLowerCase() === "active"
    );

    if (alreadyActive) {
      return res.json({ success: true });
    }

    const reference = `FREE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { row, renewalDate } = buildMemberRow({
      reference,
      provider: "free",
      name,
      email,
      phone,
      role,
      businessName,
      plan: "free",
      amountPaid: 0,
      referredBy,
    });
    await appendRow("Members", row);
    notifyNewMember({ email, name, plan: "free", provider: "Free", renewalDate }); // fire-and-forget

    res.json({ success: true });
  } catch (err) {
    console.error("Error creating free signup:", err.message);
    res.status(500).json({ success: false, error: "Could not complete signup" });
  }
});

// ---- Squad: hosted checkout redirect flow ----

app.post("/api/subscribe/squad/initiate", express.json(), async (req, res) => {
  const { name, email, phone, role, businessName, plan, referredBy } = req.body;

  if (!name || !email || !plan || !PLANS[plan]) {
    return res.status(400).json({ success: false, error: "Missing or invalid fields" });
  }

  const transactionRef = `SQ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  pendingSquadSignups.set(transactionRef, { name, email, phone, role, businessName, plan, referredBy });

  try {
    const callbackUrl = `${req.protocol}://${req.get("host")}/squad-callback.html?transaction_ref=${transactionRef}`;
    const result = await initiateSquadTransaction({
      email,
      amountNaira: PLANS[plan].amountNaira,
      transactionRef,
      callbackUrl,
      metadata: { name, phone, role, businessName, plan, referredBy },
    });

    res.json({ success: true, checkoutUrl: result.data.checkout_url });
  } catch (err) {
    pendingSquadSignups.delete(transactionRef);
    console.error("Error initiating Squad payment:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: "Could not start payment" });
  }
});

app.get("/api/subscribe/squad/verify", async (req, res) => {
  const { ref } = req.query;
  if (!ref) return res.status(400).json({ success: false, error: "Missing reference" });

  try {
    if (await memberExistsWithReference(ref)) {
      console.log(`Squad verify: ${ref} already recorded, skipping (no duplicate email sent).`);
      const pendingEmail = pendingSquadSignups.get(ref)?.email;
      pendingSquadSignups.delete(ref);
      return res.json({ success: true, email: pendingEmail || null });
    }

    console.log(`Squad verify: checking ${ref} with Squad...`);
    const verification = await verifySquadTransaction(ref);
    const data = verification.data;
    console.log(`Squad verify: transaction_status=${data.transaction_status}, email=${data.email}`);

    if (!verification.success || data.transaction_status?.toLowerCase() !== "success") {
      return res.json({ success: false, error: "Payment not verified" });
    }

    // Squad echoes back our initiate-time metadata on every verify call, which
    // survives a server restart — more reliable than the in-memory pending map.
    const meta = data.meta || {};
    const pending = pendingSquadSignups.get(ref);
    const planKey = meta.plan || pending?.plan || Object.keys(PLANS).find(
      (key) => Math.round(PLANS[key].amountNaira * 100) === data.transaction_amount
    );

    const memberName = meta.name || pending?.name || data.email;
    const { row, renewalDate } = buildMemberRow({
      reference: ref,
      provider: "squad",
      name: memberName,
      email: data.email,
      phone: meta.phone || pending?.phone,
      role: meta.role || pending?.role,
      businessName: meta.businessName || pending?.businessName,
      plan: planKey || "unknown",
      amountPaid: data.transaction_amount / 100,
      referredBy: meta.referredBy || pending?.referredBy,
    });
    await appendRow("Members", row);
    notifyNewMember({ email: data.email, name: memberName, plan: planKey, provider: "Squad", renewalDate }); // fire-and-forget
    creditReferralReward({
      referredBy: meta.referredBy || pending?.referredBy,
      newMemberEmail: data.email,
      amountPaid: data.transaction_amount / 100,
    }); // fire-and-forget

    pendingSquadSignups.delete(ref);
    res.json({ success: true, email: data.email, plan: planKey });
  } catch (err) {
    console.error("Error verifying Squad payment:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: "Verification failed" });
  }
});

// Backup path in case the customer never makes it back to squad-callback.html
// (closed the tab, connection dropped, etc.) — /api/subscribe/squad/verify
// above is still the primary path since it's what tells the browser "you're
// in". Both check memberExistsWithReference first, so whichever fires second
// is a no-op.
app.post("/api/squad/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const signature = req.headers["x-squad-encrypted-body"];
  if (!signature || !isValidSquadSignature(req.body, signature)) {
    return res.status(401).send("Invalid signature");
  }

  const event = JSON.parse(req.body.toString("utf8"));

  try {
    if (event.Event === "charge_successful" && event.Body?.transaction_status?.toLowerCase() === "success") {
      const body = event.Body;
      const ref = body.transaction_ref;

      if (!(await memberExistsWithReference(ref))) {
        const meta = body.meta || {};
        const pending = pendingSquadSignups.get(ref);
        const planKey = meta.plan || pending?.plan || Object.keys(PLANS).find(
          (key) => Math.round(PLANS[key].amountNaira * 100) === body.amount
        );

        const memberName = meta.name || pending?.name || body.email;
        const { row, renewalDate } = buildMemberRow({
          reference: ref,
          provider: "squad",
          name: memberName,
          email: body.email,
          phone: meta.phone || pending?.phone,
          role: meta.role || pending?.role,
          businessName: meta.businessName || pending?.businessName,
          plan: planKey || "unknown",
          amountPaid: body.amount / 100,
          referredBy: meta.referredBy || pending?.referredBy,
        });
        await appendRow("Members", row);
        notifyNewMember({ email: body.email, name: memberName, plan: planKey, provider: "Squad", renewalDate }); // fire-and-forget
        creditReferralReward({
          referredBy: meta.referredBy || pending?.referredBy,
          newMemberEmail: body.email,
          amountPaid: body.amount / 100,
        }); // fire-and-forget
        pendingSquadSignups.delete(ref);
      }
    }
  } catch (err) {
    console.error("Error handling Squad webhook event:", err.message);
  }

  res.sendStatus(200);
});

// Paystack webhook needs the raw body to check the signature, so it gets its own
// body parser instead of the shared express.json() used elsewhere.
app.post(
  "/api/paystack/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["x-paystack-signature"];
    if (!signature || !isValidPaystackSignature(req.body, signature)) {
      return res.status(401).send("Invalid signature");
    }

    const event = JSON.parse(req.body.toString("utf8"));

    try {
      if (event.event === "subscription.disable" || event.event === "subscription.not_renew") {
        const email = event.data?.customer?.email;
        if (email) {
          await updateRowWhere(
            "Members",
            (m) => (m.Email || "").toLowerCase() === email.toLowerCase(),
            { Status: "Cancelled" }
          );
        }
      }
    } catch (err) {
      console.error("Error handling webhook event:", err.message);
    }

    res.sendStatus(200);
  }
);

// Lets a currently-unlocked member freeze today's member price on a product
// for PRICE_LOCK_DAYS — protects them if the price rises before they order.
// One active lock per email+product; re-locking an already-locked product
// just returns the existing lock instead of resetting its expiry.
app.post("/api/price-lock", express.json(), async (req, res) => {
  const { email, productId } = req.body || {};
  if (!email || !productId) {
    return res.status(400).json({ success: false, error: "Email and productId are required" });
  }

  try {
    const [members, products, priceLocks] = await Promise.all([
      readRows("Members"),
      readRows("Products"),
      readRows("PriceLocks"),
    ]);

    const { isPaidMember, isFreeMember } = computeMemberAccess(email, members);
    const product = products.find((p) => p.ProductID === productId);
    if (!product) return res.status(404).json({ success: false, error: "Product not found" });

    const isFreeSample = (product.FreeAccess || "").toLowerCase() === "true";
    const unlocked = isPaidMember || (isFreeMember && isFreeSample);
    if (!unlocked) {
      return res
        .status(403)
        .json({ success: false, error: "Subscribe to unlock this product's price before locking it" });
    }

    const now = new Date();
    const existing = priceLocks.find(
      (l) =>
        (l.Email || "").toLowerCase() === email.toLowerCase() &&
        l.ProductID === productId &&
        (l.Status || "").toLowerCase() === "active" &&
        new Date(l.ExpiresAt) >= now
    );
    if (existing) {
      return res.json({ success: true, lockedPrice: Number(existing.LockedPrice), expiresAt: existing.ExpiresAt });
    }

    const expiresAt = new Date(now);
    expiresAt.setDate(expiresAt.getDate() + PRICE_LOCK_DAYS);
    const expiresAtStr = expiresAt.toISOString().split("T")[0];
    const lockedPrice = Number(product.MemberPrice) || 0;

    await appendRow("PriceLocks", {
      LockID: `LOCK-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      Email: email,
      ProductID: productId,
      BrandSlug: product.BrandSlug || "",
      LockedPrice: lockedPrice,
      LockedAt: now.toISOString().split("T")[0],
      ExpiresAt: expiresAtStr,
      Status: "Active",
    });

    res.json({ success: true, lockedPrice, expiresAt: expiresAtStr });
  } catch (err) {
    console.error("Error locking price:", err.message);
    res.status(500).json({ success: false, error: "Could not lock this price" });
  }
});

app.get("/api/account", async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: "Email is required" });

  try {
    const members = await readRows("Members");
    const member = members.find(
      (m) => (m.Email || "").toLowerCase() === String(email).toLowerCase()
    );

    if (!member) return res.status(404).json({ error: "No member found for that email" });

    res.json({
      name: member.Name,
      email: member.Email,
      role: member.Role,
      businessName: member.BusinessName,
      plan: member.Plan,
      status: member.Status,
      startDate: member.StartDate,
      renewalDate: member.RenewalDate,
      referralCount: Number(member.ReferralCount) || 0,
      referralCredits: Number(member.ReferralCredits) || 0,
    });
  } catch (err) {
    console.error("Error reading account:", err.message);
    res.status(500).json({ error: "Could not load account" });
  }
});

// ---- Contractor / wholesale distributor leads (no payment, no plan) ----

app.post("/api/contractor-lead", express.json(), async (req, res) => {
  const { name, email, phone, businessName, message } = req.body;

  if (!name || !email) {
    return res.status(400).json({ success: false, error: "Name and email are required" });
  }

  try {
    await appendRow("ContractorLeads", {
      Timestamp: new Date().toISOString(),
      Name: name,
      Email: email,
      Phone: phone || "",
      BusinessName: businessName || "",
      Message: message || "",
      Status: "New",
    });

    res.json({ success: true });

    // Fire-and-forget — the lead is already recorded either way.
    sendContractorLeadConfirmation({ to: email, name });
    notifyAdminOfContractorLead({ name, email, phone, businessName, message });
  } catch (err) {
    console.error("Error recording contractor lead:", err.message);
    res.status(500).json({ success: false, error: "Could not submit request" });
  }
});

// ---- Brand requests (demand signal for what to add next) ----

// Dedupes by brand name (case-insensitive): a repeat request just bumps
// RequestCount instead of creating a new row, so the sheet doubles as a
// ranked demand list. A repeat request from the same email doesn't double
// count, but a first-time email on an existing brand still increments it.
app.post("/api/brand-request", express.json(), async (req, res) => {
  const { brandName, email } = req.body || {};
  const name = (brandName || "").trim();

  if (!name) {
    return res.status(400).json({ success: false, error: "Brand name is required" });
  }

  try {
    const requests = await readRows("BrandRequests");
    const existing = requests.find((r) => (r.BrandName || "").toLowerCase() === name.toLowerCase());
    const today = new Date().toISOString().split("T")[0];
    const normalizedEmail = (email || "").trim().toLowerCase();

    if (existing) {
      const emails = (existing.RequesterEmails || "")
        .split(",")
        .map((e) => e.trim())
        .filter(Boolean);
      const alreadyRequested = normalizedEmail && emails.includes(normalizedEmail);

      if (!alreadyRequested) {
        if (normalizedEmail) emails.push(normalizedEmail);
        await updateRowWhere(
          "BrandRequests",
          (r) => (r.BrandName || "").toLowerCase() === name.toLowerCase(),
          {
            RequestCount: (Number(existing.RequestCount) || 0) + 1,
            RequesterEmails: emails.join(", "),
            LastRequestedAt: today,
          }
        );
      }
    } else {
      await appendRow("BrandRequests", {
        BrandName: name,
        RequestCount: 1,
        RequesterEmails: normalizedEmail || "",
        FirstRequestedAt: today,
        LastRequestedAt: today,
        Status: "New",
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Error recording brand request:", err.message);
    res.status(500).json({ success: false, error: "Could not submit request" });
  }
});

// ---- Group buys (demand-aggregation: pledge interest, no payment yet) ----
//
// You create a group buy by hand in the GroupBuys sheet tab (which product,
// target headcount, group price, deadline). Visitors pledge a quantity with
// just an email — no subscription required, since the point is reading real
// demand before committing to buy stock. Nothing is charged here; once
// enough people join, pledgers get an email and you close the sale
// off-platform, same as every other order in this MVP.

function sumPledgedQty(pledges, groupBuyId) {
  return pledges
    .filter((p) => p.GroupBuyID === groupBuyId)
    .reduce((sum, p) => sum + (Number(p.Quantity) || 1), 0);
}

app.get("/api/group-buys", async (req, res) => {
  try {
    const [groupBuys, products, pledges] = await Promise.all([
      readRows("GroupBuys"),
      readRows("Products"),
      readRows("GroupBuyPledges"),
    ]);

    const today = new Date().toISOString().split("T")[0];
    const deals = groupBuys
      .filter((g) => (g.Status || "").toLowerCase() !== "cancelled")
      .map((g) => {
        const product = products.find((p) => p.ProductID === g.ProductID);
        const targetQty = Number(g.TargetQty) || 0;
        const pledgedQty = sumPledgedQty(pledges, g.GroupBuyID);
        const isSuccessful = (g.Status || "").toLowerCase() === "successful" || pledgedQty >= targetQty;

        return {
          id: g.GroupBuyID,
          productName: product?.Name || g.ProductID,
          brandSlug: product?.BrandSlug || g.BrandSlug || "",
          imageUrl: product?.ImageURL || "",
          retailPrice: Number(product?.RetailPrice) || 0,
          groupPrice: Number(g.GroupPrice) || 0,
          targetQty,
          pledgedQty,
          deadline: g.Deadline || "",
          expired: !isSuccessful && g.Deadline && g.Deadline < today,
          successful: isSuccessful,
        };
      });

    res.json(deals);
  } catch (err) {
    console.error("Error reading group buys:", err.message);
    res.status(500).json({ error: "Could not load group buys" });
  }
});

app.post("/api/group-buys/:id/pledge", express.json(), async (req, res) => {
  const { id } = req.params;
  const { name, email, quantity } = req.body || {};

  if (!name || !email) {
    return res.status(400).json({ success: false, error: "Name and email are required" });
  }

  try {
    const [groupBuys, products, pledges] = await Promise.all([
      readRows("GroupBuys"),
      readRows("Products"),
      readRows("GroupBuyPledges"),
    ]);

    const groupBuy = groupBuys.find((g) => g.GroupBuyID === id);
    if (!groupBuy) return res.status(404).json({ success: false, error: "Group buy not found" });

    const status = (groupBuy.Status || "").toLowerCase();
    const today = new Date().toISOString().split("T")[0];
    const alreadySuccessful = status === "successful" || sumPledgedQty(pledges, id) >= (Number(groupBuy.TargetQty) || 0);

    if (status === "cancelled") {
      return res.status(400).json({ success: false, error: "This group buy has been cancelled" });
    }
    if (!alreadySuccessful && groupBuy.Deadline && groupBuy.Deadline < today) {
      return res.status(400).json({ success: false, error: "This group buy's deadline has passed" });
    }

    const qty = Math.max(1, Number(quantity) || 1);
    await appendRow("GroupBuyPledges", {
      PledgeID: `GBP-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      GroupBuyID: id,
      Email: email,
      Name: name,
      Quantity: qty,
      PledgedAt: today,
    });

    const newTotal = sumPledgedQty(pledges, id) + qty;
    const targetQty = Number(groupBuy.TargetQty) || 0;
    const justUnlocked = !alreadySuccessful && newTotal >= targetQty;

    if (justUnlocked) {
      await updateRowWhere("GroupBuys", (g) => g.GroupBuyID === id, { Status: "Successful" });

      const product = products.find((p) => p.ProductID === groupBuy.ProductID);
      const productName = product?.Name || groupBuy.ProductID;
      const allPledgers = [...pledges.filter((p) => p.GroupBuyID === id), { Email: email, Name: name }];
      const seen = new Set();

      for (const pledger of allPledgers) {
        const pledgerEmail = (pledger.Email || "").toLowerCase();
        if (!pledgerEmail || seen.has(pledgerEmail)) continue;
        seen.add(pledgerEmail);
        sendGroupBuySuccessEmail({
          to: pledger.Email,
          name: pledger.Name,
          productName,
          groupPrice: Number(groupBuy.GroupPrice) || 0,
        }); // fire-and-forget
      }
    }

    res.json({ success: true, pledgedQty: newTotal, targetQty, unlocked: newTotal >= targetQty });
  } catch (err) {
    console.error("Error recording group buy pledge:", err.message);
    res.status(500).json({ success: false, error: "Could not join this group buy" });
  }
});

app.listen(PORT, () => {
  console.log(`PriceEdge MVP server running on http://localhost:${PORT}`);
});
