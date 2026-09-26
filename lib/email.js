import nodemailer from "nodemailer";

const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    // Some networks (common on Windows) advertise a route to Gmail's IPv6
    // address that isn't actually usable, causing ECONNREFUSED even though
    // IPv4 works fine. Forcing IPv4 avoids that.
    family: 4,
    // Opt-in only: antivirus/corporate TLS-inspection software (Kaspersky,
    // Avast, ESET, etc.) intercepts HTTPS/TLS with its own certificate,
    // which Node doesn't trust by default ("self-signed certificate in
    // certificate chain"). Only set SMTP_ALLOW_SELF_SIGNED=true if you hit
    // that error and understand the tradeoff — it accepts the intercepting
    // software's certificate instead of Gmail's real one.
    tls: { rejectUnauthorized: process.env.SMTP_ALLOW_SELF_SIGNED !== "true" },
  });
  return transporter;
}

const PLAN_LABELS = { free: "Free", basic: "Basic" };

export async function sendSubscriptionConfirmation({ to, name, plan, provider, renewalDate }) {
  if (!SMTP_USER || !SMTP_PASS) {
    console.warn("SMTP_USER/SMTP_PASS not set — skipping confirmation email.");
    return;
  }

  const planLabel = PLAN_LABELS[plan] || plan;
  const siteUrl = process.env.APP_BASE_URL || "http://localhost:5000";
  const isFree = plan === "free";
  const paidVia = !isFree && provider ? ` (paid via ${provider})` : "";
  const statusLine = isFree
    ? `Your PriceEdge Free account is active — you now see member pricing on a curated sample of deals.`
    : `Your PriceEdge ${planLabel} membership is now active${paidVia}.`;
  const upgradeLine = isFree
    ? "Upgrade any time to unlock the full catalog at every brand."
    : `Your next renewal is ${renewalDate}.`;

  await getTransporter().sendMail({
    from: `PriceEdge <${SMTP_USER}>`,
    to,
    subject: isFree ? "Welcome to PriceEdge — your free access is live" : "Welcome to PriceEdge — your membership is active",
    text: [
      `Hi ${name || "there"},`,
      "",
      statusLine,
      upgradeLine,
      "",
      `Browse brands and see your pricing: ${siteUrl}/brands.html`,
      "",
      "— The PriceEdge Team",
    ].join("\n"),
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #0071e3;">Welcome to PriceEdge</h2>
        <p>Hi ${name || "there"},</p>
        <p>${statusLine}</p>
        <p>${upgradeLine}</p>
        <p><a href="${siteUrl}/brands.html" style="color: #0071e3;">Browse brands and see your pricing &rarr;</a></p>
        <p style="color: #86868b; font-size: 13px;">— The PriceEdge Team</p>
      </div>
    `,
  });
}

// Sent to the contractor/distributor who submitted the lead form.
export async function sendContractorLeadConfirmation({ to, name }) {
  if (!SMTP_USER || !SMTP_PASS) {
    console.warn("SMTP_USER/SMTP_PASS not set — skipping lead confirmation email.");
    return;
  }

  await getTransporter().sendMail({
    from: `PriceEdge <${SMTP_USER}>`,
    to,
    subject: "We got your request — PriceEdge Wholesale",
    text: [
      `Hi ${name || "there"},`,
      "",
      "Thanks for reaching out about wholesale/bulk pricing. Our team will",
      "contact you within 24 hours to discuss what you need and put together",
      "a quote.",
      "",
      "— The PriceEdge Team",
    ].join("\n"),
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #0071e3;">We got your request</h2>
        <p>Hi ${name || "there"},</p>
        <p>Thanks for reaching out about wholesale/bulk pricing. Our team will
        contact you within 24 hours to discuss what you need and put together
        a quote.</p>
        <p style="color: #86868b; font-size: 13px;">— The PriceEdge Team</p>
      </div>
    `,
  });
}

