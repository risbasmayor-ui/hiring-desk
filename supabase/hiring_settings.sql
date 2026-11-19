create table public.hiring_settings (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  revision bigint not null default 1
);
alter table public.hiring_settings enable row level security;
revoke all on public.hiring_settings from anon;
grant select, insert, update on public.hiring_settings to authenticated;
create policy hiring_settings_select on public.hiring_settings for select to authenticated using ((select auth.uid()) = owner_id);
create policy hiring_settings_insert on public.hiring_settings for insert to authenticated with check ((select auth.uid()) = owner_id);
create policy hiring_settings_update on public.hiring_settings for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
