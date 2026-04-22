-- Fix: notes / doc / whatsapp uploads failing with
-- "new row violates row-level security policy" on storage.objects.
--
-- Root cause: Supabase auto-enables RLS on storage.objects for new projects,
-- and any default bucket policies created by the dashboard (e.g. "Give users
-- authenticated access to own folder") can coexist with — and shadow — our
-- permissive trip_uploads_* policies. Dropping all existing trip-uploads
-- bucket policies and recreating them as the only policies on the bucket
-- ensures the anon + authenticated roles can read/write freely.
--
-- Scope: anon + authenticated may INSERT/SELECT/UPDATE/DELETE any object in
-- the `trip-uploads` bucket. Security boundary is the unguessable trip_id
-- in the URL, matching the rest of the schema.

-- Make sure RLS is on (it already is by default, but explicit is safer).
alter table storage.objects enable row level security;

-- Drop any previously-created policies for this bucket (idempotent).
drop policy if exists "trip_uploads_insert" on storage.objects;
drop policy if exists "trip_uploads_select" on storage.objects;
drop policy if exists "trip_uploads_update" on storage.objects;
drop policy if exists "trip_uploads_delete" on storage.objects;

-- Also drop any common Supabase-default policies that target this bucket
-- by name (no-op if they don't exist). These are the ones the dashboard
-- creates automatically when you enable a bucket with "authenticated".
drop policy if exists "Give anon users access" on storage.objects;
drop policy if exists "Give users authenticated access to folder" on storage.objects;
drop policy if exists "Authenticated users can upload" on storage.objects;

create policy "trip_uploads_insert"
  on storage.objects for insert
  to anon, authenticated
  with check (bucket_id = 'trip-uploads');

create policy "trip_uploads_select"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'trip-uploads');

create policy "trip_uploads_update"
  on storage.objects for update
  to anon, authenticated
  using (bucket_id = 'trip-uploads')
  with check (bucket_id = 'trip-uploads');

create policy "trip_uploads_delete"
  on storage.objects for delete
  to anon, authenticated
  using (bucket_id = 'trip-uploads');
