// TrueSketch shared frontend helpers.
"use strict";

const CHECKOUT_URL = "https://mehyar.us/api/pay/checkout";
const PRODUCT_ID = "truesketch-reading";

async function startCheckout({ email, intake_id, name, test }) {
  const body = {
    product_id: PRODUCT_ID,
    email,
    params: { intake_id, name: (name || "").slice(0, 100) },
    // success_url intentionally omitted: the server builds it from the
    // billing_products.success_url_template, which embeds ?token={access_token}.
    cancel_url: "https://truesketch.mehyar.us/#pricing",
  };
  if (test === true) body.test = true;
  const res = await fetch(CHECKOUT_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* fall through */ }
  if (!res.ok || !data || !data.checkout_url) {
    const err = (data && data.error) || ("checkout_failed_" + res.status);
    throw new Error(err);
  }
  return data; // {ok, payment_id, token, checkout_url}
}

function getQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function setStatus(el, msg, kind) {
  el.textContent = msg || "";
  el.className = "status" + (kind ? " " + kind : "");
}

window.TrueSketch = { startCheckout, getQueryParam, setStatus, PRODUCT_ID };
