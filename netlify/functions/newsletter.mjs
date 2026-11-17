// /api/newsletter — the newsletter sender behind the /send admin page.
//
// Every request must carry the Supabase admin session (Authorization: Bearer <access_token>),
// the same login as /submissions. The browser never touches the contact list directly:
// the nl_* tables have RLS on with no policies, so only this function (service role) can read them.
//
// Actions (POST JSON {action, ...}):
//   overview      → contacts + recent issues
//   add           → {emails: "pasted text", source}  add addresses (opt-outs stay opted out)
//   import_portal → add everyone from the portal sign-up form
//   unsubscribe   → {email}  manual opt-out
//   issues        → designed issues (nl_issues) for the issue picker
//   design        → {id?, instructions, doc_text, doc_name, gdoc_url}  start Claude designing a new issue
//                   (no id) or revising one (id); runs in newsletter-design-background.mjs, page polls
//   issue_get     → {id}  one designed issue (status, html, notes, history)
//   issue_undo    → {id}  go back to the version before the last revision
//   issue_archive → {id}  hide it from the picker
//   preview       → {path | html, subject}  the exact email, footer included
//   test          → {path | html, subject, to: "a@b.org, c@d.org"}  up to 5 addresses
//   send          → {path | html, subject, confirm: <eligible count>}  sends up to CHUNK per call;
//                   the page calls again until remaining = 0. Refused unless this exact
//                   subject + HTML was sent as a test first.
//
// Netlify env (secrets, set in the Netlify UI, never committed):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY   (already used by submission-created.js)
//   RESEND_API_KEY                       sending key for the From domain below
//   NEWSLETTER_FROM        default "Live Healthy Chicago <news@websiteformrequests.com>"
//   NEWSLETTER_REPLY_TO    default LiveHealthyChi@uchicagomedicine.org
//   NEWSLETTER_POSTAL_ADDRESS  required for "send to everyone" (CAN-SPAM); tests work without it
//   ANTHROPIC_API_KEY      for "Design an issue" (Claude); everything else works without it
//
// Sender: every test/send can carry {from_name, reply_to}; the page defaults them to the values
// below and lets the admin change them. They're part of the tested fingerprint, so changing the
// sender after a test means testing again.

import crypto from "node:crypto";

