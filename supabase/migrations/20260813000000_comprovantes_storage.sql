-- Comprovantes fora do JSON do workspace (Storage)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'comprovantes',
  'comprovantes',
  true,
  5242880, -- 5 MB
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Leitura pública (URL direta do comprovante)
drop policy if exists "comprovantes_public_read" on storage.objects;
create policy "comprovantes_public_read"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'comprovantes');

-- Upload por ADM autenticado ou membro (anon com código no app)
drop policy if exists "comprovantes_upload" on storage.objects;
create policy "comprovantes_upload"
  on storage.objects for insert
  to anon, authenticated
  with check (bucket_id = 'comprovantes');

-- Update/overwrite do mesmo arquivo
drop policy if exists "comprovantes_update" on storage.objects;
create policy "comprovantes_update"
  on storage.objects for update
  to anon, authenticated
  using (bucket_id = 'comprovantes')
  with check (bucket_id = 'comprovantes');
