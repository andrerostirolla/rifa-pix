-- Enable Realtime so ADM clients get workspace updates live
alter table public.workspaces replica identity full;

do $$
begin
  begin
    alter publication supabase_realtime add table public.workspaces;
  exception
    when duplicate_object then null;
    when undefined_object then null;
  end;
end $$;
