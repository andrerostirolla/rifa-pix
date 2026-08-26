-- Cole e rode isto AGORA no SQL Editor (corrige display_name ambiguous)

create or replace function public.ensure_my_workspace(p_name text default 'RifaPIX')
returns public.workspaces
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  ws public.workspaces;
  code text;
  attempts int := 0;
  v_display_name text;
begin
  if uid is null then
    raise exception 'Não autenticado';
  end if;

  select w.* into ws
  from public.workspace_admins a
  join public.workspaces w on w.id = a.workspace_id
  where a.user_id = uid
  order by a.created_at asc
  limit 1;

  if found then
    return ws;
  end if;

  select * into ws from public.workspaces where owner_id = uid;
  if found then
    select a.display_name
      into v_display_name
      from public.workspace_admins a
     where a.workspace_id = ws.id
       and a.user_id = uid
     limit 1;

    v_display_name := coalesce(nullif(trim(p_name), ''), nullif(trim(v_display_name), ''), 'ADM');

    insert into public.workspace_admins (workspace_id, user_id, display_name, role, created_by)
    values (ws.id, uid, v_display_name, 'owner', uid)
    on conflict (workspace_id, user_id) do nothing;

    return ws;
  end if;

  loop
    code := public.generate_access_code();
    begin
      insert into public.workspaces (owner_id, name, access_code, state)
      values (uid, coalesce(nullif(trim(p_name), ''), 'RifaPIX'), code, '{}'::jsonb)
      returning * into ws;

      insert into public.workspace_admins (workspace_id, user_id, display_name, role, created_by)
      values (ws.id, uid, coalesce(nullif(trim(p_name), ''), 'ADM'), 'owner', uid);

      return ws;
    exception when unique_violation then
      attempts := attempts + 1;
      if attempts > 8 then
        raise;
      end if;
    end;
  end loop;
end;
$$;
