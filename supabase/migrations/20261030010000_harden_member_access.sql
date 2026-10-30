-- Endurece o acesso por código da equipe:
-- 1. PIN com limite de tentativas (5 erros = bloqueio de 15 min por membro)
-- 2. Chat: só ADM logado pode mandar mensagem como 'admin'
-- 3. ADM auxiliar não pode apagar a equipe (delete só do dono)
-- 4. Comprovantes: sem sobrescrever arquivo, e upload só em pasta de equipe existente
-- Rode no SQL Editor do Supabase.

-- 1. PIN -----------------------------------------------------------------

create table if not exists public.workspace_pin_attempts (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  member_id text not null,
  failed_count integer not null default 0,
  locked_until timestamptz,
  primary key (workspace_id, member_id)
);

alter table public.workspace_pin_attempts enable row level security;

-- Retorna null se o PIN confere, ou a mensagem de erro.
-- Não usa raise: um raise desfaria o contador de tentativas.
create or replace function public.check_member_pin(p_workspace_id uuid, p_state jsonb, p_member_id text, p_pin text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  m jsonb;
  att public.workspace_pin_attempts;
  v_count integer;
begin
  select * into att
  from public.workspace_pin_attempts
  where workspace_id = p_workspace_id and member_id = p_member_id
  for update;

  if att.locked_until is not null and att.locked_until > now() then
    return 'Muitas tentativas de PIN. Tente de novo em 15 minutos.';
  end if;

  select x into m
  from jsonb_array_elements(coalesce(p_state->'members', '[]'::jsonb)) as x
  where x->>'id' = p_member_id
    and coalesce((x->>'active')::boolean, true)
  limit 1;

  if m is null then
    return 'Membro não encontrado';
  end if;

  if coalesce(m->>'pin', '') <> '' and m->>'pin' = trim(coalesce(p_pin, '')) then
    delete from public.workspace_pin_attempts
    where workspace_id = p_workspace_id and member_id = p_member_id;
    return null;
  end if;

  -- bloqueio vencido recomeça a contagem
  v_count := case when att.locked_until is not null then 1 else coalesce(att.failed_count, 0) + 1 end;

  insert into public.workspace_pin_attempts (workspace_id, member_id, failed_count, locked_until)
  values (p_workspace_id, p_member_id, v_count, case when v_count >= 5 then now() + interval '15 minutes' end)
  on conflict (workspace_id, member_id) do update
    set failed_count = excluded.failed_count,
        locked_until = excluded.locked_until;

  if v_count >= 5 then
    return 'Muitas tentativas de PIN. Tente de novo em 15 minutos.';
  end if;
  return 'PIN inválido';
end;
$$;

revoke execute on function public.check_member_pin(uuid, jsonb, text, text) from public, anon, authenticated;

-- Erro de PIN volta como { "error": "..." } em vez de exception.
create or replace function public.member_open_workspace(p_code text, p_member_id text, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ws public.workspaces;
  m jsonb;
  err text;
begin
  select * into ws
  from public.workspaces
  where upper(access_code) = upper(trim(p_code));

  if ws.id is null then
    raise exception 'Código do workspace inválido';
  end if;

  err := public.check_member_pin(ws.id, ws.state, p_member_id, p_pin);
  if err is not null then
    return jsonb_build_object('error', err);
  end if;

  select x into m
  from jsonb_array_elements(coalesce(ws.state->'members', '[]'::jsonb)) as x
  where x->>'id' = p_member_id
  limit 1;

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

-- Retorna null quando o PIN não confere (as Edge Functions tratam como 401).
create or replace function public.verify_workspace_member_pin(
  p_code text,
  p_member_id text,
  p_pin text
)
returns uuid
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
    raise exception 'Código da equipe inválido';
  end if;

  if public.check_member_pin(ws.id, ws.state, p_member_id, p_pin) is not null then
    return null;
  end if;

  return ws.id;
end;
$$;

revoke execute on function public.verify_workspace_member_pin(text, text, text) from public, anon, authenticated;
grant execute on function public.verify_workspace_member_pin(text, text, text) to service_role;

-- 2. Chat ----------------------------------------------------------------

create or replace function public.send_chat_message(
  p_code text,
  p_author_name text,
  p_body text,
  p_author_role text default 'member',
  p_author_member_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ws public.workspaces;
  msg public.chat_messages;
  role text := lower(trim(coalesce(p_author_role, 'member')));
  clean_body text := trim(coalesce(p_body, ''));
  clean_name text := trim(coalesce(p_author_name, ''));
  member_ok boolean := false;
begin
  if clean_body = '' then
    raise exception 'Mensagem vazia';
  end if;
  if char_length(clean_body) > 2000 then
    raise exception 'Mensagem muito longa';
  end if;
  if clean_name = '' then
    raise exception 'Informe o nome';
  end if;
  if role not in ('admin', 'member') then
    raise exception 'Papel inválido';
  end if;

  select * into ws
  from public.workspaces
  where upper(access_code) = upper(trim(p_code));

  if ws.id is null then
    raise exception 'Código do workspace inválido';
  end if;

  if role = 'admin' then
    if auth.uid() is null or not (
      ws.owner_id = auth.uid()
      or exists (select 1 from public.workspace_admins a where a.workspace_id = ws.id and a.user_id = auth.uid())
    ) then
      raise exception 'Só ADM logado pode enviar como ADM';
    end if;
  end if;

  if role = 'member' then
    if p_author_member_id is null or trim(p_author_member_id) = '' then
      raise exception 'Membro inválido';
    end if;
    select exists (
      select 1
      from jsonb_array_elements(coalesce(ws.state->'members', '[]'::jsonb)) as m
      where m->>'id' = trim(p_author_member_id)
        and coalesce((m->>'active')::boolean, true)
    ) into member_ok;
    if not member_ok then
      raise exception 'Membro não encontrado neste workspace';
    end if;
  end if;

  insert into public.chat_messages (
    workspace_id,
    author_role,
    author_member_id,
    author_name,
    body
  )
  values (
    ws.id,
    role,
    case when role = 'member' then trim(p_author_member_id) else null end,
    clean_name,
    clean_body
  )
  returning * into msg;

  return to_jsonb(msg);
end;
$$;

-- 3. Workspaces: delete só do dono ---------------------------------------
-- A policy antiga consultava workspace_admins, cuja policy consulta workspaces:
-- recursão infinita, e o ADM auxiliar caía sempre no fallback por código.
-- A função security definer lê workspace_admins sem passar pelo RLS.

create or replace function public.is_workspace_admin(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_admins a
    where a.workspace_id = p_workspace_id and a.user_id = auth.uid()
  )
$$;

-- anon também avalia a policy (e recebe false), então precisa de EXECUTE
grant execute on function public.is_workspace_admin(uuid) to anon, authenticated, service_role;

drop policy if exists "workspaces_admins_all" on public.workspaces;
drop policy if exists "workspaces_admins_select" on public.workspaces;
drop policy if exists "workspaces_admins_update" on public.workspaces;
drop policy if exists "workspaces_owner_insert" on public.workspaces;
drop policy if exists "workspaces_owner_delete" on public.workspaces;

create policy "workspaces_admins_select"
  on public.workspaces for select
  using (
    auth.uid() = public.workspaces.owner_id
    or public.is_workspace_admin(public.workspaces.id)
  );

create policy "workspaces_admins_update"
  on public.workspaces for update
  using (
    auth.uid() = public.workspaces.owner_id
    or public.is_workspace_admin(public.workspaces.id)
  )
  with check (
    auth.uid() = public.workspaces.owner_id
    or public.is_workspace_admin(public.workspaces.id)
  );

create policy "workspaces_owner_insert"
  on public.workspaces for insert
  with check (auth.uid() = owner_id);

create policy "workspaces_owner_delete"
  on public.workspaces for delete
  using (auth.uid() = owner_id);

-- 4. Comprovantes --------------------------------------------------------

create or replace function public.workspace_exists(p_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.workspaces w where w.id::text = p_id)
$$;

grant execute on function public.workspace_exists(text) to anon, authenticated;

drop policy if exists "comprovantes_update" on storage.objects;
drop policy if exists "comprovantes_upload" on storage.objects;
create policy "comprovantes_upload"
  on storage.objects for insert
  to anon, authenticated
  with check (
    bucket_id = 'comprovantes'
    and public.workspace_exists((storage.foldername(name))[1])
  );
