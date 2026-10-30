-- Fecha RPCs de baixa que estavam abertas para anon/authenticated.
-- No Postgres, toda função nasce com EXECUTE para PUBLIC; o grant só para
-- service_role não tirava esse acesso. Sem isto, qualquer pessoa com a anon key
-- (que é pública no app) podia marcar cobranças como pagas.
-- Rode no SQL Editor do Supabase.

revoke execute on function public.apply_workspace_pix_payment(uuid, text, numeric, timestamptz)
  from public, anon, authenticated;
grant execute on function public.apply_workspace_pix_payment(uuid, text, numeric, timestamptz)
  to service_role;

-- amortize_sale_from_pix confiava no p_user_id enviado pelo cliente.
-- Agora só o próprio usuário (ou o service_role do webhook) pode amortizar.
create or replace function public.amortize_sale_from_pix(
  p_user_id uuid,
  p_sale_id uuid,
  p_pix_payment_id uuid,
  p_amount numeric,
  p_note text default null,
  p_source text default 'manual'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale public.sales%rowtype;
  v_pix public.pix_payments%rowtype;
  v_sale_open numeric;
  v_pix_open numeric;
begin
  if coalesce(auth.role(), '') <> 'service_role' and auth.uid() is distinct from p_user_id then
    raise exception 'Sem permissão';
  end if;

  select * into v_sale from public.sales where id = p_sale_id and user_id = p_user_id for update;
  select * into v_pix from public.pix_payments where id = p_pix_payment_id and user_id = p_user_id for update;

  if v_sale.id is null or v_pix.id is null then
    raise exception 'Venda ou PIX não encontrado';
  end if;

  v_sale_open := greatest(v_sale.total_amount - v_sale.paid_amount, 0);
  v_pix_open := greatest(v_pix.amount - v_pix.allocated_amount, 0);

  if p_amount <= 0 then
    raise exception 'Valor inválido';
  end if;
  if p_amount > v_sale_open + 0.009 then
    raise exception 'Venda sem saldo suficiente';
  end if;
  if p_amount > v_pix_open + 0.009 then
    raise exception 'PIX sem saldo suficiente';
  end if;

  insert into public.amortizations (user_id, sale_id, pix_payment_id, amount, note, source)
  values (p_user_id, p_sale_id, p_pix_payment_id, p_amount, p_note, coalesce(p_source, 'manual'));

  update public.sales
  set paid_amount = paid_amount + p_amount
  where id = p_sale_id;

  update public.pix_payments
  set
    allocated_amount = allocated_amount + p_amount,
    matched_sale_id = coalesce(matched_sale_id, p_sale_id)
  where id = p_pix_payment_id;
end;
$$;

revoke execute on function public.amortize_sale_from_pix(uuid, uuid, uuid, numeric, text, text)
  from public, anon;
grant execute on function public.amortize_sale_from_pix(uuid, uuid, uuid, numeric, text, text)
  to authenticated, service_role;

-- Só as Edge Functions (service_role) validam PIN; o app não chama direto.
revoke execute on function public.verify_workspace_member_pin(text, text, text)
  from public, anon, authenticated;
grant execute on function public.verify_workspace_member_pin(text, text, text)
  to service_role;
