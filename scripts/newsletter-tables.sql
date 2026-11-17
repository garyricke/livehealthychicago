-- Newsletter sender — contacts, campaigns, per-recipient sends, opt-outs.
-- Run once in Supabase → SQL Editor (project "Live Healthy Chicago Resources").
--
-- Flow (the /send admin page + netlify/functions/newsletter.mjs):
--   add recipients → pick an issue → send a test → send to everyone eligible.
-- "Send to everyone" is refused unless that exact version (html_sha) was sent as a test first.
--
-- Eligible = not unsubscribed, not bounced, not complained. An opt-out is permanent:
-- adding the same address again never clears unsubscribed_at. Every email carries a
-- personal unsubscribe link (/api/unsubscribe?t=<token>, netlify/functions/unsubscribe.mjs)
-- and one-click List-Unsubscribe headers.
--
-- No browser access at all: emails stay server-side (service role only). The admin page
-- talks to the Netlify function, which checks the Supabase admin session first.

create table if not exists nl_contacts (
  id               uuid primary key default gen_random_uuid(),
  email            text not null unique check (char_length(email) between 3 and 200 and email like '%@%' and email = lower(email)),
  name             text check (char_length(name) <= 160),
  source           text check (char_length(source) <= 120),   -- "pasted" | "portal-signup" | …
  token            uuid not null unique default gen_random_uuid(),   -- unsubscribe link key
  created_at       timestamptz not null default now(),
  unsubscribed_at  timestamptz,
  unsub_via        text check (char_length(unsub_via) <= 40),  -- link | one-click | manual
  bounced_at       timestamptz,
  complained_at    timestamptz
);

create table if not exists nl_campaigns (
  id            uuid primary key default gen_random_uuid(),
  subject       text not null check (char_length(subject) <= 200),
  source_path   text check (char_length(source_path) <= 200),  -- e.g. /newsletter/september-2026
  html_sha      text not null unique,     -- fingerprint of subject + exact HTML
  test_sent_at  timestamptz,
  test_sent_to  text,
  sent_at       timestamptz,
  created_at    timestamptz not null default now()
);

create table if not exists nl_sends (
  campaign_id   uuid not null references nl_campaigns(id) on delete cascade,
  contact_id    uuid not null references nl_contacts(id) on delete cascade,
  sent_at       timestamptz not null default now(),
  resend_id     text,
  error         text,
  primary key (campaign_id, contact_id)          -- nobody gets the same issue twice
);

alter table nl_contacts  enable row level security;
alter table nl_campaigns enable row level security;
alter table nl_sends     enable row level security;
-- (no policies: anon/authenticated get nothing; the service role bypasses RLS)

-- Designed issues (added 2026-11-17): the /send "Design an issue" tool writes here.
-- An admin gives instructions and/or a Word or Google Doc; Claude designs the email
-- (netlify/functions/newsletter-design-background.mjs) and saves it as a draft issue
-- that can be revised with more instructions, then tested and sent like any issue.
create table if not exists nl_issues (
  id          uuid primary key default gen_random_uuid(),
  title       text check (char_length(title) <= 200),
  subject     text check (char_length(subject) <= 200),
  preheader   text check (char_length(preheader) <= 300),
  html        text,                          -- the email body (no footer; the sender adds it)
  prev_html   text,                          -- the version before the latest revision (undo)
  prev_subject text,
  status      text not null default 'draft', -- draft | designing | ready | error
  error       text,
  pending     jsonb,                         -- the request being worked on: {instructions, doc}
  history     jsonb not null default '[]',   -- [{at, instructions, doc_name, notes}]
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table nl_issues enable row level security;
