import { createClient } from '@supabase/supabase-js';

const $ = (id) => document.getElementById(id);
const cfg = {
  url: import.meta.env.VITE_SUPABASE_URL?.trim(),
  publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()
};
const configured = /^https:\/\/[^/]+\.supabase\.co\/?$/.test(cfg.url || '')
  && !cfg.url.includes('TU-PROYECTO')
  && cfg.publishableKey?.startsWith('sb_publishable_')
  && !cfg.publishableKey.includes('TU_CLAVE');
const db = configured ? createClient(cfg.url, cfg.publishableKey) : null;
const state = { user: null, profile: null, settings: null, chatId: null, peer: null, clearedAt: null, messages: [], favoriteIds: new Set(), replyTo: null, renderSignature: null, channel: null, poll: null, recorder: null, stream: null, chunks: [], loading: false };
let toastTimeout, refreshSerial = 0;

function notify(message) { const el = $('toast'); el.textContent = message; el.hidden = false; clearTimeout(toastTimeout); toastTimeout = setTimeout(() => el.hidden = true, 4200); }
function errorMessage(error) { return error?.message || 'Ocurrió un error. Inténtalo de nuevo.'; }
function initials(name) { return (name || '?').trim().slice(0, 1).toLocaleUpperCase('es'); }
function nameOf(profile) { return profile?.apodo?.trim() || profile?.nombre || 'Contacto'; }
function applyTheme(theme) { const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches); document.body.dataset.theme = dark ? 'dark' : 'light'; }
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(state.settings?.tema || 'system'));
function showScreen(which) {
  $('login-screen').hidden = which !== 'login'; $('app-screen').hidden = which === 'login';
  $('chat-screen').hidden = which !== 'chat'; $('settings-screen').hidden = which !== 'settings';
  document.querySelectorAll('[data-go]').forEach(el => el.classList.toggle('active', el.dataset.go === which));
  if (which === 'chat') requestAnimationFrame(() => { $('messages').scrollTop = $('messages').scrollHeight; });
}
function setNotice(text) { $('chat-notice').textContent = text; $('chat-notice').hidden = !text; }
function setMenu(open) { $('menu').hidden = !open; $('menu-button').setAttribute('aria-expanded', String(open)); }
function snippetOf(message) {
  if (message.tipo === 'audio') return 'Nota de voz';
  if (message.tipo === 'file') return message.attachment?.nombre_archivo || 'Archivo adjunto';
  return message.contenido?.trim() || 'Mensaje';
}
function authorOf(message) { return message.sender_id === state.user?.id ? 'Tú' : nameOf(state.peer); }
function clearReply() { state.replyTo = null; $('reply-preview').hidden = true; }
function selectReply(message) {
  state.replyTo = message;
  $('reply-author').textContent = `Respondiendo a ${authorOf(message)}`;
  $('reply-snippet').textContent = snippetOf(message);
  $('reply-preview').hidden = false;
  $('message-input').focus();
}
function enableSwipeReply(card, message) {
  let startX = null, startY = null, distance = 0;
  function reset() { card.classList.remove('swiping'); card.style.transform = ''; startX = null; distance = 0; }
  card.addEventListener('touchstart', event => {
    if (event.touches.length !== 1 || event.target.closest('button, a, audio')) return;
    startX = event.touches[0].clientX; startY = event.touches[0].clientY; distance = 0;
  }, { passive: true });
  card.addEventListener('touchmove', event => {
    if (startX === null || event.touches.length !== 1) return;
    const dx = event.touches[0].clientX - startX;
    const dy = event.touches[0].clientY - startY;
    if (dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      distance = dx;
      card.classList.add('swiping'); card.style.transform = `translateX(${Math.min(dx, 82)}px)`;
    }
  }, { passive: true });
  card.addEventListener('touchend', () => { const shouldReply = distance >= 65; reset(); if (shouldReply) selectReply(message); });
  card.addEventListener('touchcancel', reset);
}
function cleanup() {
  if (state.channel && db) db.removeChannel(state.channel);
  clearInterval(state.poll); stopRecorder(false); clearReply(); Object.assign(state, { user: null, profile: null, settings: null, chatId: null, peer: null, clearedAt: null, messages: [], favoriteIds: new Set(), renderSignature: null, channel: null, poll: null });
  $('messages').replaceChildren(); setMenu(false);
}
async function checked(query) { const { data, error } = await query; if (error) throw error; return data; }
async function loadAccount(user) {
  cleanup(); state.user = user;
  try {
    const [profile, settings, chats] = await Promise.all([
      checked(db.from('profiles').select('id,nombre,apodo').eq('id', user.id).single()),
      checked(db.from('user_settings').select('tema,notificaciones_activadas').eq('user_id', user.id).single()),
      checked(db.rpc('get_my_chat'))
    ]);
    if (state.user?.id !== user.id) return;
    state.profile = profile; state.settings = settings;
    $('side-name').textContent = nameOf(profile); $('side-avatar').textContent = initials(nameOf(profile));
    $('setting-name').value = profile.nombre; $('setting-nickname').value = profile.apodo || '';
    $('setting-theme').value = settings.tema; $('setting-notifications').checked = settings.notificaciones_activadas;
    applyTheme(settings.tema);
    const chat = chats?.[0];
    if (chat) {
      state.chatId = chat.conversation_id; state.peer = { id: chat.other_id, nombre: chat.other_nombre, apodo: chat.other_apodo }; state.clearedAt = chat.cleared_at;
      $('peer-name').textContent = nameOf(state.peer); $('peer-avatar').textContent = initials(nameOf(state.peer));
      await refreshMessages(); subscribeChat();
    } else {
      $('peer-name').textContent = 'Chat pendiente'; $('peer-avatar').textContent = '?';
      $('messages').innerHTML = '<div class="empty-state"><strong>Falta vincular las dos cuentas</strong>Configura la conversación en Supabase siguiendo README.md.</div>';
      $('composer').querySelectorAll('button,textarea').forEach(el => el.disabled = true);
    }
    showScreen(location.hash === '#ajustes' ? 'settings' : 'chat');
  } catch (error) { console.error(error); showScreen('chat'); setNotice('No se pudo conectar con la base de datos. Revisa la configuración y la migración SQL.'); }
}
async function refreshMessages() {
  if (!state.chatId || state.loading) return;
  state.loading = true; const serial = ++refreshSerial;
  try {
    let query = db.from('messages').select('id,conversation_id,sender_id,tipo,contenido,reply_to,created_at').eq('conversation_id', state.chatId).eq('eliminado', false).order('created_at', { ascending: false }).limit(100);
    if (state.clearedAt) query = query.gt('created_at', state.clearedAt);
    const messages = (await checked(query)).reverse();
    const ids = messages.map(m => m.id);
    const missingReplies = [...new Set(messages.map(m => m.reply_to).filter(id => id && !ids.includes(id)))];
    const [attachments, favorites, olderReplies] = await Promise.all([
      ids.length ? checked(db.from('message_attachments').select('message_id,nombre_archivo,ruta_archivo,mime_type,duracion_segundos').in('message_id', ids)) : [],
      ids.length ? checked(db.from('favorite_messages').select('message_id').eq('user_id', state.user.id).in('message_id', ids)) : [],
      missingReplies.length ? checked(db.from('messages').select('id,sender_id,tipo,contenido').eq('conversation_id', state.chatId).in('id', missingReplies)) : []
    ]);
    if (serial !== refreshSerial || !state.user) return;
    const byMessage = new Map(attachments.map(a => [a.message_id, a]));
    const replies = new Map([...messages, ...olderReplies].map(m => [m.id, { ...m, attachment: byMessage.get(m.id) }]));
    const signature = ids.join('|') + '#' + favorites.map(f => f.message_id).sort().join('|');
    if (signature !== state.renderSignature) {
      state.messages = messages.map(m => ({ ...m, attachment: byMessage.get(m.id), reply: replies.get(m.reply_to) }));
      state.favoriteIds = new Set(favorites.map(f => f.message_id));
      state.renderSignature = signature;
      renderMessages();
    }
    setNotice('');
  } catch (error) { console.error(error); setNotice('No se pudieron cargar los mensajes. Se intentará de nuevo.'); }
  finally { state.loading = false; }
}
function renderMessages() {
  const container = $('messages'), nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 140;
  container.replaceChildren();
  if (!state.messages.length) { const empty = document.createElement('div'); empty.className = 'empty-state'; const title = document.createElement('strong'); title.textContent = 'La conversación empieza aquí'; empty.append(title, document.createTextNode('Envía un mensaje para empezar.')); container.append(empty); return; }
  for (const m of state.messages) {
    const card = document.createElement('article'); card.className = 'message' + (m.sender_id === state.user.id ? ' mine' : '');
    card.dataset.messageId = m.id;
    enableSwipeReply(card, m);
    if (m.reply_to) {
      const quote = document.createElement('div'); quote.className = 'message-reply';
      const author = document.createElement('strong'); author.textContent = m.reply ? authorOf(m.reply) : 'Mensaje anterior';
      const excerpt = document.createElement('span'); excerpt.textContent = m.reply ? snippetOf(m.reply) : 'Mensaje no disponible';
      quote.append(author, excerpt); card.append(quote);
    }
    if (m.tipo === 'text') { const p = document.createElement('p'); p.textContent = m.contenido || ''; card.append(p); }
    else if (m.attachment) {
      const wrap = document.createElement('div'); wrap.className = 'attachment-placeholder'; wrap.textContent = 'Cargando archivo…'; card.append(wrap); loadAttachment(m.attachment, wrap, m.tipo);
    } else { const span = document.createElement('span'); span.className = 'attachment-placeholder'; span.textContent = 'Archivo no disponible'; card.append(span); }
    const footer = document.createElement('footer'); const time = document.createElement('time'); time.dateTime = m.created_at; time.textContent = new Intl.DateTimeFormat('es', { hour:'2-digit', minute:'2-digit' }).format(new Date(m.created_at));
    const favorite = document.createElement('button'); favorite.type = 'button'; favorite.className = 'favorite-toggle' + (state.favoriteIds.has(m.id) ? ' active' : ''); favorite.textContent = state.favoriteIds.has(m.id) ? '★' : '☆'; favorite.setAttribute('aria-label', state.favoriteIds.has(m.id) ? 'Quitar de favoritos' : 'Agregar a favoritos'); favorite.addEventListener('click', () => toggleFavorite(m.id));
    const reply = document.createElement('button'); reply.type = 'button'; reply.className = 'reply-action'; reply.textContent = '↩'; reply.setAttribute('aria-label', 'Responder a este mensaje'); reply.title = 'Responder'; reply.addEventListener('click', () => selectReply(m));
    footer.append(reply, time, favorite); card.append(footer); container.append(card);
  }
  if (nearBottom) container.scrollTop = container.scrollHeight;
}
async function loadAttachment(attachment, target, type) {
  const { data, error } = await db.storage.from('chat-attachments').createSignedUrl(attachment.ruta_archivo, 3600);
  if (error || !target.isConnected) { target.textContent = 'Archivo no disponible'; return; }
  target.replaceChildren();
  if (type === 'audio') { const player = document.createElement('audio'); player.controls = true; player.preload = 'none'; player.src = data.signedUrl; player.setAttribute('aria-label', 'Nota de voz'); target.append(player); }
  else { const link = document.createElement('a'); link.className = 'attachment-link'; link.href = data.signedUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.download = attachment.nombre_archivo; link.textContent = '↧  ' + attachment.nombre_archivo; target.append(link); }
}
function subscribeChat() {
  state.channel = db.channel('chat-' + state.chatId).on('postgres_changes', { event:'INSERT', schema:'public', table:'messages', filter:`conversation_id=eq.${state.chatId}` }, async payload => {
    if (payload.new.sender_id !== state.user?.id && state.settings?.notificaciones_activadas && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      new Notification(nameOf(state.peer), { body: payload.new.tipo === 'text' ? (payload.new.contenido || 'Nuevo mensaje').slice(0, 100) : 'Nuevo archivo o audio' });
    }
    await refreshMessages();
  }).subscribe();
  state.poll = setInterval(() => { if (!document.hidden) refreshMessages(); }, 12000);
}
async function sendText(event) {
  event.preventDefault(); const text = $('message-input').value.trim(); if (!text || !state.chatId) return;
  const btn = $('send-button'); if (btn.disabled) return; btn.disabled = true;
  const replyId = state.replyTo?.id || null;
  try {
    await checked(db.from('messages').insert({ conversation_id:state.chatId, sender_id:state.user.id, tipo:'text', contenido:text, reply_to:replyId }));
    $('message-input').value = '';
    if (state.replyTo?.id === replyId) clearReply();
    await refreshMessages();
  }
  catch (error) { notify('No se pudo enviar: ' + errorMessage(error)); }
  finally { btn.disabled = false; $('message-input').focus(); }
}
async function sendFile(file, audio = false) {
  if (!file || !state.chatId) return;
  if (file.size > 20 * 1024 * 1024) { notify('El archivo debe ser de 20 MB o menos.'); return; }
  const path = `${state.chatId}/${state.user.id}/${crypto.randomUUID()}`;
  $('attach-button').disabled = true; $('audio-button').disabled = true; notify(audio ? 'Enviando audio…' : 'Subiendo archivo…');
  let uploaded = false;
  try {
    await checked(db.storage.from('chat-attachments').upload(path, file, { contentType:file.type || 'application/octet-stream', upsert:false })); uploaded = true;
    await checked(db.rpc('create_attachment_message', { p_conversation_id:state.chatId, p_tipo:audio ? 'audio' : 'file', p_nombre_archivo:file.name, p_ruta_archivo:path, p_mime_type:file.type || 'application/octet-stream', p_tamano_bytes:file.size }));
    notify(audio ? 'Audio enviado.' : 'Archivo enviado.'); await refreshMessages();
  } catch (error) {
    if (uploaded) await db.storage.from('chat-attachments').remove([path]);
    notify('No se pudo enviar el archivo: ' + errorMessage(error));
  } finally { $('attach-button').disabled = false; $('audio-button').disabled = false; $('file-input').value = ''; }
}
async function toggleFavorite(id) {
  try {
    if (state.favoriteIds.has(id)) await checked(db.from('favorite_messages').delete().eq('user_id', state.user.id).eq('message_id', id));
    else await checked(db.from('favorite_messages').insert({ user_id:state.user.id, message_id:id }));
    await refreshMessages();
  } catch (error) { notify('No se pudo actualizar el favorito: ' + errorMessage(error)); }
}
function stopRecorder(send) {
  if (!state.recorder) return;
  const recorder = state.recorder; state.recorder = null; $('audio-button').classList.remove('recording'); $('audio-button').setAttribute('aria-label', 'Grabar audio');
  if (send && recorder.state === 'recording') recorder.stop();
  else { recorder.onstop = null; if (recorder.state !== 'inactive') recorder.stop(); state.stream?.getTracks().forEach(t => t.stop()); state.stream = null; }
}
async function toggleAudio() {
  if (state.recorder) { stopRecorder(true); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { notify('Tu navegador no permite grabar audio aquí. Usa HTTPS o localhost.'); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio:true }); state.stream = stream; state.chunks = [];
    const mime = ['audio/webm', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(stream, mime ? { mimeType:mime } : undefined); state.recorder = recorder;
    recorder.ondataavailable = e => { if (e.data.size) state.chunks.push(e.data); };
    recorder.onstop = () => { stream.getTracks().forEach(t => t.stop()); state.stream = null; const blob = new Blob(state.chunks, { type:recorder.mimeType || 'audio/webm' }); state.chunks = []; if (blob.size) { const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm'; sendFile(new File([blob], `Audio-${Date.now()}.${ext}`, { type:blob.type }), true); } };
    recorder.start(); $('audio-button').classList.add('recording'); $('audio-button').setAttribute('aria-label', 'Detener y enviar audio'); notify('Grabando… Pulsa de nuevo para enviar.');
  } catch (error) { notify('No se pudo acceder al micrófono: ' + errorMessage(error)); }
}
async function saveSettings(event) {
  event.preventDefault(); const name = $('setting-name').value.trim(), nickname = $('setting-nickname').value.trim(), theme = $('setting-theme').value, enabled = $('setting-notifications').checked;
  if (!name) { notify('El nombre es obligatorio.'); return; }
  $('settings-save').disabled = true; $('settings-feedback').textContent = 'Guardando…';
  try {
    if (name !== state.profile.nombre || nickname !== (state.profile.apodo || '')) {
      await checked(db.from('profiles').update({ nombre:name, apodo:nickname || null }).eq('id', state.user.id));
      state.profile = { ...state.profile, nombre:name, apodo:nickname || null };
    }
    if (theme !== state.settings.tema || enabled !== state.settings.notificaciones_activadas) {
      await checked(db.from('user_settings').update({ tema:theme, notificaciones_activadas:enabled }).eq('user_id', state.user.id));
      state.settings = { tema:theme, notificaciones_activadas:enabled };
    }
    if (enabled && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    applyTheme(theme); $('side-name').textContent = nameOf(state.profile); $('side-avatar').textContent = initials(nameOf(state.profile));
    $('settings-feedback').textContent = 'Cambios guardados.';
  } catch (error) { $('settings-feedback').textContent = 'No se guardaron todos los cambios. Vuelve a intentarlo.'; notify(errorMessage(error)); }
  finally { $('settings-save').disabled = false; }
}
async function clearChat() {
  if (!state.chatId || !confirm('¿Ocultar todos los mensajes anteriores solo en tu cuenta? La otra persona seguirá viéndolos.')) return;
  try { const timestamp = await checked(db.rpc('clear_my_chat', { p_conversation_id:state.chatId })); state.clearedAt = timestamp; clearReply(); await refreshMessages(); notify('Chat limpio en tu cuenta.'); }
  catch (error) { notify('No se pudo limpiar el chat: ' + errorMessage(error)); }
}
function openFavorites() {
  const list = $('favorite-list'); list.replaceChildren(); const favorites = state.messages.filter(m => state.favoriteIds.has(m.id));
  if (!favorites.length) list.textContent = 'Todavía no tienes mensajes favoritos en este chat.';
  for (const m of favorites) { const item = document.createElement('div'); item.className = 'favorite-item'; item.textContent = m.tipo === 'text' ? m.contenido : m.attachment?.nombre_archivo || 'Archivo'; const small = document.createElement('small'); small.textContent = `${m.sender_id === state.user.id ? 'Tú' : nameOf(state.peer)} · ${new Date(m.created_at).toLocaleString('es')}`; item.append(small); list.append(item); }
  $('favorites-dialog').showModal();
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('login-error').hidden = true; if (!db) { $('login-error').textContent = 'Configura VITE_SUPABASE_URL y VITE_SUPABASE_PUBLISHABLE_KEY en el archivo .env.local.'; $('login-error').hidden = false; return; }
  $('login-submit').disabled = true;
  try { const { data, error } = await db.auth.signInWithPassword({ email:$('email').value.trim(), password:$('password').value }); if (error) throw error; $('password').value = ''; await loadAccount(data.user); }
  catch (error) { $('login-error').textContent = 'No se pudo entrar. Revisa el correo, la contraseña y la conexión con Supabase.'; $('login-error').hidden = false; console.error(error); }
  finally { $('login-submit').disabled = false; }
});
$('composer').addEventListener('submit', sendText);
$('cancel-reply').addEventListener('click', clearReply);
$('message-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit(); } });
$('attach-button').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', e => sendFile(e.target.files?.[0]));
$('audio-button').addEventListener('click', toggleAudio);
$('settings-form').addEventListener('submit', saveSettings);
$('menu-button').addEventListener('click', () => setMenu($('menu').hidden));
document.addEventListener('click', e => { if (!e.target.closest('.menu-wrap')) setMenu(false); });
document.querySelectorAll('[data-go]').forEach(button => button.addEventListener('click', () => { location.hash = button.dataset.go === 'settings' ? '#ajustes' : '#chat'; showScreen(button.dataset.go); }));
document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', async () => { setMenu(false); switch(button.dataset.action) { case 'favorites': openFavorites(); break; case 'settings': location.hash = '#ajustes'; showScreen('settings'); break; case 'clear': await clearChat(); break; case 'logout': try { await checked(db.auth.signOut()); cleanup(); showScreen('login'); location.hash = ''; } catch (e) { notify(errorMessage(e)); } } }));
$('close-favorites').addEventListener('click', () => $('favorites-dialog').close());
window.addEventListener('hashchange', () => { if (state.user) showScreen(location.hash === '#ajustes' ? 'settings' : 'chat'); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.chatId) refreshMessages(); });
(async () => {
  applyTheme('system'); showScreen('login');
  if (!db) { $('login-error').textContent = 'Para conectar el proyecto, configura las variables de Supabase y vuelve a compilarlo.'; $('login-error').hidden = false; return; }
  const { data, error } = await db.auth.getUser();
  if (!error && data.user) await loadAccount(data.user);
})();
