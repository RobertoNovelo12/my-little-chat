-- Ejecuta este complemento DESPUÉS del esquema de chat compartido anteriormente.
-- No crea cuentas: créalas manualmente en Authentication > Users.

alter table public.conversation_members
  add column if not exists cleared_at timestamptz;

-- Obtener únicamente la conversación privada que corresponde a la sesión.
create or replace function public.get_my_chat()
returns table (
  conversation_id uuid,
  other_id uuid,
  other_nombre text,
  other_apodo text,
  cleared_at timestamptz
)
language sql stable security definer set search_path = ''
as $$
  select mine.conversation_id, peer.id, peer.nombre::text, peer.apodo::text, mine.cleared_at
  from public.conversation_members mine
  join public.conversations c on c.id = mine.conversation_id and c.tipo = 'direct'
  join public.conversation_members theirs on theirs.conversation_id = mine.conversation_id and theirs.user_id <> mine.user_id
  join public.profiles peer on peer.id = theirs.user_id
  where mine.user_id = (select auth.uid())
  order by c.created_at
  limit 1;
$$;
revoke all on function public.get_my_chat() from public, anon;
grant execute on function public.get_my_chat() to authenticated;

-- Solo mueve el punto a partir del cual ESTA persona ve mensajes.
create or replace function public.clear_my_chat(p_conversation_id uuid)
returns timestamptz
language plpgsql security definer set search_path = ''
as $$
declare v_cleared timestamptz;
begin
  if (select auth.uid()) is null then raise exception 'Se requiere iniciar sesión'; end if;
  update public.conversation_members
     set cleared_at = clock_timestamp()
   where conversation_id = p_conversation_id and user_id = (select auth.uid())
   returning cleared_at into v_cleared;
  if v_cleared is null then raise exception 'Conversación no disponible'; end if;
  return v_cleared;
end;
$$;
revoke all on function public.clear_my_chat(uuid) from public, anon;
grant execute on function public.clear_my_chat(uuid) to authenticated;

-- El esquema inicial habilitaba RLS para adjuntos, pero no tenía políticas.
create policy "Participantes pueden ver adjuntos"
on public.message_attachments for select to authenticated
using (exists (
  select 1 from public.messages m
  join public.conversation_members cm on cm.conversation_id = m.conversation_id
  where m.id = message_id and cm.user_id = (select auth.uid())
));

create policy "Autor puede adjuntar a su mensaje"
on public.message_attachments for insert to authenticated
with check (exists (
  select 1 from public.messages m
  join public.conversation_members cm on cm.conversation_id = m.conversation_id
  where m.id = message_id
    and m.sender_id = (select auth.uid())
    and cm.user_id = (select auth.uid())
    and ruta_archivo like m.conversation_id::text || '/' || (select auth.uid())::text || '/%'
));

-- Reemplaza políticas demasiado amplias del ejemplo inicial.
drop policy if exists "Usuario puede modificar sus mensajes" on public.messages;
create policy "Autor puede editar mensajes en su chat"
on public.messages for update to authenticated
using (sender_id = (select auth.uid()) and exists (
  select 1 from public.conversation_members cm
  where cm.conversation_id = messages.conversation_id and cm.user_id = (select auth.uid())
))
with check (sender_id = (select auth.uid()) and exists (
  select 1 from public.conversation_members cm
  where cm.conversation_id = messages.conversation_id and cm.user_id = (select auth.uid())
));

drop policy if exists "Usuario puede agregar favoritos" on public.favorite_messages;
create policy "Favoritos de mensajes de mi chat"
on public.favorite_messages for insert to authenticated
with check (user_id = (select auth.uid()) and exists (
  select 1 from public.messages m
  join public.conversation_members cm on cm.conversation_id = m.conversation_id
  where m.id = message_id and cm.user_id = (select auth.uid())
));

drop policy if exists "Usuario puede marcar como leído" on public.message_reads;
create policy "Lecturas de mensajes de mi chat"
on public.message_reads for insert to authenticated
with check (user_id = (select auth.uid()) and exists (
  select 1 from public.messages m
  join public.conversation_members cm on cm.conversation_id = m.conversation_id
  where m.id = message_id and cm.user_id = (select auth.uid())
));

-- Bucket privado: un miembro sube en /conversacion/usuario/archivo.
insert into storage.buckets (id, name, public, file_size_limit)
values ('chat-attachments', 'chat-attachments', false, 20971520)
on conflict (id) do update set public = false, file_size_limit = 20971520;

create policy "Miembros pueden leer archivos del chat"
on storage.objects for select to authenticated
using (bucket_id = 'chat-attachments' and exists (
  select 1 from public.conversation_members cm
  where cm.conversation_id::text = split_part(name, '/', 1)
    and cm.user_id = (select auth.uid())
));

create policy "Miembros suben sus propios archivos"
on storage.objects for insert to authenticated
with check (bucket_id = 'chat-attachments'
  and split_part(name, '/', 2) = (select auth.uid())::text
  and split_part(name, '/', 3) <> ''
  and split_part(name, '/', 4) = ''
  and exists (
    select 1 from public.conversation_members cm
    where cm.conversation_id::text = split_part(name, '/', 1)
      and cm.user_id = (select auth.uid())
  ));

create policy "Autor retira archivo fallido"
on storage.objects for delete to authenticated
using (bucket_id = 'chat-attachments'
  and split_part(name, '/', 2) = (select auth.uid())::text
  and exists (
    select 1 from public.conversation_members cm
    where cm.conversation_id::text = split_part(name, '/', 1)
      and cm.user_id = (select auth.uid())
  ));

-- Mensaje y metadatos se guardan en la misma transacción.
create or replace function public.create_attachment_message(
  p_conversation_id uuid,
  p_tipo text,
  p_nombre_archivo text,
  p_ruta_archivo text,
  p_mime_type text,
  p_tamano_bytes bigint
)
returns uuid
language plpgsql security invoker set search_path = ''
as $$
declare v_message_id uuid;
begin
  if (select auth.uid()) is null or p_tipo not in ('file','audio')
    or p_nombre_archivo is null or length(p_nombre_archivo) not between 1 and 255
    or p_tamano_bytes is null or p_tamano_bytes < 1 or p_tamano_bytes > 20971520
    or p_ruta_archivo not like p_conversation_id::text || '/' || (select auth.uid())::text || '/%'
    or split_part(p_ruta_archivo, '/', 4) <> ''
    or not exists (select 1 from storage.objects so
      where so.bucket_id = 'chat-attachments' and so.name = p_ruta_archivo)
  then raise exception 'Adjunto inválido'; end if;
  insert into public.messages (conversation_id, sender_id, tipo)
  values (p_conversation_id, (select auth.uid()), p_tipo)
  returning id into v_message_id;
  insert into public.message_attachments
    (message_id, nombre_archivo, ruta_archivo, mime_type, tamano_bytes)
  values (v_message_id, p_nombre_archivo, p_ruta_archivo, p_mime_type, p_tamano_bytes);
  return v_message_id;
end;
$$;
revoke all on function public.create_attachment_message(uuid,text,text,text,text,bigint) from public, anon;
grant execute on function public.create_attachment_message(uuid,text,text,text,text,bigint) to authenticated;

-- Realtime de mensajes (las políticas SELECT existentes filtran el acceso).
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages') then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;
