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
  });
  return transporter;
}

const PLAN_LABELS = { basic: "Basic", pro: "Pro", elite: "Elite" };

export async function sendSubscriptionConfirmation({ to, name, plan, provider, renewalDate }) {
  if (!SMTP_USER || !SMTP_PASS) {
    console.warn("SMTP_USER/SMTP_PASS not set — skipping confirmation email.");
    return;
  }

  const planLabel = PLAN_LABELS[plan] || plan;
  const siteUrl = process.env.APP_BASE_URL || "http://localhost:5000";

  await getTransporter().sendMail({
    from: `PriceEdge <${SMTP_USER}>`,
    to,
    subject: "Welcome to PriceEdge — your membership is active",
    text: [
      `Hi ${name || "there"},`,
      "",
      `Your PriceEdge ${planLabel} membership is now active (paid via ${provider}).`,
      `Your next renewal is ${renewalDate}.`,
      "",
      `Browse brands and see your member pricing: ${siteUrl}/brands.html`,
      "",
      "— The PriceEdge Team",
    ].join("\n"),
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #0071e3;">Welcome to PriceEdge</h2>
        <p>Hi ${name || "there"},</p>
        <p>Your <strong>${planLabel}</strong> membership is now active${provider ? ` (paid via ${provider})` : ""}.</p>
        <p>Your next renewal is <strong>${renewalDate}</strong>.</p>
        <p><a href="${siteUrl}/brands.html" style="color: #0071e3;">Browse brands and see your member pricing &rarr;</a></p>
        <p style="color: #86868b; font-size: 13px;">— The PriceEdge Team</p>
      </div>
    `,
  });
}
