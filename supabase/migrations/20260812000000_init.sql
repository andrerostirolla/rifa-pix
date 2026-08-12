-- RifaPIX initial schema
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  organizer_name text not null default 'Organizador',
  created_at timestamptz not null default now()
);

create table if not exists public.raffles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  ticket_price numeric(12,2) not null check (ticket_price > 0),
  total_numbers integer not null check (total_numbers > 0),
  prize text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  raffle_id uuid not null references public.raffles (id) on delete cascade,
  buyer_name text not null,
  buyer_phone text,
  numbers integer[] not null,
  total_amount numeric(12,2) not null check (total_amount >= 0),
  paid_amount numeric(12,2) not null default 0 check (paid_amount >= 0),
  status text not null default 'pendente' check (status in ('pendente', 'parcial', 'quitado', 'divergente')),
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.pix_payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  paid_at date not null,
  payer_name text not null,
  txid text,
  end_to_end_id text,
  notes text,
  allocated_amount numeric(12,2) not null default 0 check (allocated_amount >= 0),
  matched_sale_id uuid references public.sales (id) on delete set null,
  provider text not null default 'manual',
  raw_payload jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.amortizations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  sale_id uuid not null references public.sales (id) on delete cascade,
  pix_payment_id uuid not null references public.pix_payments (id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  note text,
  source text not null default 'manual' check (source in ('manual', 'webhook', 'auto')),
  created_at timestamptz not null default now()
);

create table if not exists public.pix_charges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  sale_id uuid not null references public.sales (id) on delete cascade,
  txid text not null unique,
  amount numeric(12,2) not null check (amount > 0),
  status text not null default 'pending' check (status in ('pending', 'paid', 'expired', 'cancelled')),
  copy_paste text,
  qr_code text,
  provider text not null default 'mock',
  provider_charge_id text,
  expires_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists raffles_user_id_idx on public.raffles (user_id);
create index if not exists sales_user_id_idx on public.sales (user_id);
create index if not exists sales_raffle_id_idx on public.sales (raffle_id);
create index if not exists pix_payments_user_id_idx on public.pix_payments (user_id);
create index if not exists pix_payments_txid_idx on public.pix_payments (txid);
create index if not exists amortizations_user_id_idx on public.amortizations (user_id);
create index if not exists pix_charges_sale_id_idx on public.pix_charges (sale_id);
create index if not exists pix_charges_txid_idx on public.pix_charges (txid);

create or replace function public.set_sale_status()
returns trigger
language plpgsql
as $$
begin
  if new.paid_amount <= 0 then
    new.status := 'pendente';
  elsif new.paid_amount + 0.001 < new.total_amount then
    new.status := 'parcial';
  elsif abs(new.paid_amount - new.total_amount) < 0.01 then
    new.status := 'quitado';
  else
    new.status := 'divergente';
  end if;
  return new;
end;
$$;

drop trigger if exists sales_set_status on public.sales;
create trigger sales_set_status
before insert or update of paid_amount, total_amount on public.sales
for each row execute function public.set_sale_status();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, organizer_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'organizer_name', split_part(new.email, '@', 1), 'Organizador')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

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

alter table public.profiles enable row level security;
alter table public.raffles enable row level security;
alter table public.sales enable row level security;
alter table public.pix_payments enable row level security;
alter table public.amortizations enable row level security;
alter table public.pix_charges enable row level security;

create policy "profiles_select_own" on public.profiles for select using (auth.uid() = id);
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = id);

create policy "raffles_all_own" on public.raffles for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "sales_all_own" on public.sales for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "pix_payments_all_own" on public.pix_payments for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "amortizations_all_own" on public.amortizations for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "pix_charges_all_own" on public.pix_charges for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
