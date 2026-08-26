-- Multi-ADM na mesma equipe + rastro de ações

create table if not exists public.workspace_admins (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  display_name text not null,
  role text not null default 'admin' check (role in ('owner', 'admin')),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);

create index if not exists workspace_admins_user_idx on public.workspace_admins (user_id);
create index if not exists workspace_admins_ws_idx on public.workspace_admins (workspace_id);

alter table public.workspace_admins enable row level security;

drop policy if exists "workspace_admins_select" on public.workspace_admins;
create policy "workspace_admins_select"
  on public.workspace_admins for select
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.workspaces w
      where w.id = workspace_id and w.owner_id = auth.uid()
    )
  );

create table if not exists public.workspace_audit_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  actor_user_id uuid,
  actor_name text not null,
  action text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists workspace_audit_ws_created_idx
  on public.workspace_audit_log (workspace_id, created_at desc);

alter table public.workspace_audit_log enable row level security;

drop policy if exists "workspace_audit_select" on public.workspace_audit_log;
create policy "workspace_audit_select"
  on public.workspace_audit_log for select
  using (
    exists (
      select 1 from public.workspaces w
      where w.id = workspace_id
        and (
          w.owner_id = auth.uid()
          or exists (
            select 1 from public.workspace_admins a
            where a.workspace_id = w.id and a.user_id = auth.uid()
          )
        )
    )
  );

-- Dono + ADMs auxiliares podem ler/gravar o workspace
drop policy if exists "workspaces_owner_all" on public.workspaces;
drop policy if exists "workspaces_admins_all" on public.workspaces;
create policy "workspaces_admins_all"
  on public.workspaces
  for all
  using (
    auth.uid() = owner_id
    or exists (
      select 1 from public.workspace_admins a
      where a.workspace_id = id and a.user_id = auth.uid()
    )
  )
  with check (
    auth.uid() = owner_id
    or exists (
      select 1 from public.workspace_admins a
      where a.workspace_id = id and a.user_id = auth.uid()
    )
  );

-- Ao abrir, se for ADM auxiliar retorna o workspace da equipe (não cria outro)
create or replace function public.ensure_my_workspace(p_name text default 'RifaPIX')
returns public.workspaces
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  row public.workspaces;
  code text;
  attempts int := 0;
  display_name text;
begin
  if uid is null then
    raise exception 'Não autenticado';
  end if;

  -- Já é colaborador de alguma equipe?
  select w.* into row
  from public.workspace_admins a
  join public.workspaces w on w.id = a.workspace_id
  where a.user_id = uid
  order by a.created_at asc
  limit 1;

  if found then
    return row;
  end if;

  -- Dono
  select * into row from public.workspaces where owner_id = uid;
  if found then
    -- garante linha owner em workspace_admins
    display_name := coalesce(
      nullif(trim(p_name), ''),
      (select display_name from public.workspace_admins where workspace_id = row.id and user_id = uid limit 1),
      'ADM'
    );
    insert into public.workspace_admins (workspace_id, user_id, display_name, role, created_by)
    values (row.id, uid, display_name, 'owner', uid)
    on conflict (workspace_id, user_id) do nothing;
    return row;
  end if;

  loop
    code := public.generate_access_code();
    begin
      insert into public.workspaces (owner_id, name, access_code, state)
      values (uid, coalesce(nullif(trim(p_name), ''), 'RifaPIX'), code, '{}'::jsonb)
      returning * into row;

      insert into public.workspace_admins (workspace_id, user_id, display_name, role, created_by)
      values (row.id, uid, coalesce(nullif(trim(p_name), ''), 'ADM'), 'owner', uid);

      return row;
    exception when unique_violation then
      attempts := attempts + 1;
      if attempts > 8 then
        raise;
      end if;
    end;
  end loop;
end;
$$;

create or replace function public.list_workspace_admins(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  rows jsonb;
begin
  if uid is null then
    raise exception 'Não autenticado';
  end if;

  if not exists (
    select 1 from public.workspaces w
    where w.id = p_workspace_id
      and (
        w.owner_id = uid
        or exists (select 1 from public.workspace_admins a where a.workspace_id = w.id and a.user_id = uid)
      )
  ) then
    raise exception 'Sem permissão';
  end if;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at), '[]'::jsonb)
  into rows
  from (
    select
      id,
      user_id as "userId",
      display_name as "displayName",
      role,
      created_at as "createdAt"
    from public.workspace_admins
    where workspace_id = p_workspace_id
  ) t;

  return rows;
end;
$$;

create or replace function public.append_workspace_audit(
  p_workspace_id uuid,
  p_actor_name text,
  p_action text,
  p_detail jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  new_id uuid;
begin
  if uid is null then
    raise exception 'Não autenticado';
  end if;

  if not exists (
    select 1 from public.workspaces w
    where w.id = p_workspace_id
      and (
        w.owner_id = uid
        or exists (select 1 from public.workspace_admins a where a.workspace_id = w.id and a.user_id = uid)
      )
  ) then
    raise exception 'Sem permissão';
  end if;

  insert into public.workspace_audit_log (workspace_id, actor_user_id, actor_name, action, detail)
  values (p_workspace_id, uid, coalesce(nullif(trim(p_actor_name), ''), 'ADM'), trim(p_action), coalesce(p_detail, '{}'::jsonb))
  returning id into new_id;

  return new_id;
end;
$$;

grant execute on function public.ensure_my_workspace(text) to authenticated;
grant execute on function public.list_workspace_admins(uuid) to authenticated;
grant execute on function public.append_workspace_audit(uuid, text, text, jsonb) to authenticated;
