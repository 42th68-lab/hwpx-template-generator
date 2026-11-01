-- Store source requirements privately; reveal them only when explicitly opted in.
alter table public.guest_templates add column include_requirements boolean not null default false;
