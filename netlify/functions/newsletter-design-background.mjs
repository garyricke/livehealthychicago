// Background function: Claude designs (or revises) a newsletter issue for the /send page.
//
// Called by /api/newsletter (action "design") with the admin's Supabase session; Netlify answers
// 202 right away and this keeps running (up to 15 minutes). The result lands in nl_issues:
// status "ready" with subject/preheader/html, or status "error" with a message. The page polls.
//
// Netlify env: SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY (secret, set in the UI).

import Anthropic from "@anthropic-ai/sdk";

const SITE = "https://livehealthychi.com";
const ADMIN_EMAIL = "admin@livehealthychi.com";
const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
const H = () => ({ apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" });

async function db(path, opts = {}) {
  const res = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H(), ...(opts.headers || {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`database: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function isAdmin(req) {
  const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!tok) return false;
  const res = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${tok}` } });
  if (!res.ok) return false;
  const u = await res.json().catch(() => ({}));
  return (u.email || "").toLowerCase() === ADMIN_EMAIL;
}

// The September issue is the house style: Claude matches its structure, colors and components.
async function referenceIssue() {
  try {
    const page = await (await fetch(`${SITE}/newsletter/september-2026`)).text();
    const m = page.match(/<!--\s*NEWSLETTER-BODY-START\s*-->([\s\S]*?)<!--\s*NEWSLETTER-BODY-END\s*-->/);
    return m ? m[1].trim() : "";
  } catch { return ""; }
}

const SYSTEM = (reference) => `You design email newsletters for Live Healthy Chicago (LHC), a coalition of hospitals, health departments and community organizations working to lower high blood pressure in 27 Chicago neighborhoods. Readers are coalition partners: community health workers, clinic and program staff, faith and community leaders.

You produce the BODY of one HTML email. The sending system adds the unsubscribe footer and mailing address, so never write a footer, an unsubscribe link or an address block.

HOUSE STYLE: match the reference issue below. Same outer table (max-width:640px, centered, system font stack, color #1a2535, line-height 1.55), same masthead (eyebrow "Live Healthy Chicago", big navy title, issue/date line, the logo image at right exactly as in the reference), same white content cells, numbered takeaway cards with tinted backgrounds, section headings, and button style. Brand colors: navy #1B365D, red #E5202F, blue #1A7FB8, light red tint #FBEDEE, light blue tint #E6EEF7, muted text #5A6779, body text #2D2D2D. Reuse the reference's components rather than inventing new visual styles, unless the instructions ask for something different.

EMAIL RULES (Gmail, Outlook, Apple Mail):
- Tables for layout; every style inline. No <style>, no <script>, no CSS classes, no flexbox/grid, no web fonts, no forms, no video embeds.
- Images: only https URLs that appear in the instructions or document, plus the LHC logo from the reference. Give each img a width attribute, alt text and style="display:block;max-width:100%;height:auto;border:0". Never use data: URIs or invent image URLs.
- Buttons: a link styled like the reference's buttons. Every button and link must point to a URL given in the instructions or document, or to https://livehealthychi.com pages that appear in the reference. Never invent a URL. If a call to action has no URL, write the text without a button and list it in notes.
- Drop the reference's "View online" link: designed issues aren't published on the website.
- No widows: join words that belong together with &nbsp; (month + day like Oct&nbsp;26, times like 8:00&nbsp;AM, ranges, and the last two words of every heading and button).

CONTENT RULES:
- Use only facts from the instructions and document. Never invent dates, times, places, names, numbers, quotes or links. Where something needed is missing, put a visible placeholder in the email like <span style="background:#FFF3B0;">[NEED: date of the event]</span> and list it in notes.
- Plain, warm, partner-facing language. Short paragraphs, scannable headings, one clear action per section. No doom-and-gloom statistics, no grant jargon; never use the phrases "silent killer", "ASCVD" or "wicked problem".
- Lead with the "Top 3 Takeaways" pattern when there are three or more items; otherwise use what fits.
- Keep the source's meaning. You may tighten wording, but don't add claims.

WHEN REVISING an existing issue: change only what the request asks for and keep everything else exactly as it is.

Return JSON with:
- title: a short internal label for the issue list, e.g. "November 2026 · All-Partners Newsletter"
- subject: the email subject line (under 80 characters, no emoji)
- preheader: one sentence (under 110 characters) that inbox previews show after the subject
- html: the email body, starting with the outer <table> (put the preheader as a hidden first element: <div style="display:none;max-height:0;overflow:hidden;">…</div>)
- notes: 1–4 short sentences for the admin: what you did, and anything they must fill in or check before sending (placeholders, missing links, assumptions)

REFERENCE ISSUE (September 2026):
${reference}`;

const FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      title: { type: "string" }, subject: { type: "string" }, preheader: { type: "string" },
      html: { type: "string" }, notes: { type: "string" },
    },
    required: ["title", "subject", "preheader", "html", "notes"],
    additionalProperties: false,
  },
};

