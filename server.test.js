'use strict';
// Sunucuyu gerçek süreç olarak başlatıp dışarıdan, HTTP üzerinden sınar.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aticom-'));
const PORT = 34571;
const BASE = `http://127.0.0.1:${PORT}`;
const FAKE_PUSH = 'http://127.0.0.1:34574';
const env = { ...process.env, DATA_DIR: dir, PORT: String(PORT), BASE_URL: BASE, PUSH_ORIGINS: FAKE_PUSH };
const pushHits = [];
let pushStatus = 201;
const fakePush = require('node:http').createServer((req, res) => {
  pushHits.push({ url: req.url, headers: req.headers });
  res.writeHead(pushStatus).end();
});
const cli = (...args) => execFileSync(process.execPath, ['server.js', ...args], { cwd: __dirname, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
let server;

async function call(url, { cookie, json, body, method, headers = {} } = {}) {
  const res = await fetch(BASE + url, {
    method: method || (json !== undefined || body ? 'POST' : 'GET'),
    headers: { ...(cookie && { Cookie: cookie }), ...headers },
    body: json !== undefined ? JSON.stringify(json) : body,
  });
  const set = res.headers.get('set-cookie');
  const isJson = (res.headers.get('content-type') || '').includes('json');
  return { status: res.status, cookie: set && set.split(';')[0], data: isJson ? await res.json() : Buffer.from(await res.arrayBuffer()), headers: res.headers };
}

const invite = () => /#invite=([0-9a-f]+)/.exec(cli('invite'))[1];
const register = async (username) => {
  const r = await call('/api/register', { json: { invite: invite(), username, name: username, password: 'parola-1234' } });
  assert.equal(r.status, 200);
  return { id: r.data.id, cookie: r.cookie };
};

let ali, ayse, can, dm;

before(async () => {
  await new Promise((r) => fakePush.listen(34574, '127.0.0.1', r));
  server = spawn(process.execPath, ['server.js'], { cwd: __dirname, env, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    if (await fetch(BASE).then(() => true, () => false)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  ali = await register('ali');
  ayse = await register('ayse');
  can = await register('can');
  dm = (await call('/api/convos', { cookie: ali.cookie, json: { userIds: [ayse.id] } })).data.id;
});

after(() => {
  server.kill();
  fakePush.closeAllConnections();
  fakePush.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('kayıt için geçerli ve kullanılmamış davet gerekir', async () => {
  const account = { username: 'yabanci', name: 'Y', password: 'parola-1234' };
  assert.equal((await call('/api/register', { json: { ...account, invite: 'yanlis' } })).status, 403);
  const code = invite();
  assert.equal((await call('/api/register', { json: { ...account, invite: code } })).status, 200);
  const again = await call('/api/register', { json: { ...account, username: 'yabanci2', invite: code } });
  assert.equal(again.status, 403);
});

test('alınmış kullanıcı adı daveti harcamaz', async () => {
  const code = invite();
  const body = { invite: code, name: 'A', password: 'parola-1234' };
  assert.equal((await call('/api/register', { json: { ...body, username: 'ALI' } })).status, 409);
  assert.equal((await call('/api/register', { json: { ...body, username: 'ali2' } })).status, 200);
});

test('oturumsuz API erişimi reddedilir', async () => {
  for (const url of ['/api/me', '/api/users', '/api/convos', `/api/convos/${dm}/messages`, '/api/events']) {
    assert.equal((await call(url)).status, 401, url);
  }
});

test('yol aşımı ile sunucu dosyaları okunamaz', async () => {
  for (const url of ['/../server.js', '/..%2fserver.js', '/uploads/..%2faticom.db', '/server.js']) {
    assert.equal((await call(url, { cookie: ali.cookie })).status, 404, url);
  }
});

test('özel sohbet tekildir ve üye olmayan erişemez', async () => {
  const again = await call('/api/convos', { cookie: ayse.cookie, json: { userIds: [ali.id] } });
  assert.equal(again.data.id, dm);
  const sent = await call(`/api/convos/${dm}/messages`, { cookie: ali.cookie, json: { body: 'selam' } });
  assert.equal(sent.status, 200);
  assert.equal((await call(`/api/convos/${dm}/messages`, { cookie: can.cookie })).status, 404);
  assert.equal((await call(`/api/convos/${dm}/messages`, { cookie: can.cookie, json: { body: 'x' } })).status, 404);
  const list = await call(`/api/convos/${dm}/messages`, { cookie: ayse.cookie });
  assert.equal(list.data.at(-1).body, 'selam');
});

test('okunmamış sayısı çalışır', async () => {
  const unread = async () => (await call('/api/convos', { cookie: ayse.cookie })).data.find((c) => c.id === dm).unread;
  assert.ok((await unread()) >= 1);
  await call(`/api/convos/${dm}/read`, { cookie: ayse.cookie, method: 'POST' });
  assert.equal(await unread(), 0);
});

test('grup adı ister ve tüm üyelere açılır', async () => {
  const userIds = [ayse.id, can.id];
  assert.equal((await call('/api/convos', { cookie: ali.cookie, json: { userIds } })).status, 400);
  const group = await call('/api/convos', { cookie: ali.cookie, json: { userIds, title: 'Aile' } });
  assert.equal(group.status, 200);
  const seen = await call('/api/convos', { cookie: can.cookie });
  assert.equal(seen.data.find((c) => c.id === group.data.id).members.length, 3);
});

test('fotoğraf yalnızca üyelere açılır, zararlı tür reddedilir', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.equal((await call(`/api/convos/${dm}/images`, { cookie: ali.cookie, body: svg })).status, 415);
  assert.equal((await call(`/api/convos/${dm}/images`, { cookie: can.cookie, body: PNG })).status, 404);
  const sent = await call(`/api/convos/${dm}/images`, { cookie: ali.cookie, body: PNG });
  assert.equal(sent.status, 200);
  const url = `/uploads/${sent.data.image}`;
  const got = await call(url, { cookie: ayse.cookie });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.equal((await call(url, { cookie: can.cookie })).status, 404);
  assert.equal((await call(url)).status, 401);
  const voice = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(20)]);
  const sentVoice = await call(`/api/convos/${dm}/images`, { cookie: ali.cookie, body: voice });
  assert.match(sentVoice.data.image, /\.webm$/);
  const gotVoice = await call(`/uploads/${sentVoice.data.image}`, { cookie: ayse.cookie });
  assert.equal(gotVoice.headers.get('content-type'), 'audio/webm');
});

test('yanıt yalnızca aynı sohbetteki mesaja verilir ve alıntıyla döner', async () => {
  const first = await call(`/api/convos/${dm}/messages`, { cookie: ayse.cookie, json: { body: 'soru' } });
  const answer = await call(`/api/convos/${dm}/messages`, { cookie: ali.cookie, json: { body: 'cevap', replyTo: first.data.id } });
  assert.equal(answer.data.replyId, first.data.id);
  assert.equal(answer.data.replyBody, 'soru');
  assert.equal(answer.data.replyName, 'ayse');
  const other = (await call('/api/convos', { cookie: ali.cookie, json: { userIds: [can.id] } })).data.id;
  const foreign = await call(`/api/convos/${other}/messages`, { cookie: can.cookie, json: { body: 'x', replyTo: first.data.id } });
  assert.equal(foreign.status, 400);
});

test('okundu ve yazıyor bilgisi canlı akışla gelir', async () => {
  const stream = await fetch(`${BASE}/api/events`, { headers: { Cookie: ali.cookie } });
  const reader = stream.body.getReader();
  let text = '';
  const until = async (needle) => {
    while (!text.includes(needle)) text += Buffer.from((await reader.read()).value).toString();
  };
  await call(`/api/convos/${dm}/messages`, { cookie: ali.cookie, json: { body: 'okundu-mu' } });
  await call(`/api/convos/${dm}/typing`, { cookie: ayse.cookie, json: { kind: 'voice' } });
  await until('"type":"typing"');
  assert.match(text, /"userId":\d+,"name":"ayse","kind":"voice"/);
  await call(`/api/convos/${dm}/read`, { cookie: ayse.cookie, method: 'POST' });
  await until('"type":"read"');
  await reader.cancel();
  const list = await call('/api/convos', { cookie: ali.cookie });
  const member = list.data.find((c) => c.id === dm).members.find((m) => m.id === ayse.id);
  assert.ok(member.lastRead > 0);
  // Okunacak yeni bir şey yoksa tekrar duyurulmaz (gereksiz trafik olmasın).
  assert.equal((await call(`/api/convos/${dm}/read`, { cookie: ayse.cookie, method: 'POST' })).status, 200);
});

test('grup: ad değişir, kişi eklenir, üye çıkabilir; özel sohbette olmaz', async () => {
  const g = (await call('/api/convos', { cookie: ali.cookie, json: { userIds: [ayse.id, can.id], title: 'Eski' } })).data.id;
  assert.equal((await call(`/api/convos/${g}`, { cookie: ayse.cookie, method: 'PATCH', json: { title: 'Yeni' } })).status, 200);
  const extra = await register('ekstra');
  assert.equal((await call(`/api/convos/${g}/members`, { cookie: ali.cookie, json: { userIds: [extra.id] } })).status, 200);
  const seen = (await call('/api/convos', { cookie: extra.cookie })).data.find((c) => c.id === g);
  assert.equal(seen.title, 'Yeni');
  assert.equal(seen.members.length, 4);
  assert.equal((await call(`/api/convos/${g}/members/me`, { cookie: can.cookie, method: 'DELETE' })).status, 200);
  assert.equal((await call(`/api/convos/${g}/messages`, { cookie: can.cookie })).status, 404);
  assert.equal((await call(`/api/convos/${dm}`, { cookie: ali.cookie, method: 'PATCH', json: { title: 'x' } })).status, 400);
  assert.equal((await call(`/api/convos/${dm}/members/me`, { cookie: ali.cookie, method: 'DELETE' })).status, 400);
  assert.equal((await call(`/api/convos/${g}/members`, { cookie: can.cookie, json: { userIds: [can.id] } })).status, 404);
});

test('hesap silme şifre ister, girişi kapatır, mesajlar kalır', async () => {
  const u = await register('silinecek');
  const convo = (await call('/api/convos', { cookie: u.cookie, json: { userIds: [ali.id] } })).data.id;
  await call(`/api/convos/${convo}/messages`, { cookie: u.cookie, json: { body: 'veda' } });
  assert.equal((await call('/api/me', { cookie: u.cookie, method: 'DELETE', json: { password: 'yanlis-sifre' } })).status, 403);
  const del = await call('/api/me', { cookie: u.cookie, method: 'DELETE', json: { password: 'parola-1234' } });
  assert.equal(del.status, 200);
  assert.equal((await call('/api/me', { cookie: u.cookie })).status, 401);
  assert.equal((await call('/api/login', { json: { username: 'silinecek', password: 'parola-1234' } })).status, 401);
  const msgs = await call(`/api/convos/${convo}/messages`, { cookie: ali.cookie });
  assert.equal(msgs.data.at(-1).body, 'veda');
  assert.ok(!(await call('/api/users', { cookie: ali.cookie })).data.some((x) => x.id === u.id));
});

test('aşırı büyük yükleme reddedilir', async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)]);
  assert.equal((await call(`/api/convos/${dm}/images`, { cookie: ali.cookie, body: big })).status, 413);
});

