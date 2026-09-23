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

// Fire-and-forget funnel logging — never blocks the UI and never throws.
function trackEvent(event, meta = {}) {
  try {
    fetch("/api/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, ...meta }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // ignore — analytics should never break the page
  }
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

    trackEvent("open_subscribe", { plan: planKey });
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

  trackEvent("start_checkout", { plan: planKey, provider: "squad", email });

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

  trackEvent("start_checkout", { plan: planKey, provider: "paystack", email });

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
            trackEvent("complete_signup", { plan: planKey, provider: "paystack", email });
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

function openFreeSignupModal() {
  trackEvent("open_subscribe", { plan: "free" });
  document.getElementById("freeSignupModal").classList.add("open");
}

function closeFreeSignupModal() {
  document.getElementById("freeSignupModal").classList.remove("open");
}

async function handleFreeSignupSubmit(event) {
  event.preventDefault();

  const name = document.getElementById("freeUserName").value.trim();
  const email = document.getElementById("freeUserEmail").value.trim();
  const phone = document.getElementById("freeUserPhone").value.trim();

  const btn = document.getElementById("freeContinueBtn");
  const originalText = btn.textContent;
  btn.textContent = "Setting up...";
  btn.disabled = true;

  trackEvent("start_checkout", { plan: "free", provider: "free", email });

  try {
    const res = await fetch("/api/subscribe/free", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, phone, role: "customer" }),
    });
    const data = await res.json();

    if (data.success) {
      setStoredMemberEmail(email);
      trackEvent("complete_signup", { plan: "free", provider: "free", email });
      showToast("You're in! Check your email, then browse brands.");
      closeFreeSignupModal();
      setTimeout(() => window.location.assign("/brands.html"), 1200);
    } else {
      showToast(data.error || "Couldn't set up free access.");
    }
  } catch {
    showToast("Something went wrong. Try again shortly.");
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

function openContractorLeadModal() {
  trackEvent("open_subscribe", { plan: "contractor_lead" });
  document.getElementById("contractorLeadModal").classList.add("open");
}

function closeContractorLeadModal() {
  document.getElementById("contractorLeadModal").classList.remove("open");
}

async function handleContractorLeadSubmit(event) {
  event.preventDefault();

  const name = document.getElementById("leadName").value.trim();
  const email = document.getElementById("leadEmail").value.trim();
  const phone = document.getElementById("leadPhone").value.trim();
  const businessName = document.getElementById("leadBusinessName").value.trim();
  const message = document.getElementById("leadMessage").value.trim();

  const btn = document.getElementById("leadContinueBtn");
  const originalText = btn.textContent;
  btn.textContent = "Sending...";
  btn.disabled = true;

  trackEvent("start_checkout", { plan: "contractor_lead", provider: "lead", email });

  try {
    const res = await fetch("/api/contractor-lead", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, phone, businessName, message }),
    });
    const data = await res.json();

    if (data.success) {
      trackEvent("complete_signup", { plan: "contractor_lead", provider: "lead", email });
      showToast("Request sent — we'll be in touch within 24 hours.");
      closeContractorLeadModal();
      event.target.reset();
    } else {
      showToast(data.error || "Couldn't send your request.");
    }
  } catch {
    showToast("Something went wrong. Try again shortly.");
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("subscriptionForm");
  if (form) form.addEventListener("submit", handleSubscriptionSubmit);

  const leadForm = document.getElementById("contractorLeadForm");
  if (leadForm) leadForm.addEventListener("submit", handleContractorLeadSubmit);

  const freeForm = document.getElementById("freeSignupForm");
  if (freeForm) freeForm.addEventListener("submit", handleFreeSignupSubmit);
});
