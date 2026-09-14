// Mike's Client Hub behind www.8888media.co/hub/: every client's stage, what's paid and owed,
// what needs Mike, and new mockup requests, all read live from the private 8888-client-intake
// bucket. One passcode (the Pages secret HUB_KEY) unlocks it, and the page remembers it on Mike's
// devices. Read-only: changes still go through 8888-client-sites/tools/intake.cjs.

const MAX_FAILS = 10; // wrong passcodes per visitor per hour; counters expire with the rate/ lifecycle rule
const START = "https://www.8888media.co/start/";
const LINKS = {
  leadTracker: "https://claude.ai/code/artifact/f56cefe9-7035-448c-a037-01414ec6de5c",
  quickMessages: "https://claude.ai/code/artifact/e8423c2b-63ae-41fa-974c-35741ed95117",
};
const PACKAGES = { launch: "Launch Page", business: "Business Site" };
const CARE_MONTHLY = { monthly: 100, yearly: 1000 / 12 };
const DAY = 864e5;

export async function onRequest({ request, env, params }) {
  if (!env.HUB_KEY) return json({ error: "The hub isn't set up yet." }, 503);
  const denied = await checkKey(request, env);
  if (denied) return denied;

  const route = (params.path || []).join("/");
  try {
    if (route === "overview" && request.method === "GET") return json(await overview(env));
  } catch (err) {
    console.error("hub error", route, err && err.message);
    return json({ error: "Something went wrong loading the hub. Try again in a minute." }, 500);
  }
  return json({ error: "Not found." }, 404);
}

async function checkKey(request, env) {
  const given = normalizeKey(request.headers.get("X-Hub-Key") || "");
  if (!given) return json({ error: "Enter your passcode." }, 401);

  const ipHash = (await sha256(request.headers.get("CF-Connecting-IP") || "unknown")).slice(0, 16);
  const hour = new Date().toISOString().slice(0, 13).replace(/\D/g, "");
  const rateKey = `rate/hub/${ipHash}/${hour}`;
  const counter = await env.INTAKE.get(rateKey);
  const fails = counter ? Number(await counter.text()) || 0 : 0;
  if (fails >= MAX_FAILS) return json({ error: "Too many wrong passcodes. Try again in an hour." }, 429);

  // Hashing both sides first makes the comparison the same length and constant-time.
  if (sameString(await sha256(given), await sha256(normalizeKey(env.HUB_KEY)))) return null;
  await env.INTAKE.put(rateKey, String(fails + 1));
  return json({ error: "That passcode didn't work." }, 401);
}

// Case, spaces and dashes don't matter, so it's easy to type on a phone.
function normalizeKey(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 200);
}

async function overview(env) {
  const [slugs, inquiries] = await Promise.all([clientSlugs(env), loadInquiries(env)]);
  const clients = await Promise.all(slugs.map((slug) => loadClient(env, slug)));
  clients.sort((a, b) => group(a) - group(b) || b.needsYou.length - a.needsYou.length || (b.lastActivity || "").localeCompare(a.lastActivity || ""));

  const events = [];
  for (const c of clients) for (const e of c.events) events.push({ ...e, slug: c.slug, business: c.business });
  for (const r of inquiries) events.push({ at: r.at, text: `Asked for a free mockup (${r.name})`, business: r.business, inquiry: r.id });
  events.sort((a, b) => b.at.localeCompare(a.at));

  return {
    now: new Date().toISOString(),
    money: totals(clients),
    counts: {
      active: clients.filter((c) => c.group === "active").length,
      live: clients.filter((c) => c.group === "live").length,
      closed: clients.filter((c) => c.group === "closed").length,
    },
    clients,
    inquiries,
    recent: events.slice(0, 12),
    links: LINKS,
  };
}

const group = (c) => ({ active: 0, live: 1, closed: 2 })[c.group];

