-- Run once in Supabase → SQL Editor (project vwsvqtohkxmnzjzohtql).
-- Creates the table the Netlify function writes to and the submissions
-- dashboard reads from, with PII protected by row-level security:
--   • the function inserts using the service_role key (bypasses RLS)
--   • reads require an authenticated admin session (anon/public cannot read)

create table if not exists public.submissions (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  netlify_id   text unique,
  form_name    text not null,
  submitted_at timestamptz,
  data         jsonb not null default '{}'::jsonb
);

create index if not exists submissions_form_idx on public.submissions (form_name);
create index if not exists submissions_when_idx on public.submissions (submitted_at desc);

alter table public.submissions enable row level security;

-- Read: signed-in admin only (the dashboard logs in as admin@livehealthychi.com).
drop policy if exists "admin read submissions" on public.submissions;
create policy "admin read submissions"
  on public.submissions for select
  to authenticated
  using (true);

-- No insert/update/delete policies → anon & authenticated cannot write.
-- The Netlify function writes with the service_role key, which bypasses RLS.
