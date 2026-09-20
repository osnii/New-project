import axios from "axios";
import crypto from "crypto";

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

export const PLAN_CODES = {
  basic: process.env.PLAN_CODE_BASIC,
  pro: process.env.PLAN_CODE_PRO,
  elite: process.env.PLAN_CODE_ELITE,
};

export const PLANS = {
  basic: { name: "Basic", amountNaira: 2500, code: PLAN_CODES.basic },
  pro: { name: "Pro", amountNaira: 5000, code: PLAN_CODES.pro },
  elite: { name: "Elite", amountNaira: 10000, code: PLAN_CODES.elite },
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