test('başka siteden gelen yazma isteği reddedilir', async () => {
  const r = await call(`/api/convos/${dm}/messages`, { cookie: ali.cookie, json: { body: 'x' }, headers: { Origin: 'https://kotu.example' } });
  assert.equal(r.status, 403);
});

test('mesaj canlı akışla yalnızca üyelere ulaşır', async () => {
  const open = (cookie) => fetch(`${BASE}/api/events`, { headers: { Cookie: cookie } });
  const [mine, outsider] = await Promise.all([open(ayse.cookie), open(can.cookie)]);
  const readUntil = async (res, needle) => {
    const reader = res.body.getReader();
    let text = '';
    while (!text.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString();
    }
    return { text, reader };
  };
  await call(`/api/convos/${dm}/messages`, { cookie: ali.cookie, json: { body: 'canli-mesaj' } });
  const got = await readUntil(mine, 'canli-mesaj');
  assert.ok(got.text.includes('canli-mesaj'));
  await got.reader.cancel();
  const chunk = await Promise.race([
    outsider.body.getReader().read().then((r) => Buffer.from(r.value).toString()),
    new Promise((r) => setTimeout(() => r(''), 300)),
  ]);
  assert.ok(!chunk.includes('canli-mesaj'));
});

test('şifre değişince diğer oturumlar kapanır', async () => {
  const u = await register('sifreci');
  const other = await call('/api/login', { json: { username: 'sifreci', password: 'parola-1234' } });
  assert.equal((await call('/api/me', { cookie: u.cookie, method: 'PATCH', json: { newPassword: 'yeni-parola-1', currentPassword: 'yanlis' } })).status, 403);
  assert.equal((await call('/api/me', { cookie: u.cookie, method: 'PATCH', json: { newPassword: 'yeni-parola-1', currentPassword: 'parola-1234' } })).status, 200);
  assert.equal((await call('/api/me', { cookie: other.cookie })).status, 401);
  assert.equal((await call('/api/me', { cookie: u.cookie })).status, 200);
  assert.equal((await call('/api/login', { json: { username: 'sifreci', password: 'parola-1234' } })).status, 401);
});

