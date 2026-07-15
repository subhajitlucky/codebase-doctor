create table public.documents (
  id uuid primary key,
  owner_id uuid not null
);

grant select, insert, update, delete on table public.documents to authenticated;
