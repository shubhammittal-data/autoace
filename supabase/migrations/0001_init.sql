-- ─── AutoAce schema ───────────────────────────────────────────────────────────
-- Run with the Supabase SQL editor or `supabase db push`.

create extension if not exists "pgcrypto";

-- One row per Xtime-enabled dealership (e.g., McGovern Subaru of Acton).
create table if not exists public.dealers (
    id                uuid primary key default gen_random_uuid(),
    slug              text unique not null,           -- e.g. 'mcgovernsubaruofacton'
    name              text not null,
    xtime_dealer_id   text not null,                  -- numeric id used in xws/rest URLs
    xtime_dealer_code text,                           -- short code if Xtime exposes one
    timezone          text not null default 'America/New_York',
    phone             text,
    created_at        timestamptz not null default now()
);

-- Audit log of every booking attempt the middleware brokers.
create table if not exists public.appointments (
    id                   uuid primary key default gen_random_uuid(),
    dealer_id            uuid not null references public.dealers(id) on delete cascade,
    retell_call_id       text,
    xtime_appointment_id text,
    customer_phone       text,
    customer_email       text,
    customer_first_name  text,
    customer_last_name   text,
    vehicle_year         int,
    vehicle_make         text,
    vehicle_model        text,
    service_requested    text,
    service_code         text,
    appointment_time     timestamptz,
    status               text not null default 'pending'
        check (status in ('pending', 'confirmed', 'failed')),
    raw_payload          jsonb,
    created_at           timestamptz not null default now()
);

create index if not exists appointments_dealer_idx on public.appointments(dealer_id);
create index if not exists appointments_phone_idx  on public.appointments(customer_phone);

-- Seed the demo dealer referenced in the implementation guide.
insert into public.dealers (slug, name, xtime_dealer_id, xtime_dealer_code, timezone, phone)
values (
    'mcgovernsubaruofacton',
    'McGovern Subaru of Acton',
    'xtm20220211107xx1',  -- alphanumeric Xtime dealer id; captured 2026-05-22
    'mcgovernsubaruofacton',
    'America/New_York',
    '+19785551234'
)
on conflict (slug) do nothing;
