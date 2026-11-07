'use strict';
// ATICOM sunucusu. Dış bağımlılık yok: Node'un http, sqlite ve crypto modülleri yeterli.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS = path.join(DATA, 'uploads');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // internete açmak için önüne HTTPS'li ters vekil koy
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const SESSION_DAYS = 30;
const INVITE_DAYS = 7;
const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_MESSAGE = 4000;
const PAGE = 50;

fs.mkdirSync(UPLOADS, { recursive: true });
const db = new DatabaseSync(path.join(DATA, 'aticom.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    pass TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sessions (
    hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS invites (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS convos (
    id INTEGER PRIMARY KEY,
    title TEXT,
    dm_key TEXT UNIQUE
  );
  CREATE TABLE IF NOT EXISTS members (
    convo_id INTEGER NOT NULL REFERENCES convos(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    last_read INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (convo_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS members_user ON members(user_id);
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    convo_id INTEGER NOT NULL REFERENCES convos(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    body TEXT NOT NULL DEFAULT '',
    image TEXT UNIQUE,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_convo ON messages(convo_id, id);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS push_subs (
    endpoint TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id)
  );
`);
// Önceki sürümle oluşmuş veritabanlarına yanıt sütunu eklenir; eski mesajlar olduğu gibi kalır.
if (!db.prepare("SELECT 1 FROM pragma_table_info('messages') WHERE name = 'reply_to'").get()) {
  db.exec('ALTER TABLE messages ADD COLUMN reply_to INTEGER');
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const str = (v) => (typeof v === 'string' ? v : '');
const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const key = await scrypt(password, salt, 32, SCRYPT);
  return `${salt}:${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const candidate = await hashPassword(password, stored.split(':')[0]);
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(stored));
}

function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// message, istemcinin çevirdiği hata kodudur (public/i18n.js içindeki err.*).
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---- Yönetici komutları: node server.js invite | remove <kullanıcı> | reset <kullanıcı> | backup <klasör>
function runCommand([cmd, arg]) {
  const findUser = () => {
    const u = db.prepare('SELECT id FROM users WHERE username = ? AND disabled = 0').get(str(arg));
    if (!u) throw new Error(`Kullanıcı bulunamadı: ${arg}`);
    return u;
  };
  const randomPassword = () => crypto.randomBytes(9).toString('base64url');
  const commands = {
    invite() {
      const code = crypto.randomBytes(16).toString('hex');
      db.prepare('INSERT INTO invites VALUES (?, ?)').run(sha256(code), Date.now() + INVITE_DAYS * 864e5);
      console.log(`${BASE_URL}/#davet=${code}\n(Tek kullanımlık, ${INVITE_DAYS} gün geçerli.)`);
    },
    remove() {
      disableUser(findUser().id);
      console.log(`${arg} gruptan çıkarıldı.`);
    },
    async reset() {
      const { id } = findUser();
      const password = randomPassword();
      const pass = await hashPassword(password);
      transaction(() => {
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
        db.prepare('UPDATE users SET pass = ? WHERE id = ?').run(pass, id);
      });
      console.log(`Yeni geçici şifre: ${password}\n(Kullanıcı girişten sonra Profil'den değiştirmeli.)`);
    },
    backup() {
      if (!arg) throw new Error('Yedek klasörü belirt: node server.js backup <klasör>');
      const dir = path.join(arg, new Date().toISOString().replace(/[:.]/g, '-'));
      fs.mkdirSync(dir, { recursive: true });
      db.prepare('VACUUM INTO ?').run(path.join(dir, 'aticom.db'));
      fs.cpSync(UPLOADS, path.join(dir, 'uploads'), { recursive: true });
      console.log(`Yedek alındı: ${dir}`);
    },
  };
  if (!commands[cmd]) throw new Error('Komutlar: invite | remove <kullanıcı> | reset <kullanıcı> | backup <klasör>');
  return commands[cmd]();
}

// Mesajlar sohbet geçmişi bozulmasın diye kalır; giriş tamamen kapanır.
function disableUser(id) {
  transaction(() => {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM push_subs WHERE user_id = ?').run(id);
    db.prepare("UPDATE users SET disabled = 1, pass = '' WHERE id = ?").run(id);
  });
}

// ---- Oturum
function sessionHash(req) {
  const m = /(?:^|;\s*)sid=([0-9a-f]{64})/.exec(req.headers.cookie || '');
  return m ? sha256(m[1]) : null;
}

const sessionUser = db.prepare(`
  SELECT u.id, u.username, u.name FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.hash = ? AND s.expires > ? AND u.disabled = 0`);
const validSession = (hash) => sessionUser.get(hash, Date.now());

function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const maxAge = SESSION_DAYS * 86400;
  db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(sha256(token), userId, Date.now() + maxAge * 1000);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`);
}

// Kaba kuvvet koruması: yalnızca var olan kullanıcılar sayılır, böylece tablo sınırsız büyümez.
const failedLogins = new Map();
const LOCK_AFTER = 10;
const LOCK_MS = 15 * 60 * 1000;
const DUMMY_HASH = `${'0'.repeat(32)}:${'0'.repeat(64)}`;

// ---- Canlı akış (SSE)
const streams = new Map(); // userId -> Set<res>

function publish(convoId, event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const { user_id } of db.prepare('SELECT user_id FROM members WHERE convo_id = ?').all(convoId)) {
    for (const res of streams.get(user_id) || []) res.write(data);
  }
}

// Çıkarılan kullanıcının açık bağlantısı da en geç bir nabız sonra kapanır.
setInterval(() => {
  for (const set of streams.values()) {
    for (const res of set) {
      if (validSession(res.sessionHash)) res.write(': nabız\n\n');
      else res.end();
    }
  }
}, 25000).unref();

// ---- Telefon bildirimi (Web Push)
// İçerik gönderilmez: bildirimde yalnızca "Yeni mesaj" yazar, mesaj bildirim servisinden geçmez.
// Sunucu istemcinin verdiği adrese istek attığı için yalnızca bilinen servislere izin verilir.
const PUSH_ORIGINS = new Set(
  (process.env.PUSH_ORIGINS || 'https://fcm.googleapis.com,https://updates.push.services.mozilla.com').split(','),
);

// Anahtar veritabanında durur ki yedekten dönünce aboneler geçersiz kalmasın.
function loadVapid() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  db.prepare("INSERT OR IGNORE INTO settings VALUES ('vapid', ?)").run(JSON.stringify(privateKey.export({ format: 'jwk' })));
  const jwk = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'vapid'").get().value);
  return {
    key: crypto.createPrivateKey({ key: jwk, format: 'jwk' }),
    publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url'),
  };
}
const vapid = loadVapid();

function vapidHeader(audience) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sub = BASE_URL.startsWith('https://') ? BASE_URL : 'mailto:admin@example.com';
  const data = `${b64({ typ: 'JWT', alg: 'ES256' })}.${b64({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub })}`;
  const signature = crypto.sign('sha256', Buffer.from(data), { key: vapid.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `vapid t=${data}.${signature}, k=${vapid.publicKey}`;
}

async function pushOne(endpoint) {
  const res = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: {
      Authorization: vapidHeader(new URL(endpoint).origin),
      TTL: '86400', // telefon kapalıysa bir gün boyunca teslim edilmeyi bekler
      Urgency: 'high',
    },
  });
  if (res.status === 404 || res.status === 410) db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(endpoint);
  else if (!res.ok) console.error(`Bildirim gönderilemedi (${res.status}): ${new URL(endpoint).origin}`);
}

// Mesajın kaydedilmesini beklemez; bildirim hatası mesaj göndermeyi asla bozmaz.
function pushToMembers(convoId, senderId) {
  const subs = db.prepare(`SELECT p.endpoint FROM push_subs p JOIN members m ON m.user_id = p.user_id
                           WHERE m.convo_id = ? AND p.user_id != ?`).all(convoId, senderId);
  for (const { endpoint } of subs) pushOne(endpoint).catch((e) => console.error('Bildirim hatası:', e.message));
}

// ---- Yardımcılar
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) reject(new HttpError(413, 'tooLarge'));
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  try {
    const value = JSON.parse((await readBody(req, 64 * 1024)).toString());
    if (value && typeof value === 'object') return value;
  } catch (e) {
    if (e instanceof HttpError) throw e;
  }
  throw new HttpError(400, 'badRequest');
}

function requireMember(convoId, userId) {
  const row = db.prepare('SELECT 1 FROM members WHERE convo_id = ? AND user_id = ?').get(convoId, userId);
  if (!row) throw new HttpError(404, 'convoNotFound');
}

// Grup ayarları özel sohbette yoktur.
function requireGroup(convoId, userId) {
  requireMember(convoId, userId);
  if (db.prepare('SELECT dm_key FROM convos WHERE id = ?').get(convoId).dm_key) throw new HttpError(400, 'notGroup');
}

function otherUsers(value, selfId) {
  const ids = [...new Set(Array.isArray(value) ? value : [])].filter((id) => id !== selfId);
  if (!ids.length || ids.length > 200 || !ids.every(Number.isInteger)) throw new HttpError(400, 'pickPerson');
  const active = db.prepare('SELECT 1 FROM users WHERE id = ? AND disabled = 0');
  if (!ids.every((id) => active.get(id))) throw new HttpError(400, 'personNotFound');
  return ids;
}

// Yanıtlanan mesaj aynı sohbette olmalı; başka sohbetten alıntı yapılamaz.
function replyTarget(convoId, value) {
  if (value === undefined || value === null || value === '') return null;
  const id = Number(value);
  if (!Number.isInteger(id) || !db.prepare('SELECT 1 FROM messages WHERE id = ? AND convo_id = ?').get(id, convoId)) {
    throw new HttpError(400, 'badRequest');
  }
  return id;
}

function checkPassword(password) {
  if (password.length < 8 || password.length > 200) throw new HttpError(400, 'passwordLength');
}

function cleanName(value) {
  const name = str(value).trim();
  if (!name || name.length > 50) throw new HttpError(400, 'nameLength');
  return name;
}

const MESSAGE_SELECT = `
  SELECT m.id, m.convo_id AS convoId, m.user_id AS userId, u.name, m.body, m.image, m.at,
    r.id AS replyId, ru.name AS replyName, substr(r.body, 1, 200) AS replyBody, r.image AS replyImage
  FROM messages m JOIN users u ON u.id = m.user_id
  LEFT JOIN messages r ON r.id = m.reply_to LEFT JOIN users ru ON ru.id = r.user_id`;

function addMessage(convoId, userId, body, image, replyTo) {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO messages (convo_id, user_id, body, image, at, reply_to) VALUES (?, ?, ?, ?, ?, ?)')
    .run(convoId, userId, body, image, Date.now(), replyTo);
  db.prepare('UPDATE members SET last_read = ? WHERE convo_id = ? AND user_id = ?').run(lastInsertRowid, convoId, userId);
  const message = db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(lastInsertRowid);
  publish(convoId, { type: 'message', message });
  pushToMembers(convoId, userId);
  return message;
}

// Tür dosya adından değil içerikten belirlenir; SVG gibi betik taşıyabilen türler kabul edilmez.
function imageExtension(b) {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  // Sesli mesaj: Chrome WebM, Firefox Ogg kaydeder.
  if (b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'webm';
  if (b.subarray(0, 4).toString('latin1') === 'OggS') return 'ogg';
  return null;
}
const IMAGE_TYPES = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', webm: 'audio/webm', ogg: 'audio/ogg' };

// ---- API
const routes = [];
const route = (method, pattern, fn, open = false) => routes.push({ method, pattern, fn, open });

route('POST', /^\/api\/register$/, async ({ req, res }) => {
  const b = await readJson(req);
  const username = str(b.username).trim();
  const password = str(b.password);
  const name = cleanName(b.name);
  if (!/^[a-zA-Z0-9_.]{3,30}$/.test(username)) {
    throw new HttpError(400, 'usernameFormat');
  }
  checkPassword(password);
  const pass = await hashPassword(password);
  const id = transaction(() => {
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      throw new HttpError(409, 'usernameTaken');
    }
    // Davet ancak kayıt başarılı olursa harcanır; hata olursa işlem geri alınır.
    const used = db.prepare('DELETE FROM invites WHERE hash = ? AND expires > ?').run(sha256(str(b.invite).trim()), Date.now());
    if (used.changes !== 1) throw new HttpError(403, 'inviteInvalid');
    return db.prepare('INSERT INTO users (username, name, pass) VALUES (?, ?, ?)').run(username, name, pass).lastInsertRowid;
  });
  startSession(req, res, id);
  return { id: Number(id), username, name };
}, true);

route('POST', /^\/api\/login$/, async ({ req, res }) => {
  const b = await readJson(req);
  const username = str(b.username).trim();
  const user = db.prepare('SELECT id, username, name, pass FROM users WHERE username = ? AND disabled = 0').get(username);
  const lock = user && failedLogins.get(user.id);
  if (lock && lock.count >= LOCK_AFTER && lock.until > Date.now()) {
    throw new HttpError(429, 'tooManyAttempts');
  }
  // Kullanıcı yoksa da aynı hesap yapılır ki süre farkından kullanıcı adı anlaşılmasın.
  const ok = await verifyPassword(str(b.password).slice(0, 200), user ? user.pass : DUMMY_HASH);
  if (!user || !ok) {
    if (user) {
      const expired = !lock || lock.until <= Date.now();
      failedLogins.set(user.id, { count: expired ? 1 : lock.count + 1, until: Date.now() + LOCK_MS });
    }
    throw new HttpError(401, 'badLogin');
  }
  failedLogins.delete(user.id);
  startSession(req, res, user.id);
  return { id: user.id, username: user.username, name: user.name };
}, true);

route('POST', /^\/api\/logout$/, ({ req, res }) => {
  db.prepare('DELETE FROM sessions WHERE hash = ?').run(sessionHash(req));
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  return {};
});

route('GET', /^\/api\/me$/, ({ user }) => user);

route('PATCH', /^\/api\/me$/, async ({ req, user }) => {
  const b = await readJson(req);
  const name = b.name === undefined ? user.name : cleanName(b.name);
  if (b.newPassword !== undefined) {
    const newPassword = str(b.newPassword);
    checkPassword(newPassword);
    const { pass } = db.prepare('SELECT pass FROM users WHERE id = ?').get(user.id);
    if (!(await verifyPassword(str(b.currentPassword).slice(0, 200), pass))) {
      throw new HttpError(403, 'badCurrentPassword');
    }
    const hashed = await hashPassword(newPassword);
    transaction(() => {
      db.prepare('UPDATE users SET pass = ? WHERE id = ?').run(hashed, user.id);
      // Şifre değişince bu cihaz dışındaki oturumlar kapanır.
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND hash != ?').run(user.id, sessionHash(req));
    });
  }
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, user.id);
  return { id: user.id, username: user.username, name };
});

route('DELETE', /^\/api\/me$/, async ({ req, res, user }) => {
  const { pass } = db.prepare('SELECT pass FROM users WHERE id = ?').get(user.id);
  if (!(await verifyPassword(str((await readJson(req)).password).slice(0, 200), pass))) {
    throw new HttpError(403, 'badCurrentPassword');
  }
  disableUser(user.id);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  return {};
});

route('GET', /^\/api\/push-key$/, () => ({ key: vapid.publicKey }));

route('POST', /^\/api\/push$/, async ({ req, user }) => {
  const endpoint = str((await readJson(req)).endpoint);
  let origin = null;
  try {
    origin = new URL(endpoint).origin;
  } catch {}
  if (endpoint.length > 1000 || !PUSH_ORIGINS.has(origin)) throw new HttpError(400, 'pushUnsupported');
  // Aynı telefonda başka hesaba geçildiyse bildirim yeni hesaba ait olur.
  db.prepare(`INSERT INTO push_subs (endpoint, user_id) VALUES (?, ?)
              ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id`).run(endpoint, user.id);
  return {};
});

route('DELETE', /^\/api\/push$/, async ({ req, user }) => {
  db.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').run(str((await readJson(req)).endpoint), user.id);
  return {};
});

route('GET', /^\/api\/users$/, ({ user }) =>
  db.prepare('SELECT id, username, name FROM users WHERE disabled = 0 AND id != ? ORDER BY name').all(user.id));

route('GET', /^\/api\/convos$/, ({ user }) =>
  db.prepare(`
    SELECT c.id, c.title,
      (SELECT json_group_array(json_object('id', u.id, 'name', u.name, 'lastRead', x.last_read))
         FROM members x JOIN users u ON u.id = x.user_id WHERE x.convo_id = c.id AND u.disabled = 0) AS members,
      (SELECT COUNT(*) FROM messages n
         WHERE n.convo_id = c.id AND n.id > me.last_read AND n.user_id != me.user_id) AS unread,
      l.id AS lastId, l.body AS lastBody, l.image AS lastImage, l.at AS lastAt
    FROM members me
    JOIN convos c ON c.id = me.convo_id
    LEFT JOIN messages l ON l.id = (SELECT MAX(id) FROM messages WHERE convo_id = c.id)
    WHERE me.user_id = ?
    ORDER BY COALESCE(l.id, 0) DESC, c.id DESC`)
    .all(user.id)
    .map((c) => ({ ...c, members: JSON.parse(c.members) })));

route('POST', /^\/api\/convos$/, async ({ req, user }) => {
  const b = await readJson(req);
  const others = otherUsers(b.userIds, user.id);

  const isDm = others.length === 1;
  const title = isDm ? null : cleanName(b.title);
  const dmKey = isDm ? [user.id, others[0]].sort((a, z) => a - z).join(':') : null;
  const existing = isDm && db.prepare('SELECT id FROM convos WHERE dm_key = ?').get(dmKey);
  if (existing) return { id: existing.id };

  const id = transaction(() => {
    const convoId = db.prepare('INSERT INTO convos (title, dm_key) VALUES (?, ?)').run(title, dmKey).lastInsertRowid;
    const add = db.prepare('INSERT INTO members (convo_id, user_id) VALUES (?, ?)');
    for (const memberId of [user.id, ...others]) add.run(convoId, memberId);
    return Number(convoId);
  });
  publish(id, { type: 'convo' });
  return { id };
});

route('PATCH', /^\/api\/convos\/(\d+)$/, async ({ req, user, match }) => {
  const convoId = Number(match[1]);
  requireGroup(convoId, user.id);
  db.prepare('UPDATE convos SET title = ? WHERE id = ?').run(cleanName((await readJson(req)).title), convoId);
  publish(convoId, { type: 'convo' });
  return {};
});

route('POST', /^\/api\/convos\/(\d+)\/members$/, async ({ req, user, match }) => {
  const convoId = Number(match[1]);
  requireGroup(convoId, user.id);
  const ids = otherUsers((await readJson(req)).userIds, user.id);
  transaction(() => {
    // Yeni üye eski mesajları görür ama hepsi okunmamış sayılmaz.
    const { max } = db.prepare('SELECT COALESCE(MAX(id), 0) AS max FROM messages WHERE convo_id = ?').get(convoId);
    const add = db.prepare('INSERT OR IGNORE INTO members (convo_id, user_id, last_read) VALUES (?, ?, ?)');
    for (const id of ids) add.run(convoId, id, max);
  });
  publish(convoId, { type: 'convo' });
  return {};
});

route('DELETE', /^\/api\/convos\/(\d+)\/members\/me$/, ({ user, match }) => {
  const convoId = Number(match[1]);
  requireGroup(convoId, user.id);
  publish(convoId, { type: 'convo' }); // ayrılanın diğer cihazları da duysun diye silmeden önce
  db.prepare('DELETE FROM members WHERE convo_id = ? AND user_id = ?').run(convoId, user.id);
  return {};
});

route('POST', /^\/api\/convos\/(\d+)\/typing$/, async ({ req, user, match }) => {
  const convoId = Number(match[1]);
  requireMember(convoId, user.id);
  const kind = (await readJson(req)).kind === 'voice' ? 'voice' : 'text';
  publish(convoId, { type: 'typing', convoId, userId: user.id, name: user.name, kind });
  return {};
});

route('GET', /^\/api\/convos\/(\d+)\/messages$/, ({ user, match, url }) => {
  const convoId = Number(match[1]);
  requireMember(convoId, user.id);
  const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
  return db.prepare(`${MESSAGE_SELECT} WHERE m.convo_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`)
    .all(convoId, before, PAGE)
    .reverse();
});

route('POST', /^\/api\/convos\/(\d+)\/messages$/, async ({ req, user, match }) => {
  const convoId = Number(match[1]);
  requireMember(convoId, user.id);
  const b = await readJson(req);
  const body = str(b.body).trim();
  if (!body || body.length > MAX_MESSAGE) throw new HttpError(400, 'messageLength');
  return addMessage(convoId, user.id, body, null, replyTarget(convoId, b.replyTo));
});

route('POST', /^\/api\/convos\/(\d+)\/images$/, async ({ req, user, match, url }) => {
  const convoId = Number(match[1]);
  requireMember(convoId, user.id);
  const replyTo = replyTarget(convoId, url.searchParams.get('replyTo'));
  const data = await readBody(req, MAX_IMAGE);
  const ext = imageExtension(data);
  if (!ext) throw new HttpError(415, 'imageType');
  const file = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  await fs.promises.writeFile(path.join(UPLOADS, file), data);
  return addMessage(convoId, user.id, '', file, replyTo);
});

route('POST', /^\/api\/convos\/(\d+)\/read$/, ({ user, match }) => {
  const convoId = Number(match[1]);
  requireMember(convoId, user.id);
  const { max } = db.prepare('SELECT COALESCE(MAX(id), 0) AS max FROM messages WHERE convo_id = ?').get(convoId);
  const { changes } = db.prepare('UPDATE members SET last_read = ? WHERE convo_id = ? AND user_id = ? AND last_read < ?')
    .run(max, convoId, user.id, max);
  // Yalnızca gerçekten yeni bir şey okunduysa duyurulur; gönderenin ekranında çift tik olur.
  if (changes) publish(convoId, { type: 'read', convoId, userId: user.id, lastRead: max });
  return {};
});

route('GET', /^\/api\/events$/, ({ req, res, user }) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });
  res.write(': bağlandı\n\n');
  res.sessionHash = sessionHash(req);
  if (!streams.has(user.id)) streams.set(user.id, new Set());
  const set = streams.get(user.id);
  set.add(res);
  res.on('close', () => {
    set.delete(res);
    if (!set.size && streams.get(user.id) === set) streams.delete(user.id);
  });
});

// Fotoğrafı yalnızca o sohbetin üyeleri görebilir; adı bilinse bile başkasına açılmaz.
route('GET', /^\/uploads\/([0-9a-f]{32}\.(jpg|png|gif|webp|webm|ogg))$/, ({ res, user, match }) => {
  const allowed = db.prepare(`
    SELECT 1 FROM messages m JOIN members x ON x.convo_id = m.convo_id
    WHERE m.image = ? AND x.user_id = ?`).get(match[1], user.id);
  if (!allowed) throw new HttpError(404, 'notFound');
  res.writeHead(200, {
    'Content-Type': IMAGE_TYPES[match[2]],
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
  pipeline(fs.createReadStream(path.join(UPLOADS, match[1])), res, (err) => {
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error(err);
  });
});

// ---- Statik dosyalar: yalnızca public/ içindekiler, başlangıçta belleğe alınır.
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};
const staticFiles = new Map();
for (const file of fs.readdirSync(path.join(__dirname, 'public'))) {
  staticFiles.set(`/${file}`, {
    type: CONTENT_TYPES[path.extname(file)],
    content: fs.readFileSync(path.join(__dirname, 'public', file)),
  });
}
staticFiles.set('/', staticFiles.get('/index.html'));

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  // Çerez SameSite=Strict; bu kontrol başka siteden gelen yazma isteklerine karşı ikinci kilit.
  const origin = req.headers.origin;
  if (req.method !== 'GET' && origin && origin.replace(/^https?:\/\//, '') !== req.headers.host) {
    throw new HttpError(403, 'badOrigin');
  }
  for (const r of routes) {
    const match = r.method === req.method && r.pattern.exec(url.pathname);
    if (!match) continue;
    const hash = sessionHash(req);
    const user = hash && validSession(hash);
    if (!r.open && !user) throw new HttpError(401, 'loginRequired');
    const out = await r.fn({ req, res, user, match, url });
    if (out !== undefined) sendJson(res, 200, out);
    return;
  }
  const file = req.method === 'GET' && staticFiles.get(url.pathname);
  if (!file) throw new HttpError(404, 'notFound');
  res.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'no-cache' });
  res.end(file.content);
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

if (process.argv[2]) {
  Promise.resolve()
    .then(() => runCommand(process.argv.slice(2)))
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
} else {
  http.createServer((req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    handle(req, res).catch((e) => {
      if (res.headersSent) return res.destroy();
      if (!(e instanceof HttpError)) console.error(e);
      if (e.status === 413) res.setHeader('Connection', 'close');
      sendJson(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'serverError' });
    });
  }).listen(PORT, HOST, () => console.log(`ATICOM çalışıyor: http://${HOST}:${PORT}`));
}
