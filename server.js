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
import { sendSubscriptionConfirmation } from "./lib/email.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5000;

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
    plans: Object.fromEntries(
      Object.entries(PLANS).map(([key, p]) => [
        key,
        { name: p.name, amountNaira: p.amountNaira, code: p.code },
      ])
    ),
  });
});

async function memberExistsWithReference(reference) {
  const members = await readRows("Members");
  return members.some((m) => m.PaymentReference === reference);
}

function buildMemberRow({ reference, provider, name, email, phone, role, businessName, plan, amountPaid }) {
  const startDate = new Date();
  const renewalDate = new Date(startDate);
  renewalDate.setMonth(renewalDate.getMonth() + 1);
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
  };

  return { row, renewalDate: renewalDateStr };
}

// Email failures shouldn't fail a payment that already succeeded and is
// already recorded — log and move on.
async function notifyNewMember({ email, name, plan, provider, renewalDate }) {
  try {
    await sendSubscriptionConfirmation({ to: email, name, plan, provider, renewalDate });
  } catch (err) {
    console.error("Error sending confirmation email:", err.message);
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
    const [products, members] = await Promise.all([
      readRows("Products"),
      email ? readRows("Members") : Promise.resolve([]),
    ]);

    const isActiveMember = email
      ? members.some(
          (m) =>
            (m.Email || "").toLowerCase() === String(email).toLowerCase() &&
            (m.Status || "").toLowerCase() === "active"
        )
      : false;

    const brandProducts = products
      .filter(
        (p) =>
          (p.BrandSlug || "").toLowerCase() === slug.toLowerCase() &&
          (p.Active || "").toLowerCase() !== "false"
      )
      .map((p) => ({
        id: p.ProductID,
        name: p.Name,
        category: p.Category,
        imageUrl: p.ImageURL,
        description: p.Description,
        retailPrice: Number(p.RetailPrice) || 0,
        memberPrice: isActiveMember ? Number(p.MemberPrice) || 0 : null,
      }));

    res.json({ locked: !isActiveMember, products: brandProducts });
  } catch (err) {
    console.error("Error reading products:", err.message);
    res.status(500).json({ error: "Could not load products" });
  }
});

// ---- Subscription / membership ----

app.post("/api/subscribe/verify", express.json(), async (req, res) => {
  const { reference, name, email, phone, role, businessName, plan } = req.body;

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
    });
    await appendRow("Members", row);
    await notifyNewMember({ email, name, plan, provider: "Paystack", renewalDate });

    res.json({ success: true });
  } catch (err) {
    console.error("Error verifying payment:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: "Verification failed" });
  }
});

// ---- Squad: hosted checkout redirect flow ----

app.post("/api/subscribe/squad/initiate", express.json(), async (req, res) => {
  const { name, email, phone, role, businessName, plan } = req.body;

  if (!name || !email || !plan || !PLANS[plan]) {
    return res.status(400).json({ success: false, error: "Missing or invalid fields" });
  }

  const transactionRef = `SQ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  pendingSquadSignups.set(transactionRef, { name, email, phone, role, businessName, plan });

  try {
    const callbackUrl = `${req.protocol}://${req.get("host")}/squad-callback.html?transaction_ref=${transactionRef}`;
    const result = await initiateSquadTransaction({
      email,
      amountNaira: PLANS[plan].amountNaira,
      transactionRef,
      callbackUrl,
      metadata: { name, phone, role, businessName, plan },
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
      const pendingEmail = pendingSquadSignups.get(ref)?.email;
      pendingSquadSignups.delete(ref);
      return res.json({ success: true, email: pendingEmail || null });
    }

    const verification = await verifySquadTransaction(ref);
    const data = verification.data;

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
    });
    await appendRow("Members", row);
    await notifyNewMember({ email: data.email, name: memberName, plan: planKey, provider: "Squad", renewalDate });

    pendingSquadSignups.delete(ref);
    res.json({ success: true, email: data.email });
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
        });
        await appendRow("Members", row);
        await notifyNewMember({ email: body.email, name: memberName, plan: planKey, provider: "Squad", renewalDate });
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
    });
  } catch (err) {
    console.error("Error reading account:", err.message);
    res.status(500).json({ error: "Could not load account" });
  }
});

app.listen(PORT, () => {
  console.log(`PriceEdge MVP server running on http://localhost:${PORT}`);
});
