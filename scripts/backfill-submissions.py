#!/usr/bin/env python3
"""
One-time backfill: pull existing Netlify Forms submissions into the Supabase
`submissions` table (the same table the submission-created function writes to,
so going forward everything lands in one place).

Run it once after creating the table. It's safe to re-run — rows upsert on
netlify_id, so duplicates are skipped.

Required environment variables (do NOT hardcode these):
  NETLIFY_API_TOKEN      Netlify personal access token (User settings → Applications)
  SUPABASE_URL           e.g. https://vwsvqtohkxmnzjzohtql.supabase.co
  SUPABASE_SERVICE_KEY   Supabase service_role key (Project settings → API)

Usage:
  NETLIFY_API_TOKEN=xxx SUPABASE_URL=https://...supabase.co SUPABASE_SERVICE_KEY=yyy \
    python3 scripts/backfill-submissions.py
"""
import json, os, sys, urllib.request, urllib.error

NETLIFY_TOKEN = os.environ.get("NETLIFY_API_TOKEN")
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
# Only back-fill these forms (matches the live site). Edit if needed.
FORMS = {"contact", "celebrate-survey", "celebrate-drawing", "portal-signup", "whats-your-why"}

if not (NETLIFY_TOKEN and SUPABASE_URL and SERVICE_KEY):
    sys.exit("Missing env: set NETLIFY_API_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY")

def netlify_get(path):
    req = urllib.request.Request(
        "https://api.netlify.com/api/v1" + path,
        headers={"Authorization": "Bearer " + NETLIFY_TOKEN},
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

def supa_upsert(rows):
    body = json.dumps(rows).encode()
    req = urllib.request.Request(
        SUPABASE_URL + "/rest/v1/submissions",
        data=body, method="POST",
        headers={
            "apikey": SERVICE_KEY,
            "Authorization": "Bearer " + SERVICE_KEY,
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
    )
    with urllib.request.urlopen(req) as r:
        return r.status

# Resolve the site id (env override, else find by livehealthychi.com domain).
SITE_ID = os.environ.get("NETLIFY_SITE_ID")
if not SITE_ID:
    for s in netlify_get("/sites?per_page=100"):
        hay = (s.get("name", "") + (s.get("custom_domain") or "") + (s.get("ssl_url") or "")).lower()
        if "livehealthychi" in hay:
            SITE_ID = s["id"]; break
if not SITE_ID:
    sys.exit("Could not find the livehealthychi site; set NETLIFY_SITE_ID.")

# List the site's forms, keep the ones we care about.
forms = [f for f in netlify_get(f"/sites/{SITE_ID}/forms") if f.get("name") in FORMS]
print(f"Found {len(forms)} matching form(s): {', '.join(f['name'] for f in forms)}")

total = 0
for f in forms:
    fid, name = f["id"], f["name"]
    page, batch = 1, []
    while True:
        subs = netlify_get(f"/forms/{fid}/submissions?per_page=100&page={page}")
        if not subs:
            break
        for s in subs:
            data = dict(s.get("data") or {})
            data.pop("bot-field", None); data.pop("ip", None)
            batch.append({
                "netlify_id": s.get("id"),
                "form_name": name,
                "submitted_at": s.get("created_at"),
                "data": data,
            })
        page += 1
    if batch:
        supa_upsert(batch)
        total += len(batch)
        print(f"  {name}: {len(batch)} submission(s) upserted")

print(f"Done. {total} submission(s) backfilled into Supabase.")
