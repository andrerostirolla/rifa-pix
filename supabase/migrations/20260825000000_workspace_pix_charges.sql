-- Cobranças PIX de vendas do workspace (membros) — baixa via webhook por TXID.

create table if not exists public.workspace_pix_charges (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  workspace_sale_id text not null,
  member_id text,
  txid text not null unique,
  amount numeric(12,2) not null check (amount > 0),
  status text not null default 'pending' check (status in ('pending', 'paid', 'expired', 'cancelled')),
  copy_paste text,
  provider text not null default 'mock',
  expires_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists workspace_pix_charges_ws_sale_idx
  on public.workspace_pix_charges (workspace_id, workspace_sale_id);

alter table public.workspace_pix_charges enable row level security;

drop policy if exists "workspace_pix_charges_service" on public.workspace_pix_charges;
create policy "workspace_pix_charges_service"
  on public.workspace_pix_charges
  for all
  using (false)
  with check (false);

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
  m jsonb;
begin
  select * into ws
  from public.workspaces
  where upper(access_code) = upper(trim(p_code));

  if ws.id is null then
    raise exception 'Código da equipe inválido';
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

  return ws.id;
end;
$$;

create or replace function public.apply_workspace_pix_payment(
  p_workspace_id uuid,
  p_txid text,
  p_amount numeric,
  p_paid_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ch public.workspace_pix_charges;
  ws public.workspaces;
  sales jsonb;
  updated jsonb := '[]'::jsonb;
  s jsonb;
  sale_id text;
  total numeric;
  paid numeric;
  new_paid numeric;
  new_status text;
begin
  select * into ch
  from public.workspace_pix_charges
  where workspace_id = p_workspace_id
    and lower(txid) = lower(trim(p_txid))
  for update;

  if ch.id is null then
    return jsonb_build_object('ok', false, 'error', 'cobrança não encontrada');
  end if;

  if ch.status = 'paid' then
    return jsonb_build_object('ok', true, 'mode', 'already_paid', 'saleId', ch.workspace_sale_id);
  end if;

  select * into ws from public.workspaces where id = p_workspace_id for update;
  if ws.id is null then
    return jsonb_build_object('ok', false, 'error', 'workspace não encontrado');
  end if;

  sale_id := ch.workspace_sale_id;
  sales := coalesce(ws.state->'sales', '[]'::jsonb);

  for s in select * from jsonb_array_elements(sales)
  loop
    if s->>'id' = sale_id then
      total := coalesce((s->>'totalAmount')::numeric, 0);
      paid := coalesce((s->>'paidAmount')::numeric, 0);
      new_paid := least(total, paid + coalesce(p_amount, ch.amount));
      if new_paid <= 0 then
        new_status := 'pendente';
      elsif new_paid + 0.001 < total then
        new_status := 'parcial';
      else
        new_status := 'quitado';
      end if;
      s := jsonb_set(s, '{paidAmount}', to_jsonb(new_paid));
      s := jsonb_set(s, '{status}', to_jsonb(new_status));
    end if;
    updated := updated || jsonb_build_array(s);
  end loop;

  update public.workspaces
  set state = jsonb_set(coalesce(state, '{}'::jsonb), '{sales}', updated),
      updated_at = now()
  where id = p_workspace_id;

  update public.workspace_pix_charges
  set status = 'paid', paid_at = coalesce(p_paid_at, now())
  where id = ch.id;

  return jsonb_build_object('ok', true, 'mode', 'paid', 'saleId', sale_id);
end;
$$;

grant execute on function public.verify_workspace_member_pin(text, text, text) to anon, authenticated, service_role;
grant execute on function public.apply_workspace_pix_payment(uuid, text, numeric, timestamptz) to service_role;
