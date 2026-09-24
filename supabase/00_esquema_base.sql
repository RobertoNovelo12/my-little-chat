-- Esquema base del chat para una base de datos nueva de Supabase.
-- Si ya ejecutaste el SQL base anterior, NO ejecutes de nuevo este archivo.
create extension if not exists pgcrypto;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nombre varchar(100) not null,
  apodo varchar(50),
  avatar_url text,
  esta_en_linea boolean not null default false,
  ultima_conexion timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.user_settings (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  tema varchar(20) not null default 'system' check (tema in ('light','dark','system')),
  notificaciones_activadas boolean not null default true,
  updated_at timestamptz not null default now()
);
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  tipo varchar(20) not null default 'direct' check (tipo in ('direct')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key(conversation_id,user_id)
);
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  tipo varchar(20) not null default 'text' check (tipo in ('text','file','audio')),
  contenido text,
  reply_to uuid references public.messages(id) on delete set null,
  eliminado boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.message_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  nombre_archivo varchar(255) not null,
  ruta_archivo text not null,
  mime_type varchar(100),
  tamano_bytes bigint,
  duracion_segundos integer,
  created_at timestamptz not null default now()
);
create table public.favorite_messages (
  user_id uuid not null references public.profiles(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(user_id,message_id)
);
create table public.message_reads (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key(message_id,user_id)
);
create index idx_messages_conversation on public.messages(conversation_id, created_at desc);
create index idx_messages_sender on public.messages(sender_id);
create index idx_conversation_members_user on public.conversation_members(user_id);
create index idx_favorite_messages_user on public.favorite_messages(user_id);
create index idx_message_attachments_message on public.message_attachments(message_id);

create or replace function public.update_updated_at_column()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end;
$$;
create trigger update_profiles_updated_at before update on public.profiles
for each row execute function public.update_updated_at_column();
create trigger update_user_settings_updated_at before update on public.user_settings
for each row execute function public.update_updated_at_column();
create trigger update_conversations_updated_at before update on public.conversations
for each row execute function public.update_updated_at_column();
create trigger update_messages_updated_at before update on public.messages
for each row execute function public.update_updated_at_column();

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id,nombre,apodo)
  values (new.id, coalesce(nullif(new.raw_user_meta_data ->> 'nombre',''), split_part(new.email,'@',1)), null);
  insert into public.user_settings(user_id) values(new.id);
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.user_settings enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.message_attachments enable row level security;
alter table public.favorite_messages enable row level security;
alter table public.message_reads enable row level security;

create policy "Usuarios pueden ver perfiles" on public.profiles for select to authenticated using (true);
create policy "Usuario puede actualizar su perfil" on public.profiles for update to authenticated
using (auth.uid()=id) with check (auth.uid()=id);
create policy "Usuario puede ver sus ajustes" on public.user_settings for select to authenticated using (auth.uid()=user_id);
create policy "Usuario puede actualizar sus ajustes" on public.user_settings for update to authenticated
using (auth.uid()=user_id) with check (auth.uid()=user_id);
create policy "Usuario puede ver sus conversaciones" on public.conversation_members for select to authenticated
using (auth.uid()=user_id);
create policy "Participante puede ver conversación" on public.conversations for select to authenticated
using (exists (select 1 from public.conversation_members cm where cm.conversation_id=conversations.id and cm.user_id=auth.uid()));
create policy "Participante puede ver mensajes" on public.messages for select to authenticated
using (exists (select 1 from public.conversation_members cm where cm.conversation_id=messages.conversation_id and cm.user_id=auth.uid()));
create policy "Participante puede enviar mensajes" on public.messages for insert to authenticated
with check (sender_id=auth.uid() and exists (select 1 from public.conversation_members cm where cm.conversation_id=messages.conversation_id and cm.user_id=auth.uid()));
create policy "Usuario puede modificar sus mensajes" on public.messages for update to authenticated
using (sender_id=auth.uid()) with check (sender_id=auth.uid());
create policy "Usuario puede ver sus favoritos" on public.favorite_messages for select to authenticated using (user_id=auth.uid());
create policy "Usuario puede agregar favoritos" on public.favorite_messages for insert to authenticated with check (user_id=auth.uid());
create policy "Usuario puede quitar favoritos" on public.favorite_messages for delete to authenticated using (user_id=auth.uid());
create policy "Usuario puede ver lecturas" on public.message_reads for select to authenticated
using (exists (select 1 from public.messages m join public.conversation_members cm on cm.conversation_id=m.conversation_id where m.id=message_reads.message_id and cm.user_id=auth.uid()));
create policy "Usuario puede marcar como leído" on public.message_reads for insert to authenticated with check (user_id=auth.uid());
