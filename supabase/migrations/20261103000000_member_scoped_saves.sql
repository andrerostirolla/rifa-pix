-- Membro só grava as próprias vendas.
-- Antes, save_workspace_by_code aceitava o estado inteiro de quem tivesse o
-- código da equipe. Agora:
--   * ADM logado (dono ou auxiliar) grava o estado inteiro, como antes;
--   * membro precisa de um token de sessão (recebido ao entrar com PIN) e o
--     servidor mescla: só as vendas dele, as cobranças PIX dessas vendas e
--     novas linhas de auditoria. O resto vem do servidor.
-- Depende de 20261030020000_hide_member_pins.sql. Rode no SQL Editor.

-- Sessões de membro --------------------------------------------------------

create table if not exists public.workspace_member_sessions (
  token uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  member_id text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

create index if not exists workspace_member_sessions_ws_idx
  on public.workspace_member_sessions (workspace_id, member_id);

alter table public.workspace_member_sessions enable row level security;

-- Entrada do membro: igual à anterior + sessionToken.
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
  v_token uuid;
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

  -- sessões antigas (60 dias sem uso) saem
  delete from public.workspace_member_sessions
  where last_used_at < now() - interval '60 days';

  insert into public.workspace_member_sessions (workspace_id, member_id)
  values (ws.id, p_member_id)
  returning token into v_token;

  return jsonb_build_object(
    'workspaceId', ws.id,
    'name', ws.name,
    'accessCode', ws.access_code,
    'updatedAt', ws.updated_at,
    'state', public.strip_member_pins(ws.state, p_member_id),
    'member', jsonb_build_object('id', m->>'id', 'name', m->>'name'),
    'sessionToken', v_token
  );
end;
$$;

-- Mescla -------------------------------------------------------------------

create or replace function public.is_store_pix(s jsonb)
returns boolean
language sql
immutable
as $$
  select coalesce(s->>'paymentMethod', '') = 'pix'
     and coalesce(s->>'pixDestination', 'entidade') = 'entidade'
$$;

-- Venda do membro como o cliente mandou, com os campos que só o servidor
-- ou o ADM controlam vindos de p_server (null = venda nova).
create or replace function public.guard_member_sale(p_client jsonb, p_server jsonb, p_member_id text)
returns jsonb
language plpgsql
immutable
as $$
declare
  s jsonb := p_client || jsonb_build_object('memberId', p_member_id);
begin
  -- PIX na conta da loja: pago/status só pelo servidor (webhook / consulta Sicoob)
  if public.is_store_pix(s) or (p_server is not null and public.is_store_pix(p_server)) then
    if p_server is null then
      s := s || jsonb_build_object('paidAmount', 0, 'status', 'pendente');
    else
      s := s || jsonb_build_object(
        'paidAmount', coalesce(p_server->'paidAmount', '0'::jsonb),
        'status', coalesce(p_server->'status', '"pendente"'::jsonb),
        'paymentMethod', p_server->'paymentMethod'
      );
      if p_server ? 'pixDestination' then
        s := s || jsonb_build_object('pixDestination', p_server->'pixDestination');
      else
        s := s - 'pixDestination';
      end if;
    end if;
  end if;

  -- Prestação de contas é do ADM
  s := s - 'cashSettledAt' - 'cashSettlementNote';
  if p_server is not null and p_server ? 'cashSettledAt' then
    s := s || jsonb_build_object('cashSettledAt', p_server->'cashSettledAt');
  end if;
  if p_server is not null and p_server ? 'cashSettlementNote' then
    s := s || jsonb_build_object('cashSettlementNote', p_server->'cashSettlementNote');
  end if;

  return s;
end;
$$;

create or replace function public.merge_member_state(p_server jsonb, p_client jsonb, p_member_id text)
returns jsonb
language plpgsql
immutable
as $$
declare
  srv_sales jsonb := coalesce(p_server->'sales', '[]'::jsonb);
  cli_sales jsonb := coalesce(p_client->'sales', '[]'::jsonb);
  srv_charges jsonb := coalesce(p_server->'pixCharges', '[]'::jsonb);
  cli_charges jsonb := coalesce(p_client->'pixCharges', '[]'::jsonb);
  out_sales jsonb := '[]'::jsonb;
  new_sales jsonb := '[]'::jsonb;
  out_charges jsonb := '[]'::jsonb;
  new_charges jsonb := '[]'::jsonb;
  my_sale_ids text[];
  s jsonb;
  c jsonb;
  srv jsonb;
  cli jsonb;
  srv_ids text[];
  result jsonb;
begin
  if jsonb_typeof(srv_sales) <> 'array' then srv_sales := '[]'::jsonb; end if;
  if jsonb_typeof(cli_sales) <> 'array' then cli_sales := '[]'::jsonb; end if;
  if jsonb_typeof(srv_charges) <> 'array' then srv_charges := '[]'::jsonb; end if;
  if jsonb_typeof(cli_charges) <> 'array' then cli_charges := '[]'::jsonb; end if;

  -- Vendas que já estão no servidor
  for s in select x from jsonb_array_elements(srv_sales) as x
  loop
    if s->>'memberId' = p_member_id then
      select x into cli from jsonb_array_elements(cli_sales) as x where x->>'id' = s->>'id' limit 1;
      if cli is null then
        -- membro só apaga venda PIX própria que não recebeu nada (PIX que falhou
        -- ao gerar); qualquer outra ausente fica, para cópia velha não apagar venda
        if not public.is_store_pix(s) or coalesce((s->>'paidAmount')::numeric, 0) > 0 then
          out_sales := out_sales || jsonb_build_array(s);
        end if;
      else
        out_sales := out_sales || jsonb_build_array(public.guard_member_sale(cli, s, p_member_id));
      end if;
    else
      out_sales := out_sales || jsonb_build_array(s);
    end if;
  end loop;

  -- Vendas novas: só as do próprio membro
  select coalesce(array_agg(x->>'id'), '{}') into srv_ids from jsonb_array_elements(srv_sales) as x;
  for cli in select x from jsonb_array_elements(cli_sales) as x
  loop
    if cli->>'memberId' = p_member_id and not (cli->>'id' = any (srv_ids)) then
      new_sales := new_sales || jsonb_build_array(public.guard_member_sale(cli, null, p_member_id));
    end if;
  end loop;

  out_sales := new_sales || out_sales;

  select coalesce(array_agg(x->>'id'), '{}') into my_sale_ids
  from jsonb_array_elements(out_sales) as x
  where x->>'memberId' = p_member_id;

  -- Cobranças PIX: o membro só mexe nas das próprias vendas e nunca marca como paga
  for srv in select x from jsonb_array_elements(srv_charges) as x
  loop
    if srv->>'saleId' = any (my_sale_ids) then
      select x into cli from jsonb_array_elements(cli_charges) as x where x->>'id' = srv->>'id' limit 1;
      if cli is null or srv->>'status' = 'paid' then
        out_charges := out_charges || jsonb_build_array(srv);
      elsif cli->>'status' = 'paid' then
        out_charges := out_charges || jsonb_build_array((cli || jsonb_build_object('status', srv->'status')) - 'paidAt');
      else
        out_charges := out_charges || jsonb_build_array(cli || jsonb_build_object('saleId', srv->'saleId'));
      end if;
    else
      out_charges := out_charges || jsonb_build_array(srv);
    end if;
  end loop;

  select coalesce(array_agg(x->>'id'), '{}') into srv_ids from jsonb_array_elements(srv_charges) as x;
  for cli in select x from jsonb_array_elements(cli_charges) as x
  loop
    if cli->>'saleId' = any (my_sale_ids) and not (cli->>'id' = any (srv_ids)) then
      if cli->>'status' = 'paid' then
        cli := (cli || jsonb_build_object('status', 'pending')) - 'paidAt';
      end if;
      new_charges := new_charges || jsonb_build_array(cli);
    end if;
  end loop;

  out_charges := new_charges || out_charges;

  result := jsonb_set(p_server, '{sales}', out_sales);
  result := jsonb_set(result, '{pixCharges}', out_charges);

  -- Auditoria: só acrescenta linhas novas (no topo, como o app faz), até 5000
  if jsonb_typeof(p_client->'auditLog') = 'array' then
    result := jsonb_set(
      result,
      '{auditLog}',
      (
        select coalesce(jsonb_agg(e order by grp, ord), '[]'::jsonb)
        from (
          select e, grp, ord from (
            select x as e, 0 as grp, ord
            from jsonb_array_elements(p_client->'auditLog') with ordinality as t(x, ord)
            where not exists (
              select 1 from jsonb_array_elements(coalesce(p_server->'auditLog', '[]'::jsonb)) as y
              where y->>'id' = x->>'id'
            )
            union all
            select x, 1, ord
            from jsonb_array_elements(coalesce(p_server->'auditLog', '[]'::jsonb)) with ordinality as t(x, ord)
          ) u
          order by grp, ord
          limit 5000
        ) lim
      )
    );
  end if;

  return result;
end;
$$;

-- Gravação por código -------------------------------------------------------

drop function if exists public.save_workspace_by_code(text, jsonb, timestamptz);

create or replace function public.save_workspace_by_code(
  p_code text,
  p_state jsonb,
  p_expected_updated_at timestamptz default null,
  p_member_id text default null,
  p_session_token uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ws public.workspaces;
  next_state jsonb := coalesce(p_state, '{}'::jsonb);
  is_admin boolean;
  sess public.workspace_member_sessions;
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

  is_admin := auth.uid() is not null and (ws.owner_id = auth.uid() or public.is_workspace_admin(ws.id));

  if is_admin then
    -- ADM: estado inteiro (o trigger keep_member_pins preserva PINs omitidos)
    null;
  else
    select * into sess
    from public.workspace_member_sessions
    where token = p_session_token
      and workspace_id = ws.id
      and member_id = p_member_id;

    if sess.token is null then
      raise exception 'Sessão do membro expirada. Saia e entre de novo com o PIN.';
    end if;

    if not exists (
      select 1 from jsonb_array_elements(coalesce(ws.state->'members', '[]'::jsonb)) as m
      where m->>'id' = p_member_id and coalesce((m->>'active')::boolean, true)
    ) then
      raise exception 'Membro inativo ou removido.';
    end if;

    update public.workspace_member_sessions set last_used_at = now() where token = sess.token;

    next_state := public.merge_member_state(ws.state, next_state, p_member_id);
  end if;

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

grant execute on function public.save_workspace_by_code(text, jsonb, timestamptz, text, uuid) to anon, authenticated;
revoke execute on function public.merge_member_state(jsonb, jsonb, text) from public, anon, authenticated;
revoke execute on function public.guard_member_sale(jsonb, jsonb, text) from public, anon, authenticated;
