// Netlify event function — fires automatically on every Netlify Forms submission.
// Writes the submission into the Supabase `submissions` table so the admin
// dashboard can read them all in one place.
//
// Requires two environment variables set in the Netlify UI
// (Site settings → Environment variables) — never committed:
//   SUPABASE_URL          e.g. https://vwsvqtohkxmnzjzohtql.supabase.co
//   SUPABASE_SERVICE_KEY  the Supabase service_role key (server-side only)
//
// The service key bypasses row-level security so the function can insert;
// reads are still gated by RLS (admin auth only) on the dashboard side.

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || '{}');
    const payload = body.payload;
    if (!payload) return { statusCode: 400, body: 'no payload' };

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return { statusCode: 500, body: 'missing SUPABASE_URL / SUPABASE_SERVICE_KEY' };
    }

    // Drop Netlify's honeypot + internal fields from the stored data.
    const data = Object.assign({}, payload.data || {});
    delete data['bot-field'];
    delete data['ip'];

    const row = {
      netlify_id: payload.id || null,
      form_name: payload.form_name || 'unknown',
      submitted_at: payload.created_at || null,
      data,
    };

    const res = await fetch(`${SUPABASE_URL}/rest/v1/submissions`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        // Upsert on netlify_id so re-deliveries / backfills don't duplicate.
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(row),
    });

    if (!res.ok) {
      const t = await res.text();
      return { statusCode: 502, body: 'supabase insert failed: ' + t };
    }
    return { statusCode: 200, body: 'ok' };
  } catch (e) {
    return { statusCode: 500, body: 'error: ' + ((e && e.message) || e) };
  }
};
