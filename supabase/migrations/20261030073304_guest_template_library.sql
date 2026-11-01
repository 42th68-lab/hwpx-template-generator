-- Account-free sharing. Only the scoped Edge Function accesses these rows.
create table public.guest_templates (
  id uuid primary key,
  manage_hash text not null check (manage_hash ~ '^[0-9a-f]{64}$'),
  title text not null check (char_length(title) between 1 and 80),
  requirements text not null default '' check (char_length(requirements) <= 500),
  settings jsonb not null check (jsonb_typeof(settings) = 'object'),
  author_name text not null default '' check (char_length(author_name) <= 40),
  is_anonymous boolean not null default true,
  is_public boolean not null default false,
  file_path text not null,
  file_name text not null,
  version integer not null default 1 check (version > 0),
  history jsonb not null default '[]' check (jsonb_typeof(history) = 'array'),
  search_text text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.guest_templates enable row level security;
alter table public.guest_templates force row level security;
revoke all on public.guest_templates from public, anon, authenticated;
grant select, insert, update, delete on public.guest_templates to service_role;
create index guest_templates_public_recent_idx on public.guest_templates(updated_at desc, id) where is_public;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('hanform-shared','hanform-shared',false,2000000,array['application/hwp+zip']);
-- No anon/authenticated Storage policies: files are served through checked API operations.
