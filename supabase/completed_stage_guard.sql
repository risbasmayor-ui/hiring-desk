-- Restrict new stage changes after completion while preserving existing earlier stages.
create or replace function public.hiring_guard_completed_assessment()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if jsonb_typeof(old.data -> 'completion') = 'object' then
    if new.data -> 'completion' is distinct from old.data -> 'completion'
      or new.data -> 'answers' is distinct from old.data -> 'answers'
      or new.data -> 'selectedQuestions' is distinct from old.data -> 'selectedQuestions'
      or new.data -> 'assessment' is distinct from old.data -> 'assessment'
      or new.data -> 'feedback' is distinct from old.data -> 'feedback' then
      raise exception 'Completed assessments are locked' using errcode = '23514';
    end if;
    if new.data -> 'stage' is distinct from old.data -> 'stage'
      and coalesce(new.data ->> 'stage', '') not in ('HR review', 'Closed') then
      raise exception 'Completed assessments may only move to HR review or Closed' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.hiring_guard_completed_assessment() from public;
