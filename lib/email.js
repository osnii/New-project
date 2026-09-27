import axios from "axios";

// Switched from direct SMTP-AUTH to Gmail to Brevo's HTTP email API after
// production logs showed every SMTP send timing out from Render's network —
// Gmail (and many mail providers) silently drop raw SMTP connections from
// shared cloud-hosting IP ranges. An HTTPS API sidesteps that entirely.
const BREVO_API_KEY = process.env.BREVO_API_KEY;
// Reuses SMTP_USER if that's still set from the old config, so this doesn't
// force an extra env var change on top of adding BREVO_API_KEY.
const FROM_EMAIL = process.env.EMAIL_FROM_ADDRESS || process.env.SMTP_USER;
const FROM_NAME_DEFAULT = "PriceEdge";

async function sendEmail({ to, subject, text, html, fromName }) {
  if (!BREVO_API_KEY || !FROM_EMAIL) {
    console.warn("BREVO_API_KEY/EMAIL_FROM_ADDRESS not set — skipping email send.");
    return;
  }

  await axios.post(
    "https://api.brevo.com/v3/smtp/email",
    {
      sender: { name: fromName || FROM_NAME_DEFAULT, email: FROM_EMAIL },
      to: [{ email: to }],
      subject,
      textContent: text,
      htmlContent: html,
    },
    { headers: { "api-key": BREVO_API_KEY, "Content-Type": "application/json" } }
  );
}

const PLAN_LABELS = { free: "Free", basic: "Basic", trial: "Free Trial" };

export async function sendSubscriptionConfirmation({ to, name, plan, provider, renewalDate }) {
  const planLabel = PLAN_LABELS[plan] || plan;
  const siteUrl = process.env.APP_BASE_URL || "http://localhost:5000";
  const isFree = plan === "free";
  const isTrial = plan === "trial";
  const paidVia = !isFree && !isTrial && provider ? ` (paid via ${provider})` : "";
  const statusLine = isFree
    ? `Your PriceEdge Free account is active — you now see member pricing on a curated sample of deals.`
    : isTrial
    ? `Your PriceEdge free trial is active — you have full member pricing on every brand in the catalog, no card required.`
    : `Your PriceEdge ${planLabel} membership is now active${paidVia}.`;
  const upgradeLine = isFree
    ? "Upgrade any time to unlock the full catalog at every brand."
    : isTrial
    ? `Your trial ends on ${renewalDate} — subscribe any time before then to keep full access.`
    : `Your next renewal is ${renewalDate}.`;

  await sendEmail({
    to,
    subject: isFree
      ? "Welcome to PriceEdge — your free access is live"
      : isTrial
      ? "Welcome to PriceEdge — your free trial is live"
      : "Welcome to PriceEdge — your membership is active",
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
  await sendEmail({
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
  await sendEmail({
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

// Sent once, a few days before a no-card trial ends (see
// TRIAL_REMINDER_DAYS_BEFORE / checkAndSendTrialReminders in server.js), so
// losing full-catalog access doesn't come as a surprise.
export async function sendTrialEndingReminder({ to, name, trialEndsAt }) {
  const siteUrl = process.env.APP_BASE_URL || "http://localhost:5000";

  await sendEmail({
    to,
    subject: "Your PriceEdge free trial ends soon",
    text: [
      `Hi ${name || "there"},`,
      "",
      `Your free trial ends on ${trialEndsAt} — after that, you'll lose full member pricing across the catalog.`,
      "Subscribe any time before then to keep access, no interruption.",
      "",
      `Choose a plan: ${siteUrl}/#pricing`,
      "",
      "— The PriceEdge Team",
    ].join("\n"),
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #0071e3;">Your free trial ends soon</h2>
        <p>Hi ${name || "there"},</p>
        <p>Your free trial ends on <strong>${trialEndsAt}</strong> — after that, you'll lose full member pricing across the catalog.</p>
        <p>Subscribe any time before then to keep access, no interruption.</p>
        <p><a href="${siteUrl}/#pricing" style="color: #0071e3;">Choose a plan &rarr;</a></p>
        <p style="color: #86868b; font-size: 13px;">— The PriceEdge Team</p>
      </div>
    `,
  });
}

// Sent to an existing member when someone they referred completes a paid
// signup. Credits are a running ledger only — redeemed manually against an
// order, since there's no wallet/discount-code system in this MVP.
export async function notifyReferralReward({ to, name, rewardAmount, totalCredits }) {
  await sendEmail({
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
  await sendEmail({
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
  await sendEmail({
    to: FROM_EMAIL,
    fromName: "PriceEdge Refunds",
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
  await sendEmail({
    to: FROM_EMAIL,
    fromName: "PriceEdge Leads",
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
