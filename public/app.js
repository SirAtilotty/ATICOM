'use strict';
// Sunucudan gelen metin her zaman textContent ile yazılır, HTML olarak yorumlanmaz.
const $ = (id) => document.getElementById(id);
const PAGE = 50;
const MAX_SIDE = 1600;
const RUN_GAP = 5 * 60 * 1000; // aynı kişinin bu süre içindeki mesajları tek grup görünür

let me = null;
let convos = [];
let current = null;
let events = null;
let replyTo = null;
const typing = new Map(); // "sohbet:kişi" -> { convoId, name, kind, timer }

async function api(url, options = {}) {
  const init = { method: options.method || 'GET', headers: {} };
  if (options.json !== undefined) {
    init.body = JSON.stringify(options.json);
    init.headers['Content-Type'] = 'application/json';
  } else if (options.body) {
    init.body = options.body;
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error(t('networkError'));
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && me) showAuth();
  if (!res.ok) throw new Error(t(`err.${data.error || 'serverError'}`));
  return data;
}

function h(tag, props = {}, ...children) {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
}

function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

// Herkesin kendi rengi olur; renk kimliğe bağlı, isim değişse de aynı kalır.
const hue = (id) => `hue${id % 8}`;
function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => [...w][0]).join('').toLocaleUpperCase(locale());
}
function avatar(name, id, group = false) {
  return h('span', { className: `avatar ${group ? 'hue-group' : hue(id)}`, textContent: initials(name), ariaHidden: 'true' });
}

const formError = (form, text) => { form.querySelector('.error').textContent = text; };
const isVoice = (file) => /\.(webm|ogg)$/.test(file);
const snippet = (body, image) => (image ? t(isVoice(image) ? 'voice' : 'photo') : body);
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const clock = (at) => new Date(at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });

function dayLabel(at) {
  if (sameDay(at, Date.now())) return t('today');
  if (sameDay(at, Date.now() - 864e5)) return t('yesterday');
  const date = new Date(at);
  const year = date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric';
  return date.toLocaleDateString(locale(), { day: 'numeric', month: 'long', year });
}

// ---- Giriş
function showAuth() {
  me = null;
  current = null;
  if (events) events.close();
  events = null;
  $('app').hidden = true;
  $('auth').hidden = false;
  const invite = /^#davet=(.+)$/.exec(location.hash);
  if (invite) $('register-form').elements.invite.value = invite[1];
  $('login-form').hidden = Boolean(invite);
  $('register-form').hidden = !invite;
}

async function showApp(user) {
  me = user;
  if (location.hash) history.replaceState(null, '', location.pathname);
  $('auth').hidden = true;
  $('app').hidden = false;
  $('login-form').reset();
  $('register-form').reset();
  renderMe();
  closeChat();
  await loadConvos();
  connect();
  setupPush();
}

function renderMe() {
  $('open-profile').replaceChildren(avatar(me.name, me.id));
}

function authSubmit(form, url) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    formError(form, '');
    try {
      await showApp(await api(url, { method: 'POST', json: Object.fromEntries(new FormData(form)) }));
    } catch (err) {
      formError(form, err.message);
    }
  });
}
authSubmit($('login-form'), '/api/login');
authSubmit($('register-form'), '/api/register');

function toggleAuth(showRegister) {
  $('login-form').hidden = showRegister;
  $('register-form').hidden = !showRegister;
}
$('show-register').onclick = () => toggleAuth(true);
$('show-login').onclick = () => toggleAuth(false);
// Giriş ekranı açıkken davet linki aynı sekmede açılırsa sayfa yenilenmez.
addEventListener('hashchange', () => { if (!me) showAuth(); });