const SITE = "https://livehealthychi.com";
const ADMIN_EMAIL = "admin@livehealthychi.com";
const CHUNK = 200;                       // recipients per call (2 Resend batches)
const FROM = process.env.NEWSLETTER_FROM || "Live Healthy Chicago <news@websiteformrequests.com>";
const FROM_NAME = (FROM.match(/^\s*"?([^"<]*?)"?\s*</) || [, "Live Healthy Chicago"])[1].trim();
const FROM_ADDR = (FROM.match(/<([^>]+)>/) || [, FROM])[1].trim();
const REPLY_TO = process.env.NEWSLETTER_REPLY_TO || "LiveHealthyChi@uchicagomedicine.org";
const POSTAL = (process.env.NEWSLETTER_POSTAL_ADDRESS || "").trim();
const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const fail = (msg, status = 400) => json({ error: msg }, status);
const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EMAIL_RE = /[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

// ── Supabase REST (service role) ─────────────────────────────────────────────
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

// ── Building the email ───────────────────────────────────────────────────────
async function issueBody({ path, html, issue_id }) {
  if (issue_id) {
    const [it] = await db(`nl_issues?id=eq.${encodeURIComponent(issue_id)}&select=html,status`);
    if (!it || !it.html) throw new Error("That designed issue isn't ready yet.");
    if (it.status === "designing") throw new Error("Claude is still working on that issue. Wait for it to finish, then preview.");
    return { body: it.html.trim(), source_path: `issue:${issue_id}` };
  }
  if (html && html.trim()) {
    const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    return { body: (m ? m[1] : html).trim(), source_path: null };
  }
  if (!/^\/newsletter\/[a-z0-9-]+$/.test(path || "")) throw new Error("Pick an issue from /newsletter/ or paste the email HTML.");
  const res = await fetch(SITE + path, { headers: { "Cache-Control": "no-cache" } });
  if (!res.ok) throw new Error(`Couldn't load ${path} (${res.status}).`);
  const page = await res.text();
  const m = page.match(/<!--\s*NEWSLETTER-BODY-START\s*-->([\s\S]*?)<!--\s*NEWSLETTER-BODY-END\s*-->/);
  if (!m) throw new Error(`${path} has no NEWSLETTER-BODY-START / END markers.`);
  return { body: m[1].trim(), source_path: path };
}

// The sender is part of the fingerprint: a test only unlocks the send for the same subject, body AND sender.
function senderOf(p) {
  const name = String(p.from_name ?? FROM_NAME).replace(/[<>"\r\n]/g, "").trim().slice(0, 80) || FROM_NAME;
  const rt = String(p.reply_to ?? REPLY_TO).trim().toLowerCase();
  if (!/^[^@\s<>"]+@[^@\s<>"]+\.[a-z]{2,}$/.test(rt)) throw new Error("The reply-to address doesn't look like an email address.");
  return { from: `${name} <${FROM_ADDR}>`, reply_to: rt, key: name === FROM_NAME && rt === REPLY_TO.toLowerCase() ? "" : `\n${name}\n${rt}` };
}
const shaOf = (subject, body, sender) => crypto.createHash("sha256").update(subject + "\n" + body + (sender ? sender.key : "")).digest("hex");

function footer(unsubUrl) {
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;margin:24px auto 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <tr><td style="padding:16px 20px;border-top:1px solid #D5DCE6;font-size:12px;line-height:1.6;color:#5B6B80;text-align:center;">
    You&rsquo;re getting this because you&rsquo;re part of the Live Healthy Chicago partner network.<br>
    <a href="${esc(unsubUrl)}" style="color:#5B6B80;text-decoration:underline;">Unsubscribe</a>
    ${POSTAL ? `<br>${esc(POSTAL)}` : ""}
  </td></tr>
</table>`;
}

function wrap(subject, body, unsubUrl) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:24px 12px 40px;background:#EEF2F7;">
${body}
${footer(unsubUrl)}
</body></html>`;
}

function textVersion(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => `${t.replace(/<[^>]+>/g, "").trim()} (${href})`)
    .replace(/<(br|\/p|\/tr|\/h[1-6]|\/li)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&rsquo;|&lsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;/g, "—").replace(/&ndash;/g, "–").replace(/&amp;/g, "&").replace(/&middot;/g, "·")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
}

const unsubUrl = (token) => `${SITE}/api/unsubscribe?t=${token}`;

function message(subject, body, to, token, sender) {
  const u = unsubUrl(token);
  const html = wrap(subject, body, u);
  return {
    from: sender.from, to: [to], reply_to: sender.reply_to, subject, html, text: textVersion(html),
    headers: { "List-Unsubscribe": `<${u}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}

async function resend(path, payload) {
  const res = await fetch(`https://api.resend.com${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`email service: ${res.status} ${out.message || JSON.stringify(out).slice(0, 200)}`);
  return out;
}

async function campaignFor(subject, body, source_path, sender) {
  const sha = shaOf(subject, body, sender);
  const [c] = await db(`nl_campaigns?html_sha=eq.${sha}&select=*`);
  if (c) return c;
  const [made] = await db("nl_campaigns?on_conflict=html_sha", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ subject, source_path, html_sha: sha }),
  });
  return made;
}

async function eligible(campaignId) {
  const all = await db("nl_contacts?select=id,email,token&unsubscribed_at=is.null&bounced_at=is.null&complained_at=is.null&order=created_at");
  const done = await db(`nl_sends?campaign_id=eq.${campaignId}&error=is.null&select=contact_id`);  // failed rows get retried
  const sent = new Set(done.map((d) => d.contact_id));
  return all.filter((c) => !sent.has(c.id));
}

async function addEmails(list, source) {
  const seen = new Set();
  const rows = [];
  for (const { email, name } of list) {
    const e = (email || "").trim().toLowerCase();
    if (!e || seen.has(e) || !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e)) continue;
    seen.add(e);
    rows.push({ email: e, name: name ? String(name).slice(0, 160) : null, source });
  }
  if (!rows.length) return { added: 0, found: 0 };
  const added = await db("nl_contacts?on_conflict=email", {
    method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify(rows),
  });
  return { added: (added || []).length, found: rows.length };
}

