create table public.documents (
  id uuid primary key,
  owner_id uuid not null
);

alter table public.documents enable row level security;
alter table public.documents force row level security;

create policy "users access own documents"
  on public.documents
  as restrictive
  for all
  to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());
