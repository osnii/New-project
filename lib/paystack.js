import axios from "axios";
import crypto from "crypto";

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

// Pro/Elite dropped: they unlocked the same catalog as Basic with no
// enforced difference beyond price, which an external commercial review
// flagged as unsellable ("why pay more for the same thing"). Single paid
// tier until there's a genuine, enforced reason to differentiate further —
// see the tier-gating backlog note below.
export const PLAN_CODES = {
  basic: process.env.PLAN_CODE_BASIC,
  basic_annual: process.env.PLAN_CODE_BASIC_ANNUAL,
};

// Annual price = 10x monthly (2 months free) — a starting guess, not
// validated pricing. Watch which interval real signups actually pick before
// treating either number as settled.
export const PLANS = {
  basic: { name: "Basic", amountNaira: 5000, period: "month", code: PLAN_CODES.basic },
  basic_annual: { name: "Basic (Annual)", amountNaira: 50000, period: "year", code: PLAN_CODES.basic_annual },
};

export async function verifyTransaction(reference) {
  const res = await axios.get(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
  );
  return res.data;
}

export function isValidWebhookSignature(rawBody, signatureHeader) {
  const hash = crypto
    .createHmac("sha512", PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest("hex");
  return hash === signatureHeader;
}

// Fetching by email instead of storing subscription_code/email_token at
// signup time — those never got captured (no subscription.create webhook
// handler existed), and this way self-service cancellation doesn't depend
// on a webhook having actually fired for that member's signup.
export async function findActiveSubscriptionForEmail(email) {
  const res = await axios.get(`https://api.paystack.co/customer/${encodeURIComponent(email)}`, {
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` },
  });
  const subscriptions = res.data?.data?.subscriptions || [];
  return subscriptions.find((s) => s.status === "active") || null;
}

// Disables future billing on a subscription — does not touch access for the
// period already paid for. Requires both the subscription's code and its
// email_token (Paystack's two-factor confirmation for this destructive
// action), both only obtainable from a subscription object itself.
export async function disableSubscription(subscriptionCode, emailToken) {
  await axios.post(
    "https://api.paystack.co/subscription/disable",
    { code: subscriptionCode, token: emailToken },
    { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
  );
}