// ---- Canlı akış
function connect() {
  events = new EventSource('/api/events');
  // Her bağlantıda çekilir: kopukken gelen mesajlar kaçmasın.
  events.onopen = () => resync().catch(() => {});
  events.onmessage = (e) => {
    const event = JSON.parse(e.data);
    if (event.type === 'typing') return onTyping(event);
    if (event.type === 'read') return onRead(event);
    if (event.type === 'message') {
      const m = event.message;
      stopTyping(m.convoId, m.userId);
      // Bildirim izni varsa arka planda sesi telefonun bildirimi çalar; iki kez çalmasın.
      if (m.userId !== me.id && (!document.hidden || !pushSupported || Notification.permission !== 'granted')) playSound();
      if (m.convoId === current) {
        addMessage(m);
        markRead();
      }
    }
    loadConvos().then(() => {
      // Grup adı, üyeler değişmiş ya da bu cihazdan başka yerde gruptan çıkılmış olabilir.
      if (event.type === 'convo' && current) {
        if (convos.some((c) => c.id === current)) renderHeader();
        else closeChat();
      }
    }, () => {});
  };
  events.onerror = () => {
    // Tarayıcı kopmalarda kendisi yeniden dener, ama 401/502 gibi yanıtlarda vazgeçer.
    if (events.readyState === EventSource.CLOSED) setTimeout(reconnect, 5000);
  };
}

function reconnect() {
  if (!me) return;
  // Oturum bittiyse api() giriş ekranını açar ve me boşalır; sunucu yoksa denemeye devam edilir.
  api('/api/me').then(connect, () => setTimeout(reconnect, 5000));
}

async function resync() {
  await loadConvos();
  if (current) await openConvo(current, false);
}

// ---- Yazıyor / ses kaydediyor
function onTyping(event) {
  if (event.userId === me.id) return;
  const key = `${event.convoId}:${event.userId}`;
  clearTimeout(typing.get(key)?.timer);
  // Karşı taraf 3 saniyede bir haber verir; haber kesilirse gösterge kendiliğinden kalkar.
  const timer = setTimeout(() => stopTyping(event.convoId, event.userId), 5000);
  typing.set(key, { convoId: event.convoId, name: event.name, kind: event.kind, timer });
  renderTyping();
}

function stopTyping(convoId, userId) {
  const key = `${convoId}:${userId}`;
  if (!typing.has(key)) return;
  clearTimeout(typing.get(key).timer);
  typing.delete(key);
  renderTyping();
}

function typingEl(convo) {
  const who = [...typing.values()].find((x) => x.convoId === convo.id);
  if (!who) return null;
  const key = who.kind === 'voice' ? 'recording' : 'typing';
  const text = convo.title ? t(`${key}Name`, { name: who.name }) : t(key);
  return h('span', { className: 'typing' }, who.kind === 'voice' ? icon('mic') : '', text);
}

function renderTyping() {
  renderConvos();
  if (current) renderHeader();
}

let lastTyping = 0;
function sendTyping(kind, id = current) {
  if (!id || Date.now() - lastTyping < 3000) return;
  lastTyping = Date.now();
  api(`/api/convos/${id}/typing`, { method: 'POST', json: { kind } }).catch(() => {});
}

// ---- Okundu bilgisi
function onRead(event) {
  const convo = convos.find((c) => c.id === event.convoId);
  const member = convo?.members.find((m) => m.id === event.userId);
  if (member) member.lastRead = Math.max(member.lastRead, event.lastRead);
  if (event.userId === me.id) loadConvos().catch(() => {}); // başka cihazda okundu: rozet silinsin
  else if (event.convoId === current) updateTicks();
}

// Grupta çift tik, herkes okuyunca çıkar.
function readUpTo(convo) {
  const others = convo.members.filter((m) => m.id !== me.id);
  return others.length ? Math.min(...others.map((m) => m.lastRead)) : 0;
}

function updateTicks() {
  const convo = convos.find((c) => c.id === current);
  if (!convo) return;
  const upTo = readUpTo(convo);
  for (const el of $('messages').querySelectorAll('.message.mine .ticks')) {
    const read = Number(el.closest('.message').dataset.id) <= upTo;
    if (el.classList.contains('read') === read && el.firstChild) continue;
    el.classList.toggle('read', read);
    el.title = t(read ? 'read' : 'sent');
    el.replaceChildren(icon(read ? 'checks' : 'check'), h('span', { className: 'sr', textContent: el.title }));
  }
}

// ---- Mesaj sesi
// Tarayıcılar ilk dokunuştan önce ses çalmaya izin vermez; ses dosyası gerekmez, tonlar burada üretilir.
let audio = null;
function unlockAudio() {
  audio ??= new AudioContext();
  audio.resume();
}
addEventListener('pointerdown', unlockAudio);
addEventListener('keydown', unlockAudio);

