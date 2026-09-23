import axios from "axios";
import crypto from "crypto";

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

export const PLAN_CODES = {
  basic: process.env.PLAN_CODE_BASIC,
  pro: process.env.PLAN_CODE_PRO,
  elite: process.env.PLAN_CODE_ELITE,
  basic_annual: process.env.PLAN_CODE_BASIC_ANNUAL,
  pro_annual: process.env.PLAN_CODE_PRO_ANNUAL,
  elite_annual: process.env.PLAN_CODE_ELITE_ANNUAL,
};

// Annual price = 10x monthly (2 months free) — a starting guess, not
// validated pricing. Watch which interval real signups actually pick before
// treating either number as settled.
export const PLANS = {
  basic: { name: "Basic", amountNaira: 2500, period: "month", code: PLAN_CODES.basic },
  pro: { name: "Pro", amountNaira: 5000, period: "month", code: PLAN_CODES.pro },
  elite: { name: "Elite", amountNaira: 10000, period: "month", code: PLAN_CODES.elite },
  basic_annual: { name: "Basic (Annual)", amountNaira: 25000, period: "year", code: PLAN_CODES.basic_annual },
  pro_annual: { name: "Pro (Annual)", amountNaira: 50000, period: "year", code: PLAN_CODES.pro_annual },
  elite_annual: { name: "Elite (Annual)", amountNaira: 100000, period: "year", code: PLAN_CODES.elite_annual },
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