test('art arda hatalı giriş hesabı geçici kilitler', async () => {
  await register('kilitli');
  for (let i = 0; i < 10; i++) {
    assert.equal((await call('/api/login', { json: { username: 'kilitli', password: 'yanlis' } })).status, 401);
  }
  const locked = await call('/api/login', { json: { username: 'kilitli', password: 'parola-1234' } });
  assert.equal(locked.status, 429);
});

test('yönetici şifre sıfırlar ve üye çıkarır', async () => {
  const u = await register('giden');
  const temp = /password: (\S+)/.exec(cli('reset', 'giden'))[1];
  assert.equal((await call('/api/me', { cookie: u.cookie })).status, 401);
  const login = await call('/api/login', { json: { username: 'giden', password: temp } });
  assert.equal(login.status, 200);
  cli('remove', 'giden');
  assert.equal((await call('/api/me', { cookie: login.cookie })).status, 401);
  assert.equal((await call('/api/login', { json: { username: 'giden', password: temp } })).status, 401);
});

test('bildirim: yalnızca bilinen servis, gönderene gitmez, imza geçerli, ölü abonelik silinir', async () => {
  const crypto = require('node:crypto');
  const sub = (cookie, name) => call('/api/push', { cookie, json: { endpoint: `${FAKE_PUSH}/${name}` } });
  const waitHit = async () => {
    for (let i = 0; i < 100 && !pushHits.length; i++) await new Promise((r) => setTimeout(r, 20));
  };
  const say = (body) => call(`/api/convos/${dm}/messages`, { cookie: ali.cookie, json: { body } });

  assert.equal((await call('/api/push', { json: { endpoint: `${FAKE_PUSH}/x` } })).status, 401);
  for (const endpoint of ['https://kotu.example/x', 'http://169.254.169.254/latest', 'cop']) {
    assert.equal((await call('/api/push', { cookie: ali.cookie, json: { endpoint } })).status, 400, endpoint);
  }
  assert.equal((await sub(ayse.cookie, 'ayse')).status, 200);
  assert.equal((await sub(ali.cookie, 'ali')).status, 200);
  assert.equal((await sub(can.cookie, 'can')).status, 200);

  pushHits.length = 0;
  await say('bildirim-1');
  await waitHit();
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(pushHits.map((h) => h.url), ['/ayse']); // gönderen ve üye olmayan alamaz

  const { key } = (await call('/api/push-key', { cookie: ali.cookie })).data;
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(pushHits[0].headers.authorization);
  assert.equal(k, key);
  const [head, claims, signature] = jwt.split('.');
  const raw = Buffer.from(key, 'base64url');
  const publicKey = crypto.createPublicKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') },
  });
  assert.ok(crypto.verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
  const payload = JSON.parse(Buffer.from(claims, 'base64url').toString());
  assert.equal(payload.aud, FAKE_PUSH);
  assert.ok(payload.exp > Date.now() / 1000);

  // Servis 410 derse abonelik silinir, sonraki mesajda istek gitmez.
  pushStatus = 410;
  pushHits.length = 0;
  await say('bildirim-2');
  await waitHit();
  await new Promise((r) => setTimeout(r, 100));
  pushStatus = 201;
  pushHits.length = 0;
  await say('bildirim-3');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(pushHits.length, 0);

  // Çıkışta silinen abonelik de bildirim almaz; başkasının aboneliği silinemez.
  await sub(ayse.cookie, 'ayse');
  await call('/api/push', { cookie: can.cookie, method: 'DELETE', json: { endpoint: `${FAKE_PUSH}/ayse` } });
  await say('bildirim-4');
  await waitHit();
  assert.deepEqual(pushHits.map((h) => h.url), ['/ayse']);
  await call('/api/push', { cookie: ayse.cookie, method: 'DELETE', json: { endpoint: `${FAKE_PUSH}/ayse` } });
  pushHits.length = 0;
  await say('bildirim-5');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(pushHits.length, 0);
});

