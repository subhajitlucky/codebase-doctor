do $$
begin
  execute 'alter table public.documents enable row level security';
end
$$;
