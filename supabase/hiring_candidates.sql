create table public.hiring_candidates (
  owner_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (owner_id, id)
);
alter table public.hiring_candidates enable row level security;
revoke all on public.hiring_candidates from anon;
grant select, insert, update, delete on public.hiring_candidates to authenticated;
create policy hiring_candidates_select on public.hiring_candidates for select to authenticated using ((select auth.uid()) = owner_id);
create policy hiring_candidates_insert on public.hiring_candidates for insert to authenticated with check ((select auth.uid()) = owner_id);
create policy hiring_candidates_update on public.hiring_candidates for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy hiring_candidates_delete on public.hiring_candidates for delete to authenticated using ((select auth.uid()) = owner_id);
