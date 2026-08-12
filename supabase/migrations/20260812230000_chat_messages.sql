-- Chat interno por workspace
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  author_role text not null check (author_role in ('admin', 'member')),
  author_member_id text,
  author_name text not null,
  body text not null check (char_length(trim(body)) > 0 and char_length(body) <= 2000),
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_workspace_created_idx
  on public.chat_messages (workspace_id, created_at desc);

alter table public.chat_messages enable row level security;

drop policy if exists "chat_owner_all" on public.chat_messages;
create policy "chat_owner_all"
  on public.chat_messages
  for all
  using (
    exists (
      select 1 from public.workspaces w
      where w.id = chat_messages.workspace_id
        and w.owner_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.workspaces w
      where w.id = chat_messages.workspace_id
        and w.owner_id = auth.uid()
    )
  );

create or replace function public.list_chat_messages(p_code text, p_limit integer default 120)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ws public.workspaces;
  lim integer := greatest(1, least(coalesce(p_limit, 120), 300));
  rows jsonb;
begin
  select * into ws
  from public.workspaces
  where upper(access_code) = upper(trim(p_code));

  if ws.id is null then
    raise exception 'Código do workspace inválido';
  end if;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at asc), '[]'::jsonb)
  into rows
  from (
    select
      id,
      workspace_id,
      author_role,
      author_member_id,
      author_name,
      body,
      created_at
    from public.chat_messages
    where workspace_id = ws.id
    order by created_at desc
    limit lim
  ) t;

  return jsonb_build_object(
    'workspaceId', ws.id,
    'messages', rows
  );
end;
$$;

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

grant execute on function public.list_chat_messages(text, integer) to anon, authenticated;
grant execute on function public.send_chat_message(text, text, text, text, text) to anon, authenticated;

alter table public.chat_messages replica identity full;

do $$
begin
  begin
    alter publication supabase_realtime add table public.chat_messages;
  exception
    when duplicate_object then null;
    when undefined_object then null;
  end;
end $$;