// ── Handler ──────────────────────────────────────────────────────────────────
export default async (req) => {
  if (req.method !== "POST") return fail("POST only", 405);
  if (!SB || !KEY) return fail("SUPABASE_URL / SUPABASE_SERVICE_KEY are not set on this site.", 500);
  if (!(await isAdmin(req))) return fail("Please sign in again.", 401);

  let p = {};
  try { p = await req.json(); } catch { return fail("Bad request"); }

  try {
    switch (p.action) {
      case "overview": {
        const contacts = await db("nl_contacts?select=email,name,source,created_at,unsubscribed_at,bounced_at&order=created_at.desc");
        const campaigns = await db("nl_campaigns?select=id,subject,source_path,test_sent_at,test_sent_to,sent_at,created_at&order=created_at.desc&limit=10");
        const ids = campaigns.map((c) => c.id);
        const sends = ids.length ? await db(`nl_sends?campaign_id=in.(${ids.join(",")})&select=campaign_id,error`) : [];
        for (const c of campaigns) {
          const mine = sends.filter((s) => s.campaign_id === c.id);
          c.sent = mine.filter((s) => !s.error).length;
          c.failed = mine.filter((s) => s.error).length;
        }
        return json({
          contacts, campaigns,
          ready: { resend: !!process.env.RESEND_API_KEY, postal: !!POSTAL, claude: !!process.env.ANTHROPIC_API_KEY,
                   from: FROM, from_name: FROM_NAME, from_addr: FROM_ADDR, reply_to: REPLY_TO },
        });
      }

      case "add": {
        const found = String(p.emails || "").match(EMAIL_RE) || [];
        return json(await addEmails(found.map((email) => ({ email })), "pasted"));
      }

      case "import_portal": {
        const rows = await db("submissions?form_name=eq.portal-signup&select=data");
        return json(await addEmails(rows.map((r) => ({ email: r.data?.email, name: r.data?.name })), "portal-signup"));
      }

      case "unsubscribe": {
        const e = String(p.email || "").trim().toLowerCase();
        await db(`nl_contacts?email=eq.${encodeURIComponent(e)}&unsubscribed_at=is.null`, {
          method: "PATCH", body: JSON.stringify({ unsubscribed_at: new Date().toISOString(), unsub_via: "manual" }),
        });
        return json({ ok: true });
      }

      case "preview": {
        const subject = String(p.subject || "").trim() || "(no subject)";
        const { body } = await issueBody(p);
        const sender = senderOf(p);
        return json({ html: wrap(subject, body, `${SITE}/api/unsubscribe?t=preview`), sha: shaOf(subject, body, sender) });
      }

      case "test": {
        if (!process.env.RESEND_API_KEY) return fail("RESEND_API_KEY isn't set on this site yet.", 500);
        const subject = String(p.subject || "").trim();
        if (!subject) return fail("Add a subject line first.");
        const to = [...new Set((String(p.to || "").match(EMAIL_RE) || []).map((e) => e.toLowerCase()))].slice(0, 5);
        if (!to.length) return fail("Add at least one test address.");
        const sender = senderOf(p);
        const { body, source_path } = await issueBody(p);
        const camp = await campaignFor(subject, body, source_path, sender);
        const ids = [];
        for (const addr of to) {
          // A tester who is also on the list gets their real unsubscribe link; anyone else gets a dummy.
          const [c] = await db(`nl_contacts?email=eq.${encodeURIComponent(addr)}&select=token`);
          const msg = message("[TEST] " + subject, body, addr, c ? c.token : "test", sender);
          ids.push((await resend("/emails", msg)).id);
          await sleep(550);
        }
        await db(`nl_campaigns?id=eq.${camp.id}`, {
          method: "PATCH", body: JSON.stringify({ test_sent_at: new Date().toISOString(), test_sent_to: to.join(", ") }),
        });
        return json({ ok: true, to, ids });
      }

      case "send": {
        if (!process.env.RESEND_API_KEY) return fail("RESEND_API_KEY isn't set on this site yet.", 500);
        if (!POSTAL) return fail("Add NEWSLETTER_POSTAL_ADDRESS in Netlify before sending to the list (it's required in every marketing email).", 500);
        const subject = String(p.subject || "").trim();
        const sender = senderOf(p);
        const { body } = await issueBody(p);
        const [camp] = await db(`nl_campaigns?html_sha=eq.${shaOf(subject, body, sender)}&select=*`);
        if (!camp || !camp.test_sent_at) return fail("Send yourself a test of this exact version first. Any edit to the subject or the issue needs a new test.");
        const todo = await eligible(camp.id);
        if (p.confirm !== undefined && Number(p.confirm) !== todo.length && !p.continuing) {
          return fail(`The list changed: ${todo.length} people would get it now, not ${p.confirm}. Review and try again.`);
        }
        const chunk = todo.slice(0, CHUNK);
        let sent = 0, failed = 0;
        for (let i = 0; i < chunk.length; i += 100) {
          const part = chunk.slice(i, i + 100);
          let ids = [], err = null;
          try { ids = (await resend("/emails/batch", part.map((c) => message(subject, body, c.email, c.token, sender)))).data || []; }
          catch (e) { err = String(e.message || e).slice(0, 300); }
          await db("nl_sends?on_conflict=campaign_id,contact_id", {
            method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify(part.map((c, k) => ({ campaign_id: camp.id, contact_id: c.id, resend_id: ids[k]?.id || null, error: err }))),
          });
          if (err) failed += part.length; else sent += part.length;
          await sleep(600);
        }
        const remaining = todo.length - chunk.length;
        if (!remaining) await db(`nl_campaigns?id=eq.${camp.id}`, { method: "PATCH", body: JSON.stringify({ sent_at: new Date().toISOString() }) });
        return json({ ok: true, sent, failed, remaining });
      }

      case "count": {
        const subject = String(p.subject || "").trim();
        const sender = senderOf(p);
        const { body, source_path } = await issueBody(p);
        const camp = await campaignFor(subject, body, source_path, sender);
        return json({ eligible: (await eligible(camp.id)).length, tested: !!camp.test_sent_at, test_sent_to: camp.test_sent_to });
      }

      case "issues": {
        return json({ issues: await db("nl_issues?archived_at=is.null&select=id,title,subject,status,updated_at,created_at&order=updated_at.desc&limit=30") });
      }

      case "issue_get": {
        const [it] = await db(`nl_issues?id=eq.${encodeURIComponent(p.id)}&select=id,title,subject,preheader,html,status,error,history,updated_at,prev_html`);
        if (!it) return fail("Issue not found", 404);
        it.can_undo = !!it.prev_html; delete it.prev_html;
        return json({ issue: it });
      }

      case "issue_undo": {
        const [it] = await db(`nl_issues?id=eq.${encodeURIComponent(p.id)}&select=html,subject,prev_html,prev_subject,history`);
        if (!it || !it.prev_html) return fail("There's no earlier version to go back to.");
        const history = [...(it.history || []), { at: new Date().toISOString(), instructions: "(Undid the last change)" }];
        await db(`nl_issues?id=eq.${encodeURIComponent(p.id)}`, { method: "PATCH", body: JSON.stringify({
          html: it.prev_html, subject: it.prev_subject || it.subject, prev_html: it.html, prev_subject: it.subject,
          history, status: "ready", error: null, updated_at: new Date().toISOString() }) });
        return json({ ok: true });
      }

      case "issue_archive": {
        await db(`nl_issues?id=eq.${encodeURIComponent(p.id)}`, { method: "PATCH", body: JSON.stringify({ archived_at: new Date().toISOString() }) });
        return json({ ok: true });
      }

      case "design": {
        if (!process.env.ANTHROPIC_API_KEY) return fail("ANTHROPIC_API_KEY isn't set on this site yet, so Claude can't design issues.", 500);
        const instructions = String(p.instructions || "").trim().slice(0, 8000);
        let doc = String(p.doc_text || "").slice(0, 200000), docName = String(p.doc_name || "").slice(0, 200);
        if (p.gdoc_url) {
          const m = String(p.gdoc_url).match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]{20,})/);
          if (!m) return fail("That doesn't look like a Google Doc link.");
          const r = await fetch(`https://docs.google.com/document/d/${m[1]}/export?format=html`, { redirect: "follow" });
          const t = await r.text();
          if (!r.ok || /accounts\.google\.com|ServiceLogin/.test(r.url) || !/<body/i.test(t)) {
            return fail("Couldn't open that Google Doc. In the doc, click Share and set General access to \u201cAnyone with the link\u201d (Viewer), then try again.");
          }
          doc = t.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<head[\s\S]*?<\/head>/i, "").replace(/\s(style|class|id)="[^"]*"/gi, "").slice(0, 200000);
          docName = docName || "Google Doc";
        }
        if (!instructions && !doc) return fail("Tell Claude what the issue should cover, or attach a document.");
        const pending = { instructions, doc, doc_name: docName };
        let id = p.id;
        if (id) {
          const [it] = await db(`nl_issues?id=eq.${encodeURIComponent(id)}&select=status,updated_at`);
          if (!it) return fail("Issue not found", 404);
          if (it.status === "designing" && Date.now() - new Date(it.updated_at) < 10 * 60e3) return fail("Claude is still working on this issue.");
          await db(`nl_issues?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ status: "designing", error: null, pending, updated_at: new Date().toISOString() }) });
        } else {
          const [made] = await db("nl_issues", { method: "POST", headers: { Prefer: "return=representation" },
            body: JSON.stringify({ title: "New issue (designing…)", status: "designing", pending }) });
          id = made.id;
        }
        // Hand off to the background function (up to 15 minutes); it re-checks the admin session.
        const bg = await fetch(new URL("/.netlify/functions/newsletter-design-background", req.url), {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: req.headers.get("authorization") },
          body: JSON.stringify({ id }),
        });
        if (bg.status !== 202 && !bg.ok) {
          await db(`nl_issues?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ status: "error", error: `Couldn't start the designer (${bg.status}).` }) });
          return fail(`Couldn't start the designer (${bg.status}).`, 500);
        }
        return json({ ok: true, id });
      }

      default:
        return fail("Unknown action");
    }
  } catch (e) {
    return fail(String(e.message || e), 500);
  }
};

export const config = { path: "/api/newsletter" };
