-- Hanform: new project, private ownership-only metadata and HWPX bucket.
create table public.document_forms (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 80),
  requirements text not null default '' check (char_length(requirements) <= 500),
  settings jsonb not null check (jsonb_typeof(settings) = 'object' and settings->>'schemaVersion' = '1'),
  file_path text,
  is_public boolean not null default false check (is_public = false),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint document_forms_own_path check (file_path is null or (split_part(file_path, '/', 1) = user_id::text and file_path !~ '\.\.'))
);
create index document_forms_owner_created_idx on public.document_forms(user_id, created_at desc);
alter table public.document_forms enable row level security;
alter table public.document_forms force row level security;
revoke all on public.document_forms from public, anon;
grant select, insert, update, delete on public.document_forms to authenticated;
create policy document_forms_select_own on public.document_forms for select to authenticated
  using ((select auth.uid()) = user_id and coalesce((select auth.jwt()->>'is_anonymous')::boolean, false) = false);
create policy document_forms_insert_own on public.document_forms for insert to authenticated
  with check ((select auth.uid()) = user_id and coalesce((select auth.jwt()->>'is_anonymous')::boolean, false) = false);
create policy document_forms_update_own on public.document_forms for update to authenticated
  using ((select auth.uid()) = user_id and coalesce((select auth.jwt()->>'is_anonymous')::boolean, false) = false)
  with check ((select auth.uid()) = user_id and coalesce((select auth.jwt()->>'is_anonymous')::boolean, false) = false);
create policy document_forms_delete_own on public.document_forms for delete to authenticated
  using ((select auth.uid()) = user_id and coalesce((select auth.jwt()->>'is_anonymous')::boolean, false) = false);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('hanform-private', 'hanform-private', false, 2000000, array['application/hwp+zip', 'application/octet-stream']);
create policy hanform_files_select_own on storage.objects for select to authenticated
  using (bucket_id = 'hanform-private' and (storage.foldername(name))[1] = (select auth.uid())::text
    and owner_id = (select auth.uid())::text and coalesce((select auth.jwt()->>'is_anonymous')::boolean, false) = false);
create policy hanform_files_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'hanform-private' and (storage.foldername(name))[1] = (select auth.uid())::text
    and owner_id = (select auth.uid())::text and coalesce((select auth.jwt()->>'is_anonymous')::boolean, false) = false);
create policy hanform_files_update_own on storage.objects for update to authenticated
  using (bucket_id = 'hanform-private' and (storage.foldername(name))[1] = (select auth.uid())::text and owner_id = (select auth.uid())::text)
  with check (bucket_id = 'hanform-private' and (storage.foldername(name))[1] = (select auth.uid())::text
    and owner_id = (select auth.uid())::text and coalesce((select auth.jwt()->>'is_anonymous')::boolean, false) = false);
create policy hanform_files_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'hanform-private' and (storage.foldername(name))[1] = (select auth.uid())::text
    and owner_id = (select auth.uid())::text and coalesce((select auth.jwt()->>'is_anonymous')::boolean, false) = false);
