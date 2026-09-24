-- Ejecutar UNA VEZ tras crear las dos cuentas en Authentication > Users.
-- Sustituye los dos correos; el bloque detiene la operación si no encuentra ambas.
do $$
declare
  first_id uuid;
  second_id uuid;
  chat_id uuid;
begin
  select id into first_id from auth.users where lower(email) = lower('persona1@ejemplo.com');
  select id into second_id from auth.users where lower(email) = lower('persona2@ejemplo.com');
  if first_id is null or second_id is null or first_id = second_id then
    raise exception 'Crea ambas cuentas y reemplaza sus correos en este archivo';
  end if;
  if not exists (select 1 from public.profiles where id = first_id)
     or not exists (select 1 from public.profiles where id = second_id) then
    raise exception 'Falta un perfil. Comprueba que el SQL base se ejecutó antes de crear las cuentas';
  end if;
  if exists (
    select 1 from public.conversation_members a
    join public.conversation_members b on b.conversation_id = a.conversation_id
    where a.user_id = first_id and b.user_id = second_id
  ) then
    raise notice 'Las cuentas ya comparten una conversación';
    return;
  end if;
  insert into public.conversations (tipo) values ('direct') returning id into chat_id;
  insert into public.conversation_members (conversation_id, user_id)
  values (chat_id, first_id), (chat_id, second_id);
  raise notice 'Conversación creada: %', chat_id;
end $$;
