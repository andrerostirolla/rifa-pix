-- Optional helper: cheap freshness check for polling
create or replace function public.workspace_updated_at(p_code text)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  ts timestamptz;
begin
  select updated_at into ts
  from public.workspaces
  where upper(access_code) = upper(trim(p_code));

  if ts is null then
    raise exception 'Código do workspace inválido';
  end if;
  return ts;
end;
$$;

grant execute on function public.workspace_updated_at(text) to anon, authenticated;