test('çeviri: iki dil eşit, kullanılan tüm anahtarlar ve sunucu hata kodları tanımlı', () => {
  const vm = require('node:vm');
  const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
  const { en, tr } = vm.runInNewContext(`${read('public/i18n.js')};I18N`);
  assert.deepEqual(Object.keys(tr).sort(), Object.keys(en).sort());
  for (const key of Object.keys(en)) assert.ok(en[key] && tr[key], key);

  const html = read('public/index.html');
  const used = [...html.matchAll(/data-i18n(?:-\w+)?="(\w+)"/g)].map((m) => m[1]);
  used.push(...[...read('public/app.js').matchAll(/\bt\('([\w.]+)'/g)].map((m) => m[1]));
  const codes = [...read('server.js').matchAll(/HttpError\(\d+, '(\w+)'\)/g)].map((m) => `err.${m[1]}`);
  assert.ok(used.length > 30 && codes.length > 15);
  for (const key of [...used, ...codes, 'err.serverError']) assert.ok(key in en, key);
  // Arayüzde çevrilmemiş Türkçe metin kalmasın.
  assert.ok(!/[çğıİöşüÇĞÖŞÜ]/.test(html.replace(/<!--[\s\S]*?-->/g, '')));
});

test('bildirim yazısı kayıt adresindeki dili izler, uygulama ekrandaysa gösterilmez', async () => {
  const vm = require('node:vm');
  const code = fs.readFileSync(path.join(__dirname, 'public/sw.js'), 'utf8');
  const fire = async (search, state) => {
    const handlers = {};
    const shown = [];
    vm.runInNewContext(code, {
      URLSearchParams,
      self: { location: { search }, addEventListener: (name, fn) => { handlers[name] = fn; } },
      clients: { matchAll: async () => [{ visibilityState: state }] },
      registration: { showNotification: async (title, options) => shown.push(options.body) },
    });
    let done;
    handlers.push({ waitUntil: (p) => { done = p; } });
    await done;
    return shown;
  };
  assert.deepEqual(await fire('?lang=tr', 'hidden'), ['Yeni mesaj']);
  assert.deepEqual(await fire('?lang=en', 'hidden'), ['New message']);
  assert.deepEqual(await fire('', 'hidden'), ['New message']);
  assert.deepEqual(await fire('?lang=tr', 'visible'), []);
});

test('yedek veritabanını ve fotoğrafları içerir', async () => {
  const target = path.join(dir, 'yedekler');
  const out = cli('backup', target);
  const made = /Backup saved: (.+)/.exec(out)[1].trim();
  assert.ok(fs.statSync(path.join(made, 'aticom.db')).size > 0);
  assert.ok(fs.readdirSync(path.join(made, 'uploads')).length >= 1);
});
