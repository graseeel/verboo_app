create extension if not exists pgcrypto with schema extensions;

create table if not exists public.verboo_desktop_feedback (
  id uuid primary key default extensions.gen_random_uuid(),
  created_at timestamptz not null default now(),
  category text not null check (category in ('bug', 'feedback', 'question')),
  title text not null check (char_length(title) between 1 and 160),
  description text not null check (char_length(description) between 1 and 8000),
  contact text,
  app_version text,
  platform text,
  system_version text,
  diagnostics jsonb not null default '{}'::jsonb,
  source text not null default 'desktop',
  status text not null default 'new' check (status in ('new', 'triaged', 'closed'))
);

alter table public.verboo_desktop_feedback enable row level security;

revoke all on table public.verboo_desktop_feedback from anon;
revoke all on table public.verboo_desktop_feedback from authenticated;

comment on table public.verboo_desktop_feedback is 'Private inbox for independent Verboo Code desktop feedback.';
