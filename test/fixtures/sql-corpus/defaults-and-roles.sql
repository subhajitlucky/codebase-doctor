-- Differential fixture: default privileges and role paths that only some
-- analyzers model statically.
create schema if not exists app;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_user') then
    create role app_user;
  end if;
end
$$;
create table app.items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  title text not null
);
grant usage on schema app to app_user;
grant select, truncate on app.items to app_user;
alter default privileges in schema app grant insert on tables to app_user;
alter table app.items enable row level security;
create policy "read all items"
  on app.items
  for select
  to public
  using (true);
