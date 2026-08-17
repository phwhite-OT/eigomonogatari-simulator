-- キャラ図鑑の公開データ差分。閲覧は公開、追加・編集・削除は管理者だけに限定する。
create table if not exists public.character_catalog_overrides (
  id text primary key,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null default auth.uid(),
  updated_by uuid not null default auth.uid(),
  constraint character_catalog_overrides_payload_object check (jsonb_typeof(payload) = 'object')
);

alter table public.character_catalog_overrides enable row level security;

grant select on table public.character_catalog_overrides to anon, authenticated;
grant insert, update on table public.character_catalog_overrides to authenticated;
revoke delete on table public.character_catalog_overrides from anon, authenticated;

drop policy if exists "Character catalogue is publicly readable" on public.character_catalog_overrides;
create policy "Character catalogue is publicly readable"
  on public.character_catalog_overrides
  for select
  using (true);

drop policy if exists "Only the administrator can add characters" on public.character_catalog_overrides;
create policy "Only the administrator can add characters"
  on public.character_catalog_overrides
  for insert
  to authenticated
  with check (
    lower(coalesce(auth.jwt() ->> 'email', '')) = 'justdoittakama1029@gmail.com'
    and created_by = auth.uid()
    and updated_by = auth.uid()
  );

drop policy if exists "Only the administrator can edit characters" on public.character_catalog_overrides;
create policy "Only the administrator can edit characters"
  on public.character_catalog_overrides
  for update
  to authenticated
  using (lower(coalesce(auth.jwt() ->> 'email', '')) = 'justdoittakama1029@gmail.com')
  with check (
    lower(coalesce(auth.jwt() ->> 'email', '')) = 'justdoittakama1029@gmail.com'
    and created_by = auth.uid()
    and updated_by = auth.uid()
  );

drop policy if exists "Only the administrator can delete characters" on public.character_catalog_overrides;
