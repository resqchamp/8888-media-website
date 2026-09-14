// Stripe webhook for client card payments: POST www.8888media.co/api/stripe/webhook.
// Card links come from 8888-client-sites/tools/intake.cjs. When a client pays, Stripe calls here
// and their project page flips to "Received" by itself. A request is trusted only if it carries a
// valid Stripe signature, and a test-mode payment can never mark a live payment as paid.

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const HANDLED = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
]);
const TOLERANCE_SECONDS = 300;

export async function onRequestPost({ request, env }) {
  const payload = await request.text();
  const secrets = [env.STRIPE_WEBHOOK_SECRET, env.STRIPE_WEBHOOK_SECRET_TEST].filter(Boolean);
  const event = await verified(payload, request.headers.get("Stripe-Signature") || "", secrets);
  if (!event) return text("Invalid signature", 400);
  if (!HANDLED.has(event.type)) return text("Ignored");

  const session = event.data.object;
  const target = await findPayment(env, session);
  if (!target) return text("Not an 8888 client payment");
  const { key, access, payment } = target;
  if ((payment.cardMode === "live") !== Boolean(event.livemode)) return text("Test and live mismatch; ignored");

  if (event.type === "checkout.session.async_payment_failed") {
    if (payment.status !== "paid") {
      payment.status = "due";
      payment.note = "The bank payment didn't go through.";
    }
  } else if (session.payment_status === "paid") {
    payment.status = "paid";
    payment.paidAt = new Date().toISOString();
    payment.paidVia = "stripe";
    delete payment.note;
  } else {
    payment.status = "processing"; // a bank payment has started but hasn't cleared yet
  }
  payment.stripeSession = session.id;
  await env.INTAKE.put(key, JSON.stringify(access, null, 2), { httpMetadata: { contentType: "application/json" } });
  return text("OK");
}

// The payment link's metadata names the client and payment. If that's ever missing, fall back to
// the index the helper tool writes when it creates each link.
async function findPayment(env, session) {
  const meta = session.metadata || {};
  let slug = meta.source === "8888-intake" ? meta.slug : "";
  let paymentId = meta.source === "8888-intake" ? meta.payment : "";
  if ((!slug || !paymentId) && session.payment_link) {
    const idx = await env.INTAKE.get(`stripe-links/${session.payment_link}.json`);
    if (idx) ({ slug, payment: paymentId } = await idx.json());
  }
  if (!SLUG.test(slug || "") || !paymentId) return null;
  const key = `clients/${slug}/access.json`;
  const obj = await env.INTAKE.get(key);
  if (!obj) return null;
  const access = await obj.json();
  const payment = (access.payments || []).find((p) => p.id === paymentId);
  return payment ? { key, access, payment } : null;
}

// Stripe signs "<timestamp>.<body>" with the endpoint's secret (HMAC-SHA256) and sends
// "t=<timestamp>,v1=<signature>" in the Stripe-Signature header.
async function verified(payload, header, secrets) {
  if (!secrets.length || !header) return null;
  let timestamp = "";
  const signatures = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") timestamp = v;
    else if (k === "v1") signatures.push(v);
  }
  if (!timestamp || !signatures.length || Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return null;
  const enc = new TextEncoder();
  for (const secret of secrets) {
    const cryptoKey = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(`${timestamp}.${payload}`)));
    const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (signatures.some((s) => sameString(s, hex))) {
      try { return JSON.parse(payload); } catch { return null; }
    }
  }
  return null;
}

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function text(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