function playSound() {
  if (!audio) return;
  audio.resume();
  [[880, 0], [1175, 0.13]].forEach(([frequency, delay]) => {
    const start = audio.currentTime + delay;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.25, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.22);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.22);
  });
}

// ---- Telefon bildirimi
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function subscribePush() {
  await navigator.serviceWorker.register(`/sw.js?lang=${lang}`);
  const registration = await navigator.serviceWorker.ready;
  const { key } = await api('/api/push-key');
  const applicationServerKey = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
  await api('/api/push', { method: 'POST', json: { endpoint: subscription.endpoint } });
}

function setupPush() {
  if (!pushSupported) return; // HTTPS olmadan da burada kalır; uygulama bildirimsiz çalışmaya devam eder
  $('push-banner').hidden = Notification.permission !== 'default';
  // Her açılışta yenilenir: abonelik adresi değişmiş veya hesap değişmiş olabilir.
  if (Notification.permission === 'granted') subscribePush().catch((err) => console.error(err));
}

$('enable-push').onclick = async () => {
  $('push-error').textContent = '';
  try {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') await subscribePush();
    $('push-banner').hidden = true;
  } catch {
    $('push-error').textContent = t('pushFailed');
  }
};

async function pushSubscription() {
  if (!pushSupported) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) || null;
}

// Çıkış yapılan telefona artık bildirim gitmesin. Hata çıkışı engellemez.
async function disablePush() {
  const subscription = await pushSubscription();
  if (!subscription) return;
  await api('/api/push', { method: 'DELETE', json: { endpoint: subscription.endpoint } });
  await subscription.unsubscribe();
}

// ---- Sohbet listesi
const others = (c) => c.members.filter((m) => m.id !== me.id);
const convoName = (c) => c.title || others(c).map((m) => m.name).join(', ') || t('chat');
function convoAvatar(c) {
  const other = others(c)[0];
  return c.title || !other ? avatar(convoName(c), c.id, true) : avatar(other.name, other.id);
}

async function loadConvos() {
  convos = await api('/api/convos');
  renderConvos();
}

function listTime(at) {
  if (sameDay(at, Date.now())) return clock(at);
  if (sameDay(at, Date.now() - 864e5)) return t('yesterday');
  return new Date(at).toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
}

function renderConvos() {
  const unread = convos.reduce((sum, c) => sum + c.unread, 0);
  document.title = unread ? `(${unread}) ATICOM` : 'ATICOM';
  $('no-convos').hidden = convos.length > 0;
  $('convos').replaceChildren(...convos.map((c) => {
    let preview = typingEl(c);
    if (!preview) {
      const kind = c.lastImage && (isVoice(c.lastImage) ? 'mic' : 'camera');
      preview = h('span', {}, kind ? icon(kind) : '', c.lastId ? snippet(c.lastBody, c.lastImage) : t('noMessagesYet'));
    }
    preview.classList.add('preview');
    const button = h('button', { className: 'convo', onclick: () => openConvo(c.id) },
      convoAvatar(c),
      h('span', { className: 'convo-text' },
        h('span', { className: 'convo-top' },
          h('strong', { textContent: convoName(c) }),
          c.lastAt ? h('time', { textContent: listTime(c.lastAt) }) : ''),
        h('span', { className: 'convo-bottom' },
          preview,
          c.unread ? h('span', { className: 'badge', textContent: c.unread, title: t('unread', { count: c.unread }) }) : '')));
    if (c.unread) button.classList.add('has-unread');
    if (c.id === current) button.setAttribute('aria-current', 'true');
    return h('li', {}, button);
  }));
}

// ---- Açık sohbet
function closeChat() {
  current = null;
  setReply(null);
  $('app').classList.remove('in-chat');
  $('chat-open').hidden = true;
  $('no-chat').hidden = false;
  renderConvos();
}

function renderHeader() {
  const convo = convos.find((c) => c.id === current);
  if (!convo) return;
  $('chat-avatar').replaceChildren(convoAvatar(convo));
  $('chat-name').textContent = convoName(convo);
  const sub = typingEl(convo) || (convo.title ? convo.members.map((m) => (m.id === me.id ? t('you') : m.name)).join(', ') : '');
  $('chat-sub').replaceChildren(sub);
  $('open-group').hidden = !convo.title;
}

