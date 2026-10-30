-- Esconde os PINs dos membros e guarda histórico do estado da equipe.
-- Depende de 20261030010000_harden_member_access.sql (check_member_pin).
-- Rode no SQL Editor do Supabase.

-- Tira o campo pin de cada membro, menos do p_keep_member_id (se informado).
create or replace function public.strip_member_pins(p_state jsonb, p_keep_member_id text default null)
returns jsonb
language sql
immutable
as $$
  select case
    when jsonb_typeof(p_state->'members') = 'array' then
      jsonb_set(
        p_state,
        '{members}',
        coalesce(
          (
            select jsonb_agg(
              case when m->>'id' = p_keep_member_id then m else m - 'pin' end
              order by ord
            )
            from jsonb_array_elements(p_state->'members') with ordinality as t(m, ord)
          ),
          '[]'::jsonb
        )
      )
    else p_state
  end
$$;

-- Membro recebe o estado só com o próprio PIN (para entrar sem rede depois).
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
    'state', public.strip_member_pins(ws.state, p_member_id),
    'member', jsonb_build_object('id', m->>'id', 'name', m->>'name')
  );
end;
$$;

-- Leitura só com o código: nenhum PIN.
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
    'state', public.strip_member_pins(ws.state)
  );
end;
$$;

-- Gravação só com o código não mexe na lista de membros (nome, PIN, ativo):
-- isso é coisa do ADM, que grava pela tabela com login.
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
  next_state jsonb := coalesce(p_state, '{}'::jsonb);
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

  next_state := jsonb_set(next_state, '{members}', coalesce(ws.state->'members', '[]'::jsonb));

  update public.workspaces
  set state = next_state,
      updated_at = now()
  where id = ws.id
  returning * into ws;

  return jsonb_build_object(
    'workspaceId', ws.id,
    'updatedAt', ws.updated_at
  );
end;
$$;

-- Rede de segurança: qualquer gravação que chegue sem o PIN de um membro
-- (ex.: ADM que leu o estado pelo código) mantém o PIN que já estava salvo.
create or replace function public.keep_member_pins()
returns trigger
language plpgsql
as $$
begin
  if jsonb_typeof(new.state->'members') <> 'array' or jsonb_typeof(old.state->'members') <> 'array' then
    return new;
  end if;

  new.state := jsonb_set(
    new.state,
    '{members}',
    coalesce(
      (
        select jsonb_agg(
          case
            when coalesce(nm->>'pin', '') = '' and old_pin.pin is not null
              then nm || jsonb_build_object('pin', old_pin.pin)
            else nm
          end
          order by ord
        )
        from jsonb_array_elements(new.state->'members') with ordinality as t(nm, ord)
        left join lateral (
          select om->>'pin' as pin
          from jsonb_array_elements(old.state->'members') as om
          where om->>'id' = nm->>'id' and coalesce(om->>'pin', '') <> ''
          limit 1
        ) old_pin on true
      ),
      '[]'::jsonb
    )
  );
  return new;
end;
$$;

drop trigger if exists workspaces_keep_member_pins on public.workspaces;
create trigger workspaces_keep_member_pins
before update of state on public.workspaces
for each row execute function public.keep_member_pins();

-- Histórico: no máximo uma cópia a cada 5 minutos, guardando as últimas 200
-- por equipe (o app grava a cada mudança, então sem o intervalo 200 cópias
-- cobririam só alguns minutos de uso).
-- Para desfazer um apagão: SQL Editor, escolher a versão em workspace_state_history
-- e fazer update em workspaces.state com ela.
create table if not exists public.workspace_state_history (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  state jsonb not null,
  state_updated_at timestamptz,
  replaced_at timestamptz not null default now()
);

create index if not exists workspace_state_history_ws_idx
  on public.workspace_state_history (workspace_id, id desc);

alter table public.workspace_state_history enable row level security;

create or replace function public.archive_workspace_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.state is distinct from new.state
     and not exists (
       select 1 from public.workspace_state_history h
       where h.workspace_id = old.id and h.replaced_at > now() - interval '5 minutes'
     ) then
    insert into public.workspace_state_history (workspace_id, state, state_updated_at)
    values (old.id, old.state, old.updated_at);

    delete from public.workspace_state_history h
    where h.workspace_id = old.id
      and h.id not in (
        select id from public.workspace_state_history
        where workspace_id = old.id
        order by id desc
        limit 200
      );
  end if;
  return new;
end;
$$;

drop trigger if exists workspaces_archive_state on public.workspaces;
create trigger workspaces_archive_state
after update of state on public.workspaces
for each row execute function public.archive_workspace_state();
