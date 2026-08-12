-- Workspace JSON sync for LocalApp (equipe, blocos, vendas, etc.)
create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null default 'RifaPIX',
  access_code text not null unique,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists workspaces_owner_id_idx on public.workspaces (owner_id);
create unique index if not exists workspaces_owner_unique on public.workspaces (owner_id);

alter table public.workspaces enable row level security;

drop policy if exists "workspaces_owner_all" on public.workspaces;
create policy "workspaces_owner_all"
  on public.workspaces
  for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create or replace function public.generate_access_code()
returns text
language plpgsql
as $$
declare
  chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  result text := '';
  i int;
begin
  for i in 1..6 loop
    result := result || substr(chars, 1 + floor(random() * length(chars))::int, 1);
  end loop;
  return result;
end;
$$;

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
begin
  if uid is null then
    raise exception 'Não autenticado';
  end if;

  select * into row from public.workspaces where owner_id = uid;
  if found then
    return row;
  end if;

  loop
    code := public.generate_access_code();
    begin
      insert into public.workspaces (owner_id, name, access_code, state)
      values (uid, coalesce(nullif(trim(p_name), ''), 'RifaPIX'), code, '{}'::jsonb)
      returning * into row;
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

create or replace function public.peek_workspace_members(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ws public.workspaces;
  members jsonb;
begin
  select * into ws
  from public.workspaces
  where upper(access_code) = upper(trim(p_code));

  if ws.id is null then
    raise exception 'Código do workspace inválido';
  end if;

  members := coalesce(
    (
      select jsonb_agg(jsonb_build_object('id', m->>'id', 'name', m->>'name') order by m->>'name')
      from jsonb_array_elements(coalesce(ws.state->'members', '[]'::jsonb)) as m
      where coalesce((m->>'active')::boolean, true)
    ),
    '[]'::jsonb
  );

  return jsonb_build_object(
    'workspaceId', ws.id,
    'name', ws.name,
    'updatedAt', ws.updated_at,
    'members', members
  );
end;
$$;

create or replace function public.member_open_workspace(p_code text, p_member_id text, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ws public.workspaces;
  m jsonb;
begin
  select * into ws
  from public.workspaces
  where upper(access_code) = upper(trim(p_code));

  if ws.id is null then
    raise exception 'Código do workspace inválido';
  end if;

  select x into m
  from jsonb_array_elements(coalesce(ws.state->'members', '[]'::jsonb)) as x
  where x->>'id' = p_member_id
    and coalesce((x->>'active')::boolean, true)
  limit 1;

  if m is null then
    raise exception 'Membro não encontrado';
  end if;

  if coalesce(m->>'pin', '') <> trim(p_pin) then
    raise exception 'PIN inválido';
  end if;

  return jsonb_build_object(
    'workspaceId', ws.id,
    'name', ws.name,
    'accessCode', ws.access_code,
    'updatedAt', ws.updated_at,
    'state', ws.state,
    'member', jsonb_build_object('id', m->>'id', 'name', m->>'name')
  );
end;
$$;

create or replace function public.save_workspace_by_code(
  p_code text,
  p_state jsonb,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ws public.workspaces;
begin
  select * into ws
  from public.workspaces
  where upper(access_code) = upper(trim(p_code))
  for update;

  if ws.id is null then
    raise exception 'Código do workspace inválido';
  end if;

  if p_expected_updated_at is not null and ws.updated_at > p_expected_updated_at then
    raise exception 'Dados desatualizados. Atualize e tente de novo.';
  end if;

  update public.workspaces
  set state = coalesce(p_state, '{}'::jsonb),
      updated_at = now()
  where id = ws.id
  returning * into ws;

  return jsonb_build_object(
    'workspaceId', ws.id,
    'updatedAt', ws.updated_at
  );
end;
$$;

create or replace function public.fetch_workspace_by_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ws public.workspaces;
begin
  select * into ws
  from public.workspaces
  where upper(access_code) = upper(trim(p_code));

  if ws.id is null then
    raise exception 'Código do workspace inválido';
  end if;

  return jsonb_build_object(
    'workspaceId', ws.id,
    'name', ws.name,
    'accessCode', ws.access_code,
    'updatedAt', ws.updated_at,
    'state', ws.state
  );
end;
$$;

grant execute on function public.ensure_my_workspace(text) to authenticated;
grant execute on function public.peek_workspace_members(text) to anon, authenticated;
grant execute on function public.member_open_workspace(text, text, text) to anon, authenticated;
grant execute on function public.save_workspace_by_code(text, jsonb, timestamptz) to anon, authenticated;
grant execute on function public.fetch_workspace_by_code(text) to anon, authenticated;
