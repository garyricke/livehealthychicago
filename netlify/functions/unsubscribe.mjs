// /api/unsubscribe?t=<token> — opt-out for Live Healthy Chicago newsletters.
//
// GET  → a small page with one "Unsubscribe" button (a GET never unsubscribes, so
//        link scanners and previewers can't opt people out by accident).
// POST → unsubscribes: the button on that page, or a mail app's one-click
//        unsubscribe (RFC 8058, body "List-Unsubscribe=One-Click").
// Opt-outs are permanent: newsletter.mjs never emails an unsubscribed contact,
// and adding the address again doesn't clear it.
//
// Netlify env: SUPABASE_URL, SUPABASE_SERVICE_KEY.

const esc = (x) => String(x).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOGO = "https://res.cloudinary.com/dsbllwpbh/image/upload/f_auto,q_auto,w_400/lhc-brand/logo-live-healthy-chicago";

const page = (title, body, status = 200) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${title} · Live Healthy Chicago</title>
<link rel="icon" type="image/png" href="https://res.cloudinary.com/dsbllwpbh/image/upload/f_auto,q_auto/v1771612857/favicon-live-healthy-chicago_e7o6el.png">
<style>body{margin:0;background:#EEF2F7;color:#1a2535;font:16px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
main{max-width:460px;margin:10vh auto;padding:32px 28px;background:#fff;border:1px solid #D5DCE6;border-radius:14px}
img{display:block;width:180px;height:auto;margin:0 0 22px}
h1{font:700 24px/1.2 Montserrat,system-ui,sans-serif;margin:0 0 10px;color:#1B365D;text-wrap:balance}p{margin:0 0 14px;text-wrap:pretty}
button{font:600 16px system-ui,sans-serif;background:#1B365D;color:#fff;border:0;border-radius:8px;padding:12px 20px;cursor:pointer}
button:hover{background:#264a7c}a{color:#1B365D}.fine{font-size:13px;color:#5B6B80;margin-top:18px}</style></head>
<body><main><img src="${LOGO}" alt="Live Healthy Chicago">${body}<p class="fine"><a href="https://livehealthychi.com/">livehealthychi.com</a></p></main></body></html>`,
  { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

const notFound = (status) => page("Link not recognized",
  `<h1>That link didn&rsquo;t work</h1><p>It may be incomplete. Reply to any of our emails and we&rsquo;ll take you off the&nbsp;list.</p>`, status);

export default async (req) => {
  const t = new URL(req.url).searchParams.get("t") || "";
  if (!UUID.test(t)) return notFound(400);

  const SB = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
  const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
  const rows = await fetch(`${SB}/rest/v1/nl_contacts?token=eq.${t}&select=email,unsubscribed_at`, { headers: H })
    .then((r) => r.json()).catch(() => []);
  const c = Array.isArray(rows) ? rows[0] : null;
  if (!c) return notFound(404);

  if (req.method === "POST") {
    let via = "link";
    try { if (/List-Unsubscribe=One-Click/i.test(await req.text())) via = "one-click"; } catch {}
    if (!c.unsubscribed_at) {
      await fetch(`${SB}/rest/v1/nl_contacts?token=eq.${t}`, {
        method: "PATCH", headers: H, body: JSON.stringify({ unsubscribed_at: new Date().toISOString(), unsub_via: via }) });
    }
    if (via === "one-click") return new Response("ok", { status: 200 });
    return page("Unsubscribed", `<h1>You&rsquo;re unsubscribed</h1><p>${esc(c.email)} won&rsquo;t get any more Live Healthy Chicago newsletters.</p>`);
  }

  if (c.unsubscribed_at) return page("Already unsubscribed", `<h1>You&rsquo;re already unsubscribed</h1><p>${esc(c.email)} won&rsquo;t get any more Live Healthy Chicago newsletters.</p>`);
  return page("Unsubscribe", `<h1>Unsubscribe?</h1><p>Stop Live Healthy Chicago newsletters to <b>${esc(c.email)}</b>.</p>
    <form method="post"><button type="submit">Unsubscribe</button></form>`);
};

export const config = { path: "/api/unsubscribe" };
