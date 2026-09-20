import axios from "axios";
import crypto from "crypto";

const SQUAD_SECRET_KEY = process.env.SQUAD_SECRET_KEY;
const SQUAD_BASE_URL = process.env.SQUAD_BASE_URL || "https://sandbox-api-d.squadco.com";

function client() {
  return axios.create({
    baseURL: SQUAD_BASE_URL,
    headers: { Authorization: `Bearer ${SQUAD_SECRET_KEY}` },
  });
}

// Starts a one-off hosted checkout. Squad has no client-side widget (unlike
// Paystack's inline.js), so the frontend does a full-page redirect to the
// returned checkout_url and Squad sends the customer back to callbackUrl.
export async function initiateTransaction({ email, amountNaira, transactionRef, callbackUrl, metadata }) {
  const res = await client().post("/transaction/initiate", {
    email,
    amount: Math.round(amountNaira * 100), // kobo, like Paystack
    currency: "NGN",
    initiate_type: "inline",
    transaction_ref: transactionRef,
    callback_url: callbackUrl,
    metadata,
  });
  return res.data;
}

export async function verifyTransaction(transactionRef) {
  const res = await client().get(`/transaction/verify/${encodeURIComponent(transactionRef)}`);
  return res.data;
}

// Squad hashes the raw JSON body with HMAC-SHA512 and sends it uppercase-hex
// in the x-squad-encrypted-body header.
export function isValidWebhookSignature(rawBody, signatureHeader) {
  const hash = crypto
    .createHmac("sha512", SQUAD_SECRET_KEY)
    .update(rawBody)
    .digest("hex")
    .toUpperCase();
  return signatureHeader && hash === signatureHeader.toUpperCase();
}
