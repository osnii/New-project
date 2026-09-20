import "dotenv/config";

import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

import { readRows, appendRow, updateRowWhere } from "./lib/sheetsClient.js";
import { PLANS, verifyTransaction, isValidWebhookSignature } from "./lib/paystack.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5000;

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
    const verification = await verifyTransaction(reference);

    if (!verification.status || verification.data.status !== "success") {
      return res.json({ success: false, error: "Payment not verified" });
    }

    const startDate = new Date();
    const renewalDate = new Date(startDate);
    renewalDate.setMonth(renewalDate.getMonth() + 1);

    await appendRow("Members", {
      MemberID: reference,
      Name: name,
      Email: email,
      Phone: phone || "",
      Role: role === "contractor" ? "contractor" : "customer",
      BusinessName: businessName || "",
      Plan: plan,
      AmountPaid: verification.data.amount / 100,
      StartDate: startDate.toISOString().split("T")[0],
      RenewalDate: renewalDate.toISOString().split("T")[0],
      Status: "Active",
      PaystackReference: reference,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Error verifying payment:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: "Verification failed" });
  }
});

// Paystack webhook needs the raw body to check the signature, so it gets its own
// body parser instead of the shared express.json() used elsewhere.
app.post(
  "/api/paystack/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["x-paystack-signature"];
    if (!signature || !isValidWebhookSignature(req.body, signature)) {
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