function lastDoc(history) {
  for (let i = (history || []).length - 1; i >= 0; i--) if (history[i].doc) return history[i];
  return null;
}

export default async (req) => {
  let id = null;
  try {
    if (!(await isAdmin(req))) return;
    ({ id } = await req.json());
    const [it] = await db(`nl_issues?id=eq.${encodeURIComponent(id)}&select=*`);
    if (!it || !it.pending) return;
    const { instructions, doc, doc_name } = it.pending;
    const revising = !!it.html;

    const parts = [];
    if (revising) {
      const src = doc ? null : lastDoc(it.history);
      parts.push(`Revise this existing issue.\n\nCURRENT SUBJECT: ${it.subject}\nCURRENT PREHEADER: ${it.preheader || ""}\n\nCURRENT HTML:\n${it.html}`);
      if (src) parts.push(`ORIGINAL SOURCE DOCUMENT (${src.doc_name || "document"}), for reference:\n${src.doc}`);
      if (doc) parts.push(`NEW DOCUMENT (${doc_name || "document"}):\n${doc}`);
      parts.push(`WHAT TO CHANGE:\n${instructions || "Work in the new document."}`);
    } else {
      parts.push("Design a new issue.");
      if (instructions) parts.push(`INSTRUCTIONS FROM THE ADMIN:\n${instructions}`);
      if (doc) parts.push(`SOURCE DOCUMENT (${doc_name || "document"}):\n${doc}`);
    }

    const client = new Anthropic();
    const stream = client.beta.messages.stream({
      model: "claude-opus-5-5",
      max_tokens: 64000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: FORMAT },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM(await referenceIssue()),
      messages: [{ role: "user", content: parts.join("\n\n") }],
    });
    const msg = await stream.finalMessage();

    if (msg.stop_reason === "refusal") throw new Error("Claude declined this request. Try rewording the instructions.");
    if (msg.stop_reason === "max_tokens") throw new Error("The issue came out too long. Ask for a shorter issue, or split it in two.");
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const out = JSON.parse(text);
    if (!/<table/i.test(out.html || "")) throw new Error("Claude's design didn't come back as an email layout. Try again.");
    const html = out.html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");

    const entry = { at: new Date().toISOString(), instructions: instructions || "", notes: out.notes || "" };
    if (doc) { entry.doc = doc; entry.doc_name = doc_name || "document"; }
    await db(`nl_issues?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({
      title: String(out.title || "").slice(0, 200), subject: String(out.subject || "").slice(0, 200),
      preheader: String(out.preheader || "").slice(0, 300), html,
      prev_html: it.html || null, prev_subject: it.subject || null,
      status: "ready", error: null, pending: null, history: [...(it.history || []), entry],
      updated_at: new Date().toISOString(),
    }) });
  } catch (e) {
    console.error("newsletter-design", e);
    if (id) {
      const message = e instanceof Anthropic.APIError ? `Claude API error (${e.status}). Try again in a minute.` : String(e.message || e);
      await db(`nl_issues?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({
        status: "error", error: message.slice(0, 500), updated_at: new Date().toISOString() }) }).catch(() => {});
    }
  }
};
