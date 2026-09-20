// Shared helpers used across pages: config loading, toasts, and the subscribe modal.

let appConfig = null;

async function getConfig() {
  if (appConfig) return appConfig;
  const res = await fetch("/api/config");
  appConfig = await res.json();
  return appConfig;
}

function showToast(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  document.getElementById("toastMessage").textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 3500);
}

function getStoredMemberEmail() {
  try {
    return localStorage.getItem("priceedge_member_email") || "";
  } catch {
    return "";
  }
}

function setStoredMemberEmail(email) {
  try {
    localStorage.setItem("priceedge_member_email", email);
  } catch {
    // localStorage unavailable (e.g. private browsing) — subscription still succeeds,
    // the visitor just won't be auto-recognized on their next visit.
  }
}

function openSubscribeModal(planKey) {
  getConfig().then((config) => {
    const plan = config.plans[planKey];
    if (!plan) return;

    document.getElementById("modalPlanKey").value = planKey;
    document.getElementById("modalPlanName").textContent = `${plan.name} Plan`;
    document.getElementById("modalPlanPrice").textContent = `₦${plan.amountNaira.toLocaleString()}/month`;
    document.getElementById("subscriptionModal").classList.add("open");
  });
}

function closeSubscriptionModal() {
  document.getElementById("subscriptionModal").classList.remove("open");
}

async function handleSubscriptionSubmit(event) {
  event.preventDefault();

  const planKey = document.getElementById("modalPlanKey").value;
  const name = document.getElementById("userName").value.trim();
  const email = document.getElementById("userEmail").value.trim();
  const phone = document.getElementById("userPhone").value.trim();
  const role = document.getElementById("userRole").value;
  const businessName = document.getElementById("userBusinessName").value.trim();
  // ":checked" only matches radio/checkbox inputs, so when Paystack's radio
  // is commented out in favor of a plain hidden input, fall back to reading
  // that instead.
  const providerInput =
    document.querySelector('input[name="paymentProvider"]:checked') ||
    document.querySelector('input[name="paymentProvider"]');
  const provider = providerInput?.value || "squad";

  const signupDetails = { name, email, phone, role, businessName, plan: planKey };

  if (provider === "squad") {
    await paySubscriptionWithSquad(signupDetails);
  } else {
    await paySubscriptionWithPaystack(signupDetails);
  }
}

async function paySubscriptionWithSquad({ name, email, phone, role, businessName, plan: planKey }) {
  const continueBtn = document.getElementById("continueBtn");
  const originalText = continueBtn.textContent;
  continueBtn.textContent = "Redirecting...";
  continueBtn.disabled = true;

  try {
    const res = await fetch("/api/subscribe/squad/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, phone, role, businessName, plan: planKey }),
    });
    const data = await res.json();

    if (!data.success || !data.checkoutUrl) {
      showToast(data.error || "Couldn't start Squad checkout.");
      continueBtn.textContent = originalText;
      continueBtn.disabled = false;
      return;
    }

    window.location.assign(data.checkoutUrl);
  } catch {
    showToast("Something went wrong starting Squad checkout.");
    continueBtn.textContent = originalText;
    continueBtn.disabled = false;
  }
}

async function paySubscriptionWithPaystack({ name, email, phone, role, businessName, plan: planKey }) {
  const config = await getConfig();
  const plan = config.plans[planKey];
  if (!plan || !plan.code) {
    showToast("This plan isn't configured yet. Add its Paystack plan code to .env.");
    return;
  }

  const continueBtn = document.getElementById("continueBtn");
  const originalText = continueBtn.textContent;
  continueBtn.textContent = "Processing...";
  continueBtn.disabled = true;

  const handler = PaystackPop.setup({
    key: config.paystackPublicKey,
    email,
    plan: plan.code,
    currency: "NGN",
    metadata: { name, phone, role, businessName, plan: planKey },
    callback: function (response) {
      fetch("/api/subscribe/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reference: response.reference,
          name,
          email,
          phone,
          role,
          businessName,
          plan: planKey,
        }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.success) {
            setStoredMemberEmail(email);
            showToast("Welcome to PriceEdge! Your membership is active.");
            closeSubscriptionModal();
            setTimeout(() => window.location.assign("/brands.html"), 1200);
          } else {
            showToast(data.error || "We couldn't confirm your payment.");
          }
        })
        .catch(() => showToast("Something went wrong confirming your payment."))
        .finally(() => {
          continueBtn.textContent = originalText;
          continueBtn.disabled = false;
        });
    },
    onClose: function () {
      continueBtn.textContent = originalText;
      continueBtn.disabled = false;
    },
  });

  handler.openIframe();
}

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("subscriptionForm");
  if (form) form.addEventListener("submit", handleSubscriptionSubmit);
});
