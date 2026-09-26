// Shared helpers used across pages: config loading, toasts, and the subscribe modal.

// Escapes a value for safe interpolation into an HTML attribute (alt, title,
// or a double-quoted attribute like onclick="..."). Sheet data (product
// names, brand names) is untrusted-ish free text an admin typed — a stray
// `"` (very common in TV size labels like 43") would otherwise break out of
// the attribute and corrupt the surrounding markup.
function escapeHtmlAttr(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

// Escapes a value so it's safe as a single-quoted JS string literal *inside*
// an onclick="..." attribute. Apply this first, then escapeHtmlAttr on the
// result, since the browser HTML-unescapes the attribute before running it
// as JS — the JS-string escaping has to survive that unescaping step.
function jsStringLiteral(str) {
  return String(str ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

// Chrome/Android fire this instead of showing their own install UI immediately,
// so we can show our own "Install App" button. Safari/iOS never fires this —
// there, installing is manual via the browser's own "Add to Home Screen".
let deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  document.querySelectorAll(".install-app-btn").forEach((btn) => (btn.style.display = "inline-block"));
});

async function installApp() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  document.querySelectorAll(".install-app-btn").forEach((btn) => (btn.style.display = "none"));
}

window.addEventListener("appinstalled", () => {
  document.querySelectorAll(".install-app-btn").forEach((btn) => (btn.style.display = "none"));
});

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

// Monthly/annual pricing toggle on the homepage. A bare tier name ("basic")
// resolves to "basic_annual" when Annual is selected; an already-specific
// key (e.g. from a direct link) passes through unchanged.
let selectedBillingPeriod = "month";
const PLAN_TIERS = ["basic", "pro", "elite"];

function resolvePlanKey(tier) {
  return selectedBillingPeriod === "year" && PLAN_TIERS.includes(tier) ? `${tier}_annual` : tier;
}

function setBillingPeriod(period) {
  selectedBillingPeriod = period;
  document.querySelectorAll(".toggle-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.period === period);
  });
  renderPlanCardPrices();
}

function renderPlanCardPrices() {
  getConfig().then((config) => {
    document.querySelectorAll("[data-plan-tier]").forEach((card) => {
      const tier = card.dataset.planTier;
      const plan = config.plans[resolvePlanKey(tier)];
      if (!plan) return;
      const suffix = plan.period === "year" ? "/yr" : "/mo";
      card.querySelector(".plan-price").innerHTML = `₦${plan.amountNaira.toLocaleString()}<span>${suffix}</span>`;
    });
  });
}

function openSubscribeModal(planKey) {
  getConfig().then((config) => {
    const plan = config.plans[planKey];
    if (!plan) return;

    trackEvent("open_subscribe", { plan: planKey });
    document.getElementById("modalPlanKey").value = planKey;
    document.getElementById("modalPlanName").textContent = `${plan.name} Plan`;
    const suffix = plan.period === "year" ? "/year" : "/month";
    document.getElementById("modalPlanPrice").textContent = `₦${plan.amountNaira.toLocaleString()}${suffix}`;
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
  const referredBy = document.getElementById("userReferredBy").value.trim();
  // ":checked" only matches radio/checkbox inputs, so when Paystack's radio
  // is commented out in favor of a plain hidden input, fall back to reading
  // that instead.
  const providerInput =
    document.querySelector('input[name="paymentProvider"]:checked') ||
    document.querySelector('input[name="paymentProvider"]');
  const provider = providerInput?.value || "squad";

  const signupDetails = { name, email, phone, role, businessName, referredBy, plan: planKey };

  if (provider === "squad") {
    await paySubscriptionWithSquad(signupDetails);
  } else {
    await paySubscriptionWithPaystack(signupDetails);
  }
}

async function paySubscriptionWithSquad({ name, email, phone, role, businessName, referredBy, plan: planKey }) {
  const continueBtn = document.getElementById("continueBtn");
  const originalText = continueBtn.textContent;
  continueBtn.textContent = "Redirecting...";
  continueBtn.disabled = true;

  trackEvent("start_checkout", { plan: planKey, provider: "squad", email });

  try {
    const res = await fetch("/api/subscribe/squad/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, phone, role, businessName, referredBy, plan: planKey }),
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

async function paySubscriptionWithPaystack({ name, email, phone, role, businessName, referredBy, plan: planKey }) {
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
    metadata: { name, phone, role, businessName, referredBy, plan: planKey },
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
          referredBy,
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
  const referredBy = document.getElementById("freeUserReferredBy").value.trim();

  const btn = document.getElementById("freeContinueBtn");
  const originalText = btn.textContent;
  btn.textContent = "Setting up...";
  btn.disabled = true;

  trackEvent("start_checkout", { plan: "free", provider: "free", email });

  try {
    const res = await fetch("/api/subscribe/free", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, phone, role: "customer", referredBy }),
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

function openBrandRequestModal() {
  trackEvent("open_subscribe", { plan: "brand_request" });
  document.getElementById("brandRequestModal").classList.add("open");
}

function closeBrandRequestModal() {
  document.getElementById("brandRequestModal").classList.remove("open");
}

async function handleBrandRequestSubmit(event) {
  event.preventDefault();

  const brandName = document.getElementById("requestBrandName").value.trim();
  const email = document.getElementById("requestBrandEmail").value.trim();

  const btn = document.getElementById("brandRequestContinueBtn");
  const originalText = btn.textContent;
  btn.textContent = "Sending...";
  btn.disabled = true;

  trackEvent("start_checkout", { plan: "brand_request", provider: "brand_request", detail: brandName, email });

  try {
    const res = await fetch("/api/brand-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brandName, email }),
    });
    const data = await res.json();

    if (data.success) {
      trackEvent("complete_signup", { plan: "brand_request", provider: "brand_request", detail: brandName, email });
      showToast("Thanks! We'll factor this into what we add next.");
      closeBrandRequestModal();
      event.target.reset();
    } else {
      showToast(data.error || "Couldn't submit your request.");
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

  const brandRequestForm = document.getElementById("brandRequestForm");
  if (brandRequestForm) brandRequestForm.addEventListener("submit", handleBrandRequestSubmit);

  if (document.querySelector("[data-plan-tier]")) renderPlanCardPrices();
});