async function openConvo(id, navigate = true) {
  const convo = convos.find((c) => c.id === id);
  if (!convo) return closeChat();
  // Telefonda geri tuşu uygulamadan çıkmak yerine listeye dönsün.
  if (navigate && current === null) history.pushState({ chat: true }, '');
  if (current !== id) setReply(null);
  current = id;
  $('app').classList.add('in-chat');
  $('no-chat').hidden = true;
  $('chat-open').hidden = false;
  renderHeader();
  $('send-error').textContent = '';
  renderConvos();
  const box = $('messages');
  box.replaceChildren();
  try {
    const list = await api(`/api/convos/${id}/messages`);
    if (current !== id) return;
    box.replaceChildren();
    prependOlder(list);
    box.scrollTop = box.scrollHeight;
    markRead();
  } catch (err) {
    $('send-error').textContent = err.message;
  }
}

function prependOlder(list) {
  const box = $('messages');
  box.querySelector('.older')?.remove();
  box.prepend(...list.map(messageEl));
  if (list.length === PAGE) {
    const older = h('button', { type: 'button', className: 'older', textContent: t('olderMessages') });
    older.onclick = async () => {
      const id = current;
      const oldHeight = box.scrollHeight;
      const before = box.querySelector('.message').dataset.id;
      try {
        const page = await api(`/api/convos/${id}/messages?before=${before}`);
        if (current !== id) return;
        prependOlder(page);
        box.scrollTop = box.scrollHeight - oldHeight;
      } catch (err) {
        $('send-error').textContent = err.message;
      }
    };
    box.prepend(older);
  }
  decorate();
}

// Gün ayıraçlarını koyar ve art arda gelen mesajları gruplar; her eklemeden sonra baştan hesaplanır.
function decorate() {
  const box = $('messages');
  for (const day of box.querySelectorAll('.day')) day.remove();
  const list = [...box.querySelectorAll('.message')];
  const joins = (a, b) => a && b && a.dataset.user === b.dataset.user && b.dataset.at - a.dataset.at < RUN_GAP && sameDay(+a.dataset.at, +b.dataset.at);
  list.forEach((el, i) => {
    const prev = list[i - 1];
    if (!prev || !sameDay(+prev.dataset.at, +el.dataset.at)) {
      el.before(h('div', { className: 'day' }, h('span', { textContent: dayLabel(+el.dataset.at) })));
    }
    el.classList.toggle('first', !joins(prev, el));
    el.classList.toggle('last', !joins(el, list[i + 1]));
  });
  updateTicks();
}

function quoteEl(m) {
  const quote = h('button', { type: 'button', className: 'quote' },
    h('strong', { textContent: m.replyName }),
    h('span', { textContent: snippet(m.replyBody, m.replyImage) }));
  quote.onclick = () => {
    const target = $(`m${m.replyId}`);
    if (!target) return;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.classList.remove('flash');
    void target.offsetWidth; // animasyon tekrar başlasın
    target.classList.add('flash');
  };
  return quote;
}

function messageEl(m) {
  const mine = m.userId === me.id;
  const convo = convos.find((c) => c.id === m.convoId);
  const el = h('div', { className: `message${mine ? ' mine' : ''}`, id: `m${m.id}` });
  Object.assign(el.dataset, { id: m.id, user: m.userId, at: m.at });
  const bubble = h('div', { className: 'bubble' });
  if (!mine && convo?.title) bubble.append(h('span', { className: `sender ${hue(m.userId)}`, textContent: m.name }));
  if (m.replyId) bubble.append(quoteEl(m));
  if (m.image && isVoice(m.image)) {
    bubble.append(h('audio', { src: `/uploads/${m.image}`, controls: true, preload: 'metadata', ariaLabel: t('voiceFrom', { name: m.name }) }));
  } else if (m.image) {
    const src = `/uploads/${m.image}`;
    const alt = t('photoAlt', { name: m.name });
    bubble.append(h('button', { type: 'button', className: 'photo', onclick: () => showPhoto(src, alt) },
      h('img', { src, alt, loading: 'lazy' })));
  }
  if (m.body) bubble.append(h('p', { textContent: m.body }));
  bubble.append(h('span', { className: 'meta' },
    h('time', { textContent: clock(m.at), title: new Date(m.at).toLocaleString(locale()) }),
    mine ? h('span', { className: 'ticks' }) : ''));
  const reply = h('button', { type: 'button', className: 'icon-button reply', title: t('reply'), ariaLabel: t('reply'), onclick: () => setReply(m) }, icon('reply'));
  el.append(bubble, reply);
  swipeToReply(el, m);
  return el;
}

