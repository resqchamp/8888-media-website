// Client intake API behind www.8888media.co/start/.
// Each client gets a private link carrying their slug and a random key. Nothing here is
// readable or writable without both, and everything stays under clients/<slug>/ in the
// private 8888-client-intake bucket. Mike's side is 8888-client-sites/tools/intake.cjs.

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const FILE_ID = /^(logo|photos)\/[a-z0-9]+-[a-z0-9]+-[a-z0-9._-]{1,80}$/;
const ANSWER_ID = /^[a-z0-9_]{1,40}$/;
const FIELDS = new Set(["logo", "photos"]);
const ALLOWED_NAME = /\.(jpe?g|png|webp|gif|heic|heif|svg|pdf|ai|eps|psd)$/i;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 80;
const MAX_ANSWERS_BYTES = 96 * 1024;
const EMAIL_FALLBACK = "mike@8888media.co";

export async function onRequest({ request, env, params }) {
  const client = await authorize(request, env);
  if (!client) return json({ error: "This link isn't working anymore. Ask Mike for a new one." }, 403);

  const route = (params.path || []).join("/");
  const method = request.method;
  try {
    if (route === "state" && method === "GET") return await state(env, client);
    if (route === "answers" && (method === "PUT" || method === "POST")) return await saveAnswers(request, env, client);
    if (route === "files" && method === "POST") return await upload(request, env, client);
    if (route.startsWith("files/") && method === "DELETE") return await removeFile(env, client, route.slice(6));
  } catch (err) {
    console.error("intake error", route, err && err.message);
    return json({ error: "Something went wrong on our end. Try again in a minute." }, 500);
  }
  return json({ error: "Not found." }, 404);
}

async function authorize(request, env) {
  const slug = request.headers.get("X-Intake-Client") || "";
  const key = request.headers.get("X-Intake-Key") || "";
  if (!SLUG.test(slug) || key.length < 20 || key.length > 100) return null;
  const obj = await env.INTAKE.get(`clients/${slug}/access.json`);
  if (!obj) return null;
  const access = await obj.json();
  if (access.closed || typeof access.key !== "string" || !sameString(access.key, key)) return null;
  return { slug, base: `clients/${slug}`, access };
}

// Compare without stopping at the first mismatch, so response timing doesn't leak the key.
function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function state(env, { base, access }) {
  const [answersObj, files] = await Promise.all([env.INTAKE.get(`${base}/answers.json`), listFiles(env, base)]);
  const saved = answersObj ? await answersObj.json() : {};
  return json({
    business: access.business || "",
    owner: access.owner || "",
    package: access.package || "",
    payments: Array.isArray(access.payments) ? access.payments : [],
    answers: saved.answers || {},
    updatedAt: saved.updatedAt || null,
    submittedAt: saved.submittedAt || null,
    files,
  });
}

// Files live at clients/<slug>/files/<logo|photos>/<id>, so the id carries its field.
async function listFiles(env, base) {
  const prefix = `${base}/files/`;
  const files = [];
  let cursor;
  do {
    const page = await env.INTAKE.list({ prefix, cursor, include: ["customMetadata"] });
    for (const o of page.objects) {
      const id = o.key.slice(prefix.length);
      files.push({ id, name: o.customMetadata?.name || id.split("/").pop(), field: id.split("/")[0], size: o.size, uploaded: o.uploaded });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return files;
}

async function saveAnswers(request, env, { base, access }) {
  const text = await request.text();
  if (text.length > MAX_ANSWERS_BYTES) {
    return json({ error: "That's more text than the form can hold. Shorten a long answer and try again." }, 413);
  }
  let body;
  try { body = JSON.parse(text); } catch { return json({ error: "Couldn't read those answers. Try again." }, 400); }
  const answers = cleanAnswers(body.answers);
  if (!answers) return json({ error: "Couldn't read those answers. Try again." }, 400);

  const prevObj = await env.INTAKE.get(`${base}/answers.json`);
  const prev = prevObj ? await prevObj.json() : {};
  const now = new Date().toISOString();
  const doc = {
    business: access.business || "",
    answers,
    questions: cleanQuestions(body.questions) || prev.questions || [],
    updatedAt: now,
    submittedAt: body.submit ? now : prev.submittedAt || null,
    submitCount: (prev.submitCount || 0) + (body.submit ? 1 : 0),
  };
  await env.INTAKE.put(`${base}/answers.json`, JSON.stringify(doc, null, 2), { httpMetadata: { contentType: "application/json" } });
  return json({ ok: true, updatedAt: now, submittedAt: doc.submittedAt });
}

function cleanAnswers(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  let count = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (!ANSWER_ID.test(k) || ++count > 80) continue;
    if (typeof v === "string") out[k] = v.slice(0, 8000);
    else if (typeof v === "boolean") out[k] = v;
    else if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === "string").slice(0, 20).map((x) => x.slice(0, 200));
  }
  return out;
}

function cleanQuestions(raw) {
  if (!Array.isArray(raw)) return null;
  return raw
    .filter((q) => q && typeof q.id === "string" && ANSWER_ID.test(q.id))
    .slice(0, 80)
    .map((q) => ({ id: q.id, section: String(q.section || "").slice(0, 80), label: String(q.label || "").slice(0, 300) }));
}

async function upload(request, env, { base }) {
  const size = Number(request.headers.get("Content-Length") || 0);
  if (!size) return json({ error: "That file came through empty. Try adding it again." }, 411);
  if (size > MAX_FILE_BYTES) return json({ error: `That file is over 25 MB. Email it to ${EMAIL_FALLBACK} instead.` }, 413);

  let name = "";
  try { name = decodeURIComponent(request.headers.get("X-File-Name") || ""); } catch { name = ""; }
  const field = request.headers.get("X-File-Field") || "";
  if (!name || !ALLOWED_NAME.test(name)) {
    return json({ error: "That type of file can't be uploaded here. Photos, PDFs and logo files work." }, 415);
  }
  if (!FIELDS.has(field)) return json({ error: "Couldn't tell where that file belongs. Try again." }, 400);

  const existing = await env.INTAKE.list({ prefix: `${base}/files/`, limit: MAX_FILES });
  if (existing.objects.length >= MAX_FILES) {
    return json({ error: `That's the limit of ${MAX_FILES} files. Remove a few, or email extras to ${EMAIL_FALLBACK}.` }, 409);
  }

  const safe = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(-80) || "file";
  const id = `${field}/${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}-${safe}`;
  await env.INTAKE.put(`${base}/files/${id}`, request.body, {
    httpMetadata: { contentType: request.headers.get("Content-Type") || "application/octet-stream" },
    customMetadata: { name: name.slice(0, 200) },
  });
  return json({ id, name, field, size }, 201);
}

async function removeFile(env, { base }, id) {
  if (!FILE_ID.test(id)) return json({ error: "Couldn't find that file." }, 404);
  await env.INTAKE.delete(`${base}/files/${id}`);
  return json({ ok: true });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