// The magic-link sign-in email for /account.html. Whoever can click this
// link proves they control that inbox — that's what /api/account now
// requires instead of just knowing (or guessing) a member's email.
export async function sendLoginLinkEmail({ to, name, link }) {
  if (!SMTP_USER || !SMTP_PASS) {
    console.warn("SMTP_USER/SMTP_PASS not set — skipping login link email.");
    return;
  }

  await getTransporter().sendMail({
    from: `PriceEdge <${SMTP_USER}>`,
    to,
    subject: "Your PriceEdge sign-in link",
    text: [
      `Hi ${name || "there"},`,
      "",
      "Use this link to sign in to your PriceEdge account:",
      link,
      "",
      "This link expires in 15 minutes. If you didn't request it, you can ignore this email.",
      "",
      "— The PriceEdge Team",
    ].join("\n"),
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #0071e3;">Sign in to PriceEdge</h2>
        <p>Hi ${name || "there"},</p>
        <p><a href="${link}" style="color: #0071e3;">Click here to sign in &rarr;</a></p>
        <p style="color: #86868b; font-size: 13px;">This link expires in 15 minutes. If you didn't request it, you can ignore this email.</p>
        <p style="color: #86868b; font-size: 13px;">— The PriceEdge Team</p>
      </div>
    `,
  });
}

// Sent to an existing member when someone they referred completes a paid
// signup. Credits are a running ledger only — redeemed manually against an
// order, since there's no wallet/discount-code system in this MVP.
export async function notifyReferralReward({ to, name, rewardAmount, totalCredits }) {
  if (!SMTP_USER || !SMTP_PASS) {
    console.warn("SMTP_USER/SMTP_PASS not set — skipping referral reward email.");
    return;
  }

  await getTransporter().sendMail({
    from: `PriceEdge <${SMTP_USER}>`,
    to,
    subject: "You earned a referral reward on PriceEdge",
    text: [
      `Hi ${name || "there"},`,
      "",
      `Someone you referred just joined PriceEdge — you've earned ₦${rewardAmount.toLocaleString()} in referral credit.`,
      `Your total referral credit is now ₦${totalCredits.toLocaleString()}.`,
      "",
      "Mention this next time you place an order and we'll apply it.",
      "",
      "— The PriceEdge Team",
    ].join("\n"),
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #0071e3;">You earned a referral reward</h2>
        <p>Hi ${name || "there"},</p>
        <p>Someone you referred just joined PriceEdge — you've earned <strong>₦${rewardAmount.toLocaleString()}</strong> in referral credit.</p>
        <p>Your total referral credit is now <strong>₦${totalCredits.toLocaleString()}</strong>.</p>
        <p>Mention this next time you place an order and we'll apply it.</p>
        <p style="color: #86868b; font-size: 13px;">— The PriceEdge Team</p>
      </div>
    `,
  });
}

// Sent to every pledger once a group buy hits its target headcount. Nothing
// has been paid yet — this just tells them the deal is on and to expect
// follow-up to actually collect payment and arrange delivery.
export async function sendGroupBuySuccessEmail({ to, name, productName, groupPrice }) {
  if (!SMTP_USER || !SMTP_PASS) {
    console.warn("SMTP_USER/SMTP_PASS not set — skipping group buy success email.");
    return;
  }

  await getTransporter().sendMail({
    from: `PriceEdge <${SMTP_USER}>`,
    to,
    subject: `It's on! Your group buy for ${productName} hit its target`,
    text: [
      `Hi ${name || "there"},`,
      "",
      `Enough people joined — the group buy for ${productName} at ₦${groupPrice.toLocaleString()} is confirmed.`,
      "We'll reach out on WhatsApp or phone shortly to arrange payment and delivery.",
      "",
      "— The PriceEdge Team",
    ].join("\n"),
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #0071e3;">It's on!</h2>
        <p>Hi ${name || "there"},</p>
        <p>Enough people joined — the group buy for <strong>${productName}</strong> at <strong>₦${groupPrice.toLocaleString()}</strong> is confirmed.</p>
        <p>We'll reach out on WhatsApp or phone shortly to arrange payment and delivery.</p>
        <p style="color: #86868b; font-size: 13px;">— The PriceEdge Team</p>
      </div>
    `,
  });
}

// Sent to the business inbox when a member requests a refund under the
// 48-hour first-membership guarantee. Eligibility (within 48 hours, no
// completed purchase) is verified by a human against RequestedAt/Members,
// not automatically — this is a notification, not an approval.
export async function notifyAdminOfRefundRequest({ email, reason, detail }) {
  if (!SMTP_USER || !SMTP_PASS) {
    console.warn("SMTP_USER/SMTP_PASS not set — skipping admin refund notification.");
    return;
  }

  await getTransporter().sendMail({
    from: `PriceEdge Refunds <${SMTP_USER}>`,
    to: SMTP_USER,
    subject: `Refund request: ${email}`,
    text: [
      `Email: ${email}`,
      `Reason: ${reason}`,
      "",
      "Details:",
      detail || "(none provided)",
      "",
      "Check RefundRequests sheet, verify against Members (within 48h of first payment, no completed purchase), then approve/reject there.",
    ].join("\n"),
  });
}

// Sent to the business inbox so a new lead doesn't just sit unseen in a sheet.
export async function notifyAdminOfContractorLead({ name, email, phone, businessName, message }) {
  if (!SMTP_USER || !SMTP_PASS) {
    console.warn("SMTP_USER/SMTP_PASS not set — skipping admin lead notification.");
    return;
  }

  await getTransporter().sendMail({
    from: `PriceEdge Leads <${SMTP_USER}>`,
    to: SMTP_USER,
    subject: `New wholesale lead: ${name}${businessName ? ` (${businessName})` : ""}`,
    text: [
      `Name: ${name}`,
      `Email: ${email}`,
      `Phone: ${phone || "—"}`,
      `Business: ${businessName || "—"}`,
      "",
      "Message:",
      message || "(none provided)",
    ].join("\n"),
  });
}