// Telefonda mesajı sağa kaydırınca yanıtlanır; dikey kaydırma (sayfayı gezme) bozulmaz.
function swipeToReply(el, m) {
  let start = null;
  const reset = () => {
    start = null;
    el.style.transform = '';
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' && !e.target.closest('audio')) start = { x: e.clientX, y: e.clientY, dx: 0 };
  });
  el.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    if (Math.abs(e.clientY - start.y) > Math.abs(dx) + 10) return reset();
    start.dx = dx;
    el.style.transform = `translateX(${Math.max(0, Math.min(dx, 80))}px)`;
  });
  el.addEventListener('pointerup', () => {
    if (start?.dx > 60) setReply(m);
    reset();
  });
  el.addEventListener('pointercancel', reset);
}

function addMessage(m) {
  if ($(`m${m.id}`)) return; // hem POST yanıtından hem canlı akıştan gelebilir
  const box = $('messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  box.append(messageEl(m));
  decorate();
  if (nearBottom || m.userId === me.id) box.scrollTop = box.scrollHeight;
}

async function markRead() {
  if (!current || document.hidden) return;
  const id = current;
  const convo = convos.find((c) => c.id === id);
  if (convo) convo.unread = 0;
  renderConvos();
  await api(`/api/convos/${id}/read`, { method: 'POST' }).catch(() => {});
}

document.addEventListener('visibilitychange', () => {
  if (!me) return;
  if (!document.hidden) markRead();
});

// ---- Yanıt
function setReply(m) {
  replyTo = m;
  $('reply-bar').hidden = !m;
  if (!m) return;
  $('reply-name').textContent = t('replyingTo', { name: m.userId === me.id ? t('you') : m.name });
  $('reply-snippet').textContent = snippet(m.body, m.image);
  $('text').focus();
}
$('reply-cancel').onclick = () => setReply(null);
const replyParam = (id) => (replyTo && current === id ? replyTo.id : undefined);

// ---- Mesaj gönderme
// Yazı yoksa mikrofon, yazı varsa gönder düğmesi görünür.
const canRecord = Boolean(window.MediaRecorder && navigator.mediaDevices);
function updateSendButtons() {
  const empty = !$('text').value.trim();
  $('record').hidden = !canRecord || !empty || Boolean(recorder);
  $('send').hidden = canRecord && empty && !recorder;
}

$('text').addEventListener('input', () => {
  updateSendButtons();
  if ($('text').value.trim()) sendTyping('text');
});

$('send-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (recorder) return stopRecording(true);
  const body = $('text').value.trim();
  if (!body || !current) return;
  const id = current;
  $('send-error').textContent = '';
  try {
    const message = await api(`/api/convos/${id}/messages`, { method: 'POST', json: { body, replyTo: replyParam(id) } });
    // Metin ancak sunucu kaydettikten sonra silinir; hata olursa kullanıcının yazdığı kaybolmaz.
    $('text').value = '';
    lastTyping = 0;
    updateSendButtons();
    if (current === id) {
      setReply(null);
      addMessage(message);
    }
    loadConvos();
  } catch (err) {
    $('send-error').textContent = err.message;
  }
  $('text').focus();
});

$('text').addEventListener('keydown', (e) => {
  const desktop = matchMedia('(pointer: fine)').matches;
  if (e.key === 'Enter' && !e.shiftKey && desktop && !e.isComposing) {
    e.preventDefault();
    $('send-form').requestSubmit();
  }
});

// Yeniden kodlama boyutu küçültür ve fotoğraftaki konum bilgisini (EXIF) siler.
async function shrink(file) {
  if (file.type === 'image/gif') return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = h('canvas', {
      width: Math.round(bitmap.width * scale),
      height: Math.round(bitmap.height * scale),
    });
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return await new Promise((resolve) => canvas.toBlob((b) => resolve(b || file), 'image/jpeg', 0.85));
  } catch {
    return file; // tarayıcı çözemediyse dosyayı olduğu gibi gönder, sunucu türü denetler
  }
}