async function clientSlugs(env) {
  const slugs = [];
  let cursor;
  do {
    const page = await env.INTAKE.list({ prefix: "clients/", delimiter: "/", cursor });
    for (const p of page.delimitedPrefixes || []) slugs.push(p.slice("clients/".length, -1));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return slugs;
}

async function countFiles(env, prefix) {
  let count = 0;
  let cursor;
  do {
    const page = await env.INTAKE.list({ prefix, cursor });
    count += page.objects.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return count;
}

async function getJson(env, key) {
  const obj = await env.INTAKE.get(key);
  if (!obj) return null;
  try { return await obj.json(); } catch { return null; }
}

// New mockup requests only. The morning brief moves them into the Lead Tracker and marks them handled.
async function loadInquiries(env) {
  const keys = [];
  let cursor;
  do {
    const page = await env.INTAKE.list({ prefix: "inquiries/", cursor });
    for (const o of page.objects) keys.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  // Keys start with the request time, so the newest 100 are the last 100.
  const docs = await Promise.all(keys.slice(-100).map((k) => getJson(env, k)));
  return docs
    .filter((r) => r && r.status === "new")
    .map((r) => ({ id: r.id, at: r.at, name: r.name, business: r.business, contact: r.contact, reach: r.reach || "", link: r.link || "", notes: r.notes || "" }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

// Works out the same things as `intake.cjs status`, plus the stage, the money and a short history.
async function loadClient(env, slug) {
  const base = `clients/${slug}`;
  const [access, answers, collected, files, agreement, previews, launch, testimonial] = await Promise.all([
    getJson(env, `${base}/access.json`),
    getJson(env, `${base}/answers.json`),
    getJson(env, `${base}/collected.json`),
    countFiles(env, `${base}/files/`),
    getJson(env, `${base}/agreement.json`),
    getJson(env, `${base}/previews.json`),
    getJson(env, `${base}/launch.json`),
    getJson(env, `${base}/testimonial.json`),
  ]);
  const a = access || {};
  const now = Date.now();
  const closed = !!a.closed;
  const pays = (Array.isArray(a.payments) ? a.payments : []).filter((p) => p && p.amount);
  const deposit = pays.find((p) => p.id === "deposit");
  const final = pays.find((p) => p.id === "final");
  const settled = (p) => !!p && (p.status === "paid" || p.status === "processing");
  const given = (answers && answers.answers) || {};
  const accountDone = !!(given.acct_created && given.acct_domain && given.acct_invite);
  const submittedAt = (answers && answers.submittedAt) || null;
  const items = (previews && Array.isArray(previews.items) ? previews.items : []).filter((p) => p.status !== "replaced");
  const latest = items[items.length - 1] || null;
  const accepted = agreement && agreement.accepted ? agreement.accepted : null;
  const testimonialDue = launch && now >= new Date(launch.testimonialFrom || launch.launchedAt).getTime();
  const liveDays = launch ? Math.floor((now - new Date(launch.launchedAt).getTime()) / DAY) : null;

  let answersState = "Not Started";
  if (submittedAt) {
    const changed = !collected || collected.answersUpdatedAt !== answers.updatedAt || collected.files !== files;
    answersState = !collected ? "Sent, Not Pulled" : changed ? "Changed Since Pulled" : "Pulled";
  } else if (answers || files) answersState = "In Progress";

  // What needs Mike. The first six match `intake.cjs status`, so the morning brief and the hub agree.
  const needsYou = [];
  if (!closed) {
    if (answersState === "Sent, Not Pulled") needsYou.push("Answers sent: pull them");
    if (answersState === "Changed Since Pulled") needsYou.push("Answers or files changed since the last pull");
    if (latest && latest.status === "changes") needsYou.push(`Changes requested on preview ${latest.round}`);
    if (latest && latest.status === "approved" && !final) needsYou.push(`Preview ${latest.round} approved: add the final payment`);
    if (testimonial && (!collected || collected.testimonialAt !== testimonial.at)) needsYou.push("New testimonial: pull it for the portfolio");
    if (launch && liveDays >= 30) needsYou.push("Live 30+ days: free fixes are over; close the link when ready");
    if (submittedAt && !latest && !launch) needsYou.push("Build the first preview");
    if (final && settled(final) && !launch) needsYou.push("Paid in full: launch the site");
  }

  // What the client still has to do, in the order their page lists it.
  const waitingOn = [];
  if (!closed) {
    if (agreement && !accepted) waitingOn.push("Accept the agreement");
    if (deposit && deposit.status === "due") waitingOn.push("Pay the deposit");
    if (!accountDone && !launch) waitingOn.push("Set up their website account");
    if (!submittedAt && !launch) waitingOn.push("Answer the questions");
    if (latest && latest.status === "waiting") waitingOn.push(`Review preview ${latest.round}`);
    if (final && final.status === "due") waitingOn.push("Make the final payment");
    if (testimonialDue && !testimonial) waitingOn.push("Leave a testimonial");
  }

  const steps = [];
  if (agreement) steps.push({ label: "Agreement", done: !!accepted });
  if (deposit) steps.push({ label: "Deposit", done: settled(deposit) });
  steps.push({ label: "Account", done: accountDone || !!launch });
  steps.push({ label: "Questions", done: !!submittedAt || !!launch });
  steps.push({ label: "Preview", done: (latest && latest.status === "approved") || !!launch });
  steps.push({ label: "Final", done: settled(final) || (!!launch && !final) });
  steps.push({ label: "Live", done: !!launch });

  const sum = (list) => list.reduce((n, p) => n + Number(p.amount || 0), 0);
  const paid = sum(pays.filter((p) => p.status === "paid"));
  const clearing = sum(pays.filter((p) => p.status === "processing"));
  const due = sum(pays.filter((p) => p.status === "due"));
  const toBill = closed ? 0 : Math.max(0, Number(a.total || 0) - paid - clearing - due);

  const events = [];
  const add = (at, text) => at && events.push({ at, text });
  add(a.createdAt, "Project page created");
  if (accepted) add(accepted.at, `Accepted the agreement (${accepted.name})`);
  for (const p of pays) {
    if (p.status === "paid" && p.paidAt) add(p.paidAt, `${p.label} received${p.paidVia === "stripe" ? " through Stripe" : ""}`);
  }
  if (submittedAt) add(submittedAt, answers.submitCount > 1 ? "Sent updated answers" : "Sent their answers");
  for (const p of items) {
    add(p.postedAt, `Preview ${p.round} posted`);
    if (p.response && p.status === "approved") add(p.response.at, `Approved preview ${p.round}`);
    if (p.response && p.status === "changes") add(p.response.at, `Asked for changes on preview ${p.round}`);
  }
  if (launch) add(launch.launchedAt, "Site went live");
  if (testimonial) add(testimonial.at, "Left a testimonial");
  events.sort((x, y) => y.at.localeCompare(x.at));

  const care = a.carePlan && a.carePlan.status === "active" ? { plan: a.carePlan.plan, since: a.carePlan.since || null } : null;

  return {
    slug,
    business: a.business || slug,
    owner: a.owner || "",
    package: PACKAGES[a.package] || a.package || "",
    isBusinessSite: a.package === "business",
    rate: a.rate || "",
    total: Number(a.total || 0),
    createdAt: a.createdAt || null,
    closed,
    group: closed ? "closed" : launch ? "live" : "active",
    link: a.key ? `${START}#c=${slug}&k=${a.key}` : null,
    stage: stageOf({ closed, launch, agreement, accepted, deposit, final, submittedAt, accountDone, latest }),
    steps,
    needsYou,
    waitingOn,
    payments: pays.map((p) => ({ id: p.id, label: p.label, amount: Number(p.amount), status: p.status, paidAt: p.paidAt || null, paidVia: p.paidVia || null, card: !!p.cardUrl, cardTest: p.cardMode === "test" })),
    money: { paid, clearing, due, toBill },
    agreement: !agreement ? null : accepted ? { acceptedBy: accepted.name, at: accepted.at } : { acceptedBy: null },
    answers: { state: answersState, submittedAt, updatedAt: (answers && answers.updatedAt) || null, files },
    preview: latest ? { round: latest.round, status: latest.status, url: latest.url, postedAt: latest.postedAt, note: latest.note || "", response: latest.response || null } : null,
    launch: launch ? { url: launch.url, launchedAt: launch.launchedAt, days: liveDays } : null,
    testimonial: testimonial ? { text: testimonial.text, name: testimonial.name || "", showOk: !!testimonial.showOk, at: testimonial.at } : null,
    care,
    lastActivity: events.length ? events[0].at : a.createdAt || null,
    events: events.slice(0, 8),
  };
}

// One short label for where the project is, and whose move it is.
function stageOf({ closed, launch, agreement, accepted, deposit, final, submittedAt, accountDone, latest }) {
  if (closed) return { label: "Closed", whose: "done" };
  if (launch) return { label: "Live", whose: "done" };
  if (agreement && !accepted) return { label: "Waiting on Agreement", whose: "them" };
  if (deposit && deposit.status === "due") return { label: "Waiting on Deposit", whose: "them" };
  if (deposit && deposit.status === "processing") return { label: "Deposit Clearing", whose: "them" };
  if (!submittedAt) return { label: accountDone ? "Waiting on Questions" : "Waiting on Setup and Questions", whose: "them" };
  if (!latest) return { label: "Your Turn: Build Preview 1", whose: "you" };
  if (latest.status === "waiting") return { label: `Waiting on Preview ${latest.round} Review`, whose: "them" };
  if (latest.status === "changes") return { label: `Your Turn: Preview ${latest.round} Changes`, whose: "you" };
  if (!final) return { label: "Your Turn: Add Final Payment", whose: "you" };
  if (final.status === "due") return { label: "Waiting on Final Payment", whose: "them" };
  return { label: "Your Turn: Launch", whose: "you" };
}

const monthOf = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit" }).format(new Date(d));

function totals(clients) {
  const thisMonth = monthOf(Date.now());
  let collectedThisMonth = 0;
  let collectedAllTime = 0;
  let owed = 0;
  let clearing = 0;
  let toBill = 0;
  let carePlans = 0;
  let careMonthly = 0;
  for (const c of clients) {
    for (const p of c.payments) {
      if (p.status !== "paid") continue;
      collectedAllTime += p.amount;
      if (p.paidAt && monthOf(p.paidAt) === thisMonth) collectedThisMonth += p.amount;
    }
    if (!c.closed) {
      owed += c.money.due;
      clearing += c.money.clearing;
      toBill += c.money.toBill;
    }
    if (c.care && !c.closed) {
      carePlans++;
      careMonthly += CARE_MONTHLY[c.care.plan] || 0;
    }
  }
  return { collectedThisMonth, collectedAllTime, owed, clearing, toBill, carePlans, careMonthly: Math.round(careMonthly) };
}

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sha256(s) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
}
