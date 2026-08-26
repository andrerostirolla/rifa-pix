-- Corrige paid_at ambiguo + espelha pixCharges no state.

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
  charges jsonb;
  updated_sales jsonb := '[]'::jsonb;
  updated_charges jsonb := '[]'::jsonb;
  s jsonb;
  c jsonb;
  sale_id text;
  total numeric;
  paid numeric;
  new_paid numeric;
  new_status text;
  v_paid_at timestamptz := coalesce(p_paid_at, now());
  found_charge boolean := false;
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
  charges := coalesce(ws.state->'pixCharges', '[]'::jsonb);

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
    updated_sales := updated_sales || jsonb_build_array(s);
  end loop;

  for c in select * from jsonb_array_elements(charges)
  loop
    if lower(coalesce(c->>'txid', '')) = lower(trim(p_txid))
       or (c->>'saleId' = sale_id and coalesce(c->>'status', '') = 'pending') then
      c := jsonb_set(c, '{status}', to_jsonb('paid'::text));
      c := jsonb_set(c, '{paidAt}', to_jsonb(v_paid_at));
      found_charge := true;
    end if;
    updated_charges := updated_charges || jsonb_build_array(c);
  end loop;

  if not found_charge then
    updated_charges := jsonb_build_array(
      jsonb_build_object(
        'id', ch.id,
        'saleId', sale_id,
        'txid', ch.txid,
        'amount', ch.amount,
        'status', 'paid',
        'createdAt', ch.created_at,
        'paidAt', v_paid_at,
        'copyPaste', ch.copy_paste,
        'provider', ch.provider
      )
    ) || updated_charges;
  end if;

  update public.workspaces
  set state = jsonb_set(
        jsonb_set(coalesce(state, '{}'::jsonb), '{sales}', updated_sales),
        '{pixCharges}', updated_charges
      ),
      updated_at = now()
  where id = p_workspace_id;

  update public.workspace_pix_charges ch_upd
  set status = 'paid',
      paid_at = v_paid_at
  where ch_upd.id = ch.id;

  return jsonb_build_object('ok', true, 'mode', 'paid', 'saleId', sale_id);
end;
$$;

grant execute on function public.apply_workspace_pix_payment(uuid, text, numeric, timestamptz) to service_role;

create or replace function public.list_workspace_pix_charges(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ws public.workspaces;
  rows jsonb;
begin
  select * into ws
  from public.workspaces
  where upper(access_code) = upper(trim(p_code));

  if ws.id is null then
    raise exception 'Código da equipe inválido';
  end if;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb)
  into rows
  from (
    select
      id,
      workspace_sale_id as "saleId",
      member_id as "memberId",
      txid,
      amount,
      status,
      copy_paste as "copyPaste",
      provider,
      expires_at as "expiresAt",
      paid_at as "paidAt",
      created_at as "createdAt"
    from public.workspace_pix_charges
    where workspace_id = ws.id
  ) t;

  return rows;
end;
$$;

grant execute on function public.list_workspace_pix_charges(text) to anon, authenticated, service_role;