async function upload(id, body, status) {
  $('send-error').textContent = t(status);
  const reply = replyParam(id);
  try {
    const message = await api(`/api/convos/${id}/images${reply ? `?replyTo=${reply}` : ''}`, { method: 'POST', body });
    $('send-error').textContent = '';
    if (current === id) {
      if (replyTo?.id === reply) setReply(null);
      addMessage(message);
    }
    loadConvos();
  } catch (err) {
    $('send-error').textContent = err.message;
  }
}

$('photo').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file && current) upload(current, await shrink(file), 'sendingPhoto');
});

// ---- Sesli mesaj: mikrofona dokununca kayıt başlar; gönder ile biter, çöp kutusu ile silinir.
let recorder = null;
let recording = null; // { id, stream, chunks, started, tick, send }

function setRecording(on) {
  $('send-form').classList.toggle('is-recording', on);
  $('text').hidden = on;
  $('attach').hidden = on;
  $('rec-strip').hidden = !on;
  updateSendButtons();
}

function stopRecording(send) {
  if (!recorder || recorder.state === 'inactive') return;
  recording.send = send;
  recorder.stop();
}

$('record').onclick = async () => {
  if (recorder || !current) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    $('send-error').textContent = t('micDenied');
    return;
  }
  const chunks = [];
  recording = { id: current, stream, chunks, started: Date.now(), send: false };
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => chunks.push(e.data);
  lastTyping = 0;
  const tick = () => {
    const s = Math.floor((Date.now() - recording.started) / 1000);
    $('rec-time').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    sendTyping('voice', recording.id);
    if (s >= 300) stopRecording(true); // 5 dakika, yükleme sınırının çok altında
  };
  recording.tick = setInterval(tick, 500);
  recorder.onstop = () => {
    const { id, send, started } = recording;
    clearInterval(recording.tick);
    for (const track of stream.getTracks()) track.stop();
    recorder = null;
    recording = null;
    setRecording(false);
    if (send && Date.now() - started > 1000) upload(id, new Blob(chunks, { type: chunks[0]?.type }), 'sendingVoice');
  };
  recorder.start();
  tick();
  setRecording(true);
};
$('rec-cancel').onclick = () => stopRecording(false);

// ---- Geri tuşu ve fotoğraf
$('back').onclick = () => history.back();
addEventListener('popstate', () => {
  if ($('photo-dialog').open) return $('photo-dialog').close();
  if (me && current) closeChat();
});

// Fotoğraf uygulama içinde büyür; yeni sekme açılınca telefonda oturum çerezi gitmiyordu.
function showPhoto(src, alt) {
  Object.assign($('photo-big'), { src, alt });
  history.pushState({ photo: true }, '');
  $('photo-dialog').showModal();
}
$('photo-dialog').onclick = () => history.back();
$('photo-dialog').oncancel = (e) => { e.preventDefault(); history.back(); };

// ---- Pencereler
for (const button of document.querySelectorAll('dialog .cancel')) {
  button.onclick = () => button.closest('dialog').close();
}

const personRow = (u, checkbox) =>
  h('li', {}, h('label', {},
    checkbox ? h('input', { type: 'checkbox', name: 'user', value: u.id }) : '',
    avatar(u.name, u.id),
    h('span', { textContent: u.username ? `${u.name} (@${u.username})` : u.name })));

$('open-new').onclick = async () => {
  const form = $('new-form');
  form.reset();
  formError(form, '');
  $('title-field').hidden = true;
  const users = await api('/api/users').catch((err) => {
    formError(form, err.message);
    return [];
  });
  $('no-people').hidden = users.length > 0;
  $('people').replaceChildren(...users.map((u) => personRow(u, true)));
  $('new-dialog').showModal();
};

$('people').addEventListener('change', () => {
  $('title-field').hidden = $('new-form').querySelectorAll('[name=user]:checked').length < 2;
});

$('new-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const userIds = [...form.querySelectorAll('[name=user]:checked')].map((c) => Number(c.value));
  try {
    const { id } = await api('/api/convos', { method: 'POST', json: { userIds, title: form.elements.title.value } });
    $('new-dialog').close();
    await loadConvos();
    await openConvo(id);
  } catch (err) {
    formError(form, err.message);
  }
});

// ---- Grup bilgisi
$('open-group').onclick = async () => {
  const convo = convos.find((c) => c.id === current);
  if (!convo?.title) return;
  const form = $('group-form');
  form.reset();
  formError(form, '');
  form.elements.title.value = convo.title;
  $('group-members').replaceChildren(...convo.members.map((m) => personRow(m.id === me.id ? { ...m, name: t('you') } : m, false)));
  const users = await api('/api/users').catch((err) => {
    formError(form, err.message);
    return [];
  });
  const outside = users.filter((u) => !convo.members.some((m) => m.id === u.id));
  $('no-add').hidden = outside.length > 0;
  $('group-add').replaceChildren(...outside.map((u) => personRow(u, true)));
  $('group-dialog').showModal();
};

$('group-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const id = current;
  const convo = convos.find((c) => c.id === id);
  const title = form.elements.title.value.trim();
  const userIds = [...form.querySelectorAll('[name=user]:checked')].map((c) => Number(c.value));
  try {
    if (title !== convo.title) await api(`/api/convos/${id}`, { method: 'PATCH', json: { title } });
    if (userIds.length) await api(`/api/convos/${id}/members`, { method: 'POST', json: { userIds } });
    $('group-dialog').close();
    await loadConvos();
    renderHeader();
  } catch (err) {
    formError(form, err.message);
  }
});

$('leave-group').onclick = async () => {
  if (!confirm(t('leaveConfirm'))) return;
  try {
    await api(`/api/convos/${current}/members/me`, { method: 'DELETE' });
    $('group-dialog').close();
    await loadConvos();
    history.back(); // sohbetten çıkıp listeye döner
  } catch (err) {
    formError($('group-form'), err.message);
  }
};

// ---- Profil
$('open-profile').onclick = () => {
  const form = $('profile-form');
  form.reset();
  formError(form, '');
  $('delete-error').textContent = '';
  form.querySelector('.danger-zone').open = false;
  form.elements.name.value = me.name;
  $('profile-username').textContent = `@${me.username}`;
  $('profile-dialog').showModal();
};

$('profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const json = { name: form.elements.name.value };
  if (form.elements.newPassword.value) {
    json.newPassword = form.elements.newPassword.value;
    json.currentPassword = form.elements.currentPassword.value;
  }
  try {
    me = await api('/api/me', { method: 'PATCH', json });
    renderMe();
    $('profile-dialog').close();
    await loadConvos();
  } catch (err) {
    formError(form, err.message);
  }
});

$('logout').onclick = async () => {
  try {
    await disablePush().catch((err) => console.error(err));
    await api('/api/logout', { method: 'POST' });
    $('profile-dialog').close();
    showAuth();
  } catch (err) {
    formError($('profile-form'), err.message);
  }
};

$('delete-account').onclick = async () => {
  $('delete-error').textContent = '';
  if (!confirm(t('deleteConfirm'))) return;
  try {
    await api('/api/me', { method: 'DELETE', json: { password: $('delete-password').value } });
  } catch (err) {
    $('delete-error').textContent = err.message;
    return;
  }
  // Sunucu bildirim kaydını zaten sildi; telefondaki abonelik de kapansın.
  await pushSubscription().then((s) => s?.unsubscribe()).catch(() => {});
  $('profile-dialog').close();
  showAuth();
};

// ---- Dil
for (const button of document.querySelectorAll('.lang-toggle')) {
  button.onclick = () => {
    setLang(lang === 'en' ? 'tr' : 'en');
    translatePage();
    for (const error of document.querySelectorAll('.error')) error.textContent = '';
    if (!me) return;
    renderConvos();
    if (current) openConvo(current, false);
    // Bildirim yazısı da yeni dile geçsin.
    if (pushSupported && Notification.permission === 'granted') subscribePush().catch((err) => console.error(err));
  };
}

// ---- Başlangıç
translatePage();
updateSendButtons();
fetch('/api/me')
  .then((res) => (res.ok ? res.json() : null))
  .catch(() => null)
  .then((user) => (user ? showApp(user) : showAuth()));
