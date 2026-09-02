/**
 * 每日AI打卡平台 - 后端服务 (零依赖, 仅使用 Node 内置模块)
 * 运行: node server.js   (可选环境变量 ADMIN_PASSWORD / PORT)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(ROOT, 'uploads');
const PUBLIC_DIR = path.join(ROOT, 'public');
[DATA_DIR, UPLOAD_DIR, PUBLIC_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));

const DB_FILE = path.join(DATA_DIR, 'db.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_BODY = 400 * 1024 * 1024; // 允许最大请求体 400MB (多图 base64 后约 3×133MB)
const RESERVED_NAME = '行政君';
const TARGET_DAYS = 10; // 月度达标天数

// 图片大小上限(云端持久化下, 大图 base64 会撑爆数据库, 故设上限; 可用 MAX_IMAGE_MB 调整)
const MAX_IMAGE_MB = parseInt(process.env.MAX_IMAGE_MB || '20', 10);

// ---------- 持久化后端: Supabase Postgres (DATABASE_URL) 或本地 JSON 文件 ----------
// 仅当配置 DATABASE_URL 时启用 Postgres; 整个 db 作为单个 jsonb 行存储, 图片以 base64 直接存入(不再落临时磁盘)
const STATE_KEY = 'db';
let pgPool = null;
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    console.log('[db] 检测到 DATABASE_URL, 启用 Supabase Postgres 持久化');
  } catch (e) {
    console.error('[db] 加载 pg 失败, 回退本地 JSON 文件:', e.message);
  }
}

// 生成内置渐变占位 Banner（SVG data URI），首次打开即有轮播，后台可随时替换
function gradientBanner(c1, c2) {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='720' height='240' viewBox='0 0 720 240'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
    `<stop offset='0' stop-color='${c1}'/><stop offset='1' stop-color='${c2}'/></linearGradient></defs>` +
    `<rect width='720' height='240' fill='url(#g)'/>` +
    `<circle cx='120' cy='50' r='110' fill='rgba(255,255,255,0.10)'/>` +
    `<circle cx='620' cy='210' r='150' fill='rgba(255,255,255,0.08)'/>` +
    `<circle cx='430' cy='40' r='46' fill='rgba(255,255,255,0.12)'/>` +
    `</svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}
const DEFAULT_BANNERS = [
  gradientBanner('#4f6ef7', '#7b5cf0'),
  gradientBanner('#1fb6a8', '#4f6ef7'),
  gradientBanner('#ff8a5c', '#f368e0'),
];

let db = null; // 由 bootstrap() 异步加载
function defaultDB() {
  return {
    users: [],
    checkins: [],
    likes: [],
    comments: [],
    config: { banners: DEFAULT_BANNERS, bannerTitle: '每日AI打卡', reminderWebhook: '', reminderType: '' },
  };
}
async function loadDB() {
  if (pgPool) {
    await pgPool.query('CREATE TABLE IF NOT EXISTS state (key text primary key, value jsonb)');
    const r = await pgPool.query('SELECT value FROM state WHERE key=$1', [STATE_KEY]);
    if (r.rows.length) return r.rows[0].value;
    const seed = defaultDB();
    await pgPool.query('INSERT INTO state(key,value) VALUES($1,$2)', [STATE_KEY, seed]);
    return seed;
  }
  if (fs.existsSync(DB_FILE)) {
    try {
      const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      d.users = d.users || [];
      d.checkins = d.checkins || [];
      d.likes = d.likes || [];
      d.comments = d.comments || [];
      d.config = d.config || { banners: DEFAULT_BANNERS, bannerTitle: '每日AI打卡', reminderWebhook: '', reminderType: '' };
      return d;
    } catch (e) { /* ignore */ }
  }
  return defaultDB();
}
// 保存: pg 模式走串行写链(避免并发覆盖), 文件模式同步写
let _dbWriteChain = Promise.resolve();
function saveDB() {
  if (pgPool) {
    _dbWriteChain = _dbWriteChain
      .then(() => pgPool.query('INSERT INTO state(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', [STATE_KEY, db]))
      .catch((e) => console.error('[db] 保存失败:', e.message));
    return;
  }
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ---------- 工具函数 ----------
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function monthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function uid() { return crypto.randomUUID(); }
// 姓名归一：去所有空白字符（含首尾/中间空格），中文无大小写问题
function normName(s) { return String(s == null ? '' : s).replace(/\s+/g, '').trim(); }

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach((kv) => {
    const i = kv.indexOf('=');
    if (i > -1) out[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim());
  });
  return out;
}
function setCookie(res, name, value, maxAge = 60 * 60 * 24 * 365) {
  res.setHeader('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`);
}
function clearCookie(res, name) {
  res.setHeader('Set-Cookie', `${name}=; Path=/; Max-Age=0; HttpOnly`);
}
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function parseDataUrl(str) {
  if (typeof str !== 'string' || !str.startsWith('data:')) return null;
  const m = str.match(/^data:([^;]+);base64,(.*)$/s);
  if (!m) return null;
  const mime = m[1];
  const buf = Buffer.from(m[2], 'base64');
  const extMap = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
  const ext = extMap[mime] || 'bin';
  return { ext, buf, mime };
}
// 云端持久化: 直接以 base64 data URL 存储(图片随 db 一起进 Postgres, 不依赖临时磁盘)
function saveUpload(dataUrl, prefix) {
  if (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) return dataUrl;
  return null;
}
// 估算 data URL 解码后的字节数(用于图片大小上限校验)
function dataUrlBytes(d) {
  const i = String(d).indexOf(',');
  if (i < 0) return 0;
  return Math.ceil((d.length - i - 1) * 3 / 4);
}

// ---------- 业务辅助 ----------
function findUser(id) { return db.users.find((u) => u.id === id); }
function currentUser(req) {
  const cookies = parseCookies(req);
  if (!cookies.uid) return null;
  return findUser(cookies.uid) || null;
}
// 启动时合并同一工号的历史重复记录(清 Cookie/重登记导致), 保留官方账号或最早记录为主
function mergeDuplicateEmployees() {
  const byEmp = {};
  for (const u of db.users) {
    const key = String(u.employee_id || '').trim();
    if (!key) continue;
    (byEmp[key] = byEmp[key] || []).push(u);
  }
  let merged = 0;
  for (const key in byEmp) {
    const arr = byEmp[key];
    if (arr.length <= 1) continue;
    arr.sort((a, b) => {
      if (!!b.is_official !== !!a.is_official) return a.is_official ? -1 : 1; // 官方账号优先保留
      return (a.created_at < b.created_at ? -1 : 1); // 否则保留最早创建
    });
    const keep = arr[0];
    for (const dup of arr.slice(1)) {
      db.checkins.forEach((c) => { if (c.user_id === dup.id) c.user_id = keep.id; });
      db.likes.forEach((l) => { if (l.user_id === dup.id) l.user_id = keep.id; });
      db.comments.forEach((cm) => { if (cm.user_id === dup.id) cm.user_id = keep.id; });
      db.users = db.users.filter((u) => u.id !== dup.id);
      merged++;
    }
  }
  if (merged) { console.log(`[merge] 合并了 ${merged} 条重复工号记录`); saveDB(); }
}
function monthProgressFor(userId) {
  const m = monthStr();
  const days = new Set(db.checkins.filter((c) => c.user_id === userId && c.checkin_date.startsWith(m)).map((c) => c.checkin_date));
  const checked = days.size;
  return { checkedDays: checked, target: TARGET_DAYS, remaining: Math.max(0, TARGET_DAYS - checked), done: checked >= TARGET_DAYS };
}
function publicCheckin(c, meId) {
  const likeCount = db.likes.filter((l) => l.checkin_id === c.id).length;
  const commentCount = db.comments.filter((cm) => cm.checkin_id === c.id && !cm.hidden).length;
  const liked = meId ? db.likes.some((l) => l.checkin_id === c.id && l.user_id === meId) : false;
  const imageUrls = Array.isArray(c.imageUrls) ? c.imageUrls : (c.imageUrl ? [c.imageUrl] : []);
  return {
    id: c.id,
    displayName: c.display_name,
    avatar: c.avatar || null,
    text: c.text,
    imageUrl: imageUrls[0] || null, // 兼容老数据(单图)
    imageUrls,
    checkinDate: c.checkin_date,
    createdAt: c.created_at,
    isOfficial: !!c.is_official,
    likeCount,
    commentCount,
    liked,
    mine: meId ? c.user_id === meId : false,
  };
}
function publicComment(cm) {
  return { id: cm.id, displayName: cm.display_name, avatar: cm.avatar || null, text: cm.text, createdAt: cm.created_at, isOfficial: !!cm.is_official };
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsed.pathname;
    const method = req.method.toUpperCase();

    // 静态资源
    if (method === 'GET' && pathname.startsWith('/uploads/')) {
      return serveStatic(res, path.join(UPLOAD_DIR, path.normalize(pathname.slice('/uploads/'.length))));
    }
    if (method === 'GET' && (pathname === '/' || pathname.startsWith('/public/') || !pathname.startsWith('/api/'))) {
      const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/public\//, '');
      return serveStatic(res, path.join(PUBLIC_DIR, path.normalize(rel)));
    }

    // 非 API 一律拒绝
    if (!pathname.startsWith('/api/')) {
      res.writeHead(404); return res.end('Not Found');
    }

    const body = (method === 'POST' || method === 'PUT' || method === 'DELETE')
      ? await readBody(req).catch(() => '{}') : '';
    let payload = {};
    try { payload = body ? JSON.parse(body) : {}; } catch (e) { payload = {}; }

    // ====== 当前用户 / 注册 / 更新 ======
    if (pathname === '/api/me' && method === 'GET') {
      const u = currentUser(req);
      if (!u) return sendJSON(res, 200, { user: null });
      return sendJSON(res, 200, { user: publicUser(u), progress: monthProgressFor(u.id) });
    }

    // 智能身份识别(单入口): 工号+姓名; 工号不存在=首次登记(昵称必填), 存在且姓名匹配=认回老身份
    if ((pathname === '/api/identify' || pathname === '/api/register') && method === 'POST') {
      const empId = String(payload.employee_id || '').trim();
      const nameIn = normName(payload.real_name);
      if (!empId) return sendJSON(res, 400, { error: '请填写工号' });
      if (!nameIn) return sendJSON(res, 400, { error: '请填写真实姓名' });
      const existing = db.users.find((u) => String(u.employee_id || '').trim() === empId);
      if (!existing) {
        // 新用户首次登记
        const dn = String(payload.display_name || '').trim();
        if (!dn) return sendJSON(res, 400, { error: '首次登记请填写发布昵称' });
        if (dn === RESERVED_NAME) return sendJSON(res, 400, { error: '该昵称已被官方保留，请更换' });
        const user = {
          id: uid(), real_name: nameIn, employee_id: empId,
          display_name: dn, is_official: false, avatar: payload.avatar ? saveUpload(payload.avatar, 'avatar') : null,
          created_at: new Date().toISOString(),
        };
        db.users.push(user); saveDB();
        setCookie(res, 'uid', user.id);
        return sendJSON(res, 200, { user: publicUser(user), progress: monthProgressFor(user.id), isNew: true });
      }
      // 老用户认回: 姓名须匹配
      if (normName(existing.real_name) !== nameIn)
        return sendJSON(res, 400, { error: '姓名与登记信息不符，请核对或联系管理员' });
      if (typeof payload.display_name === 'string') {
        const dn = payload.display_name.trim();
        if (dn && dn !== RESERVED_NAME) existing.display_name = dn; // 顺手可改昵称
      }
      if (typeof payload.avatar === 'string' && payload.avatar.startsWith('data:')) {
        existing.avatar = saveUpload(payload.avatar, 'avatar');
      }
      saveDB();
      setCookie(res, 'uid', existing.id);
      return sendJSON(res, 200, { user: publicUser(existing), progress: monthProgressFor(existing.id), isNew: false });
    }

    if (pathname === '/api/me' && method === 'PUT') {
      const u = currentUser(req);
      if (!u) return sendJSON(res, 401, { error: '未登录' });
      if (typeof payload.display_name === 'string') {
        const dn = payload.display_name.trim();
        if (!dn) return sendJSON(res, 400, { error: '昵称不能为空' });
        if (dn === RESERVED_NAME && !u.is_official)
          return sendJSON(res, 400, { error: '该昵称已被官方保留，请更换' });
        u.display_name = dn; // 仅影响后续打卡, 历史记录已锁定
      }
      if (typeof payload.avatar === 'string' && payload.avatar.startsWith('data:')) {
        u.avatar = saveUpload(payload.avatar, 'avatar');
      }
      saveDB();
      return sendJSON(res, 200, { user: publicUser(u) });
    }

    // ====== 打卡动态墙 ======
    if (pathname === '/api/checkins' && method === 'GET') {
      const me = currentUser(req);
      const list = db.checkins.filter((c) => !c.hidden).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return sendJSON(res, 200, { checkins: list.map((c) => publicCheckin(c, me && me.id)) });
    }

    // 发布打卡 (一键: 后端从当前用户读取身份; 支持最多 3 张图片)
    if (pathname === '/api/checkins' && method === 'POST') {
      const u = currentUser(req);
      if (!u) return sendJSON(res, 401, { error: '请先完成身份登记' });
      const text = (payload.text || '').trim();
      if (!text) return sendJSON(res, 400, { error: '请填写文字介绍(AI提效案例)' });
      // 多图优先 images 数组, 兼容旧单图 image
      const images = [];
      if (Array.isArray(payload.images)) images.push(...payload.images.filter((x) => typeof x === 'string' && x.startsWith('data:')));
      else if (typeof payload.image === 'string' && payload.image.startsWith('data:')) images.push(payload.image);
      if (!images.length) return sendJSON(res, 400, { error: '请上传图片证明(最多 3 张)' });
      for (const img of images) {
        if (dataUrlBytes(img) > MAX_IMAGE_MB * 1024 * 1024)
          return sendJSON(res, 400, { error: `单张图片不能超过 ${MAX_IMAGE_MB}MB（云端持久化已开启，请压缩后重试）` });
      }
      const savedUrls = images.slice(0, 3).map((img) => saveUpload(img, 'checkin')).filter(Boolean);
      if (!savedUrls.length) return sendJSON(res, 400, { error: '图片格式不支持' });
      const t = todayStr();
      if (db.checkins.some((c) => c.user_id === u.id && c.checkin_date === t))
        return sendJSON(res, 400, { error: '今日已打卡, 明天再来喔' });
      const isOfficial = !!u.is_official;
      const rec = {
        id: uid(), user_id: u.id,
        display_name: isOfficial ? RESERVED_NAME : u.display_name,
        avatar: u.avatar || null, is_official: isOfficial,
        text, imageUrl: savedUrls[0], imageUrls: savedUrls, checkin_date: t, created_at: new Date().toISOString(), hidden: false,
      };
      db.checkins.push(rec); saveDB();
      return sendJSON(res, 200, { checkin: publicCheckin(rec, u.id), progress: monthProgressFor(u.id) });
    }

    // 点赞切换
    let m = pathname.match(/^\/api\/checkins\/([^/]+)\/like$/);
    if (m && method === 'POST') {
      const me = currentUser(req);
      if (!me) return sendJSON(res, 401, { error: '请先登录' });
      const cid = m[1];
      const c = db.checkins.find((x) => x.id === cid);
      if (!c || c.hidden) return sendJSON(res, 404, { error: '记录不存在' });
      const idx = db.likes.findIndex((l) => l.checkin_id === cid && l.user_id === me.id);
      if (idx > -1) db.likes.splice(idx, 1); else db.likes.push({ id: uid(), checkin_id: cid, user_id: me.id });
      saveDB();
      return sendJSON(res, 200, { likeCount: db.likes.filter((l) => l.checkin_id === cid).length, liked: idx === -1 });
    }

    // 评论列表 / 新增
    m = pathname.match(/^\/api\/checkins\/([^/]+)\/comments$/);
    if (m && method === 'GET') {
      const cid = m[1];
      const list = db.comments.filter((cm) => cm.checkin_id === cid && !cm.hidden).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
      return sendJSON(res, 200, { comments: list.map(publicComment) });
    }
    if (m && method === 'POST') {
      const me = currentUser(req);
      if (!me) return sendJSON(res, 401, { error: '请先登录' });
      const cid = m[1];
      const c = db.checkins.find((x) => x.id === cid);
      if (!c || c.hidden) return sendJSON(res, 404, { error: '记录不存在' });
      const text = (payload.text || '').trim();
      if (!text) return sendJSON(res, 400, { error: '评论内容不能为空' });
      const isOfficial = !!me.is_official;
      const cm = {
        id: uid(), checkin_id: cid, user_id: me.id,
        display_name: isOfficial ? RESERVED_NAME : me.display_name, avatar: me.avatar || null,
        is_official: isOfficial, text, created_at: new Date().toISOString(), hidden: false,
      };
      db.comments.push(cm); saveDB();
      return sendJSON(res, 200, { comment: publicComment(cm) });
    }

    // ====== 排行榜 ======
    if (pathname === '/api/leaderboard' && method === 'GET') {
      const m = monthStr();
      const rows = db.users.map((u) => {
        const days = new Set(db.checkins.filter((c) => c.user_id === u.id && c.checkin_date.startsWith(m)).map((c) => c.checkin_date));
        return { id: u.id, displayName: u.display_name, avatar: u.avatar || null, checkedDays: days.size, done: days.size >= TARGET_DAYS, isOfficial: !!u.is_official };
      }).filter((r) => r.checkedDays > 0).sort((a, b) => (b.checkedDays - a.checkedDays) || (a.displayName < b.displayName ? -1 : 1));
      const totalUsers = db.users.length;
      const totalCheckins = db.checkins.length;
      const officialDone = db.users.filter((u) => { const d = new Set(db.checkins.filter((c) => c.user_id === u.id && c.checkin_date.startsWith(m)).map((c) => c.checkin_date)); return d.size >= TARGET_DAYS; }).length;
      return sendJSON(res, 200, { rows, stats: { totalUsers, totalCheckins, monthDone: officialDone } });
    }

    // ====== 后台管理 ======
    // 登录
    if (pathname === '/api/admin/login' && method === 'POST') {
      if (payload.password === ADMIN_PASSWORD) {
        setCookie(res, 'admin', '1', 60 * 60 * 12);
        return sendJSON(res, 200, { ok: true });
      }
      return sendJSON(res, 401, { error: '管理员密码错误' });
    }
    if (pathname === '/api/admin/logout' && method === 'POST') {
      clearCookie(res, 'admin'); return sendJSON(res, 200, { ok: true });
    }
    const isAdmin = parseCookies(req).admin === '1';

    // 公开：首页 Banner/标题配置（无需登录）
    if (pathname === '/api/config' && method === 'GET') {
      return sendJSON(res, 200, { config: { banners: db.config.banners, bannerTitle: db.config.bannerTitle } });
    }

    if (pathname === '/api/admin/config' && method === 'GET') {
      if (!isAdmin) return sendJSON(res, 401, { error: '未授权' });
      return sendJSON(res, 200, { config: { banners: db.config.banners, bannerTitle: db.config.bannerTitle, reminderWebhook: db.config.reminderWebhook, reminderType: db.config.reminderType } });
    }
    if (pathname === '/api/admin/config' && method === 'PUT') {
      if (!isAdmin) return sendJSON(res, 401, { error: '未授权' });
      if (Array.isArray(payload.banners)) {
        db.config.banners = payload.banners.map((b) => (b && b.startsWith('data:') ? (saveUpload(b, 'banner') || b) : b)).filter(Boolean);
      }
      if (typeof payload.bannerTitle === 'string' && payload.bannerTitle.trim()) db.config.bannerTitle = payload.bannerTitle.trim();
      if (typeof payload.reminderWebhook === 'string') db.config.reminderWebhook = payload.reminderWebhook.trim();
      if (typeof payload.reminderType === 'string') db.config.reminderType = payload.reminderType;
      saveDB();
      return sendJSON(res, 200, { ok: true, config: db.config });
    }

    if (pathname === '/api/admin/checkins' && method === 'GET') {
      if (!isAdmin) return sendJSON(res, 401, { error: '未授权' });
      const list = db.checkins.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map((c) => {
        const u = findUser(c.user_id);
        return {
          id: c.id, displayName: c.display_name, text: c.text, imageUrl: c.imageUrl,
          imageUrls: Array.isArray(c.imageUrls) ? c.imageUrls : (c.imageUrl ? [c.imageUrl] : []),
          checkinDate: c.checkin_date,
          createdAt: c.created_at, isOfficial: !!c.is_official, hidden: !!c.hidden,
          realName: u ? u.real_name : '(已注销)', employeeId: u ? u.employee_id : '-',
          likeCount: db.likes.filter((l) => l.checkin_id === c.id).length,
          commentCount: db.comments.filter((cm) => cm.checkin_id === c.id).length,
        };
      });
      return sendJSON(res, 200, { checkins: list });
    }
    // 隐藏/显示
    m = pathname.match(/^\/api\/admin\/checkins\/([^/]+)\/hide$/);
    if (m && method === 'POST') {
      if (!isAdmin) return sendJSON(res, 401, { error: '未授权' });
      const c = db.checkins.find((x) => x.id === m[1]);
      if (!c) return sendJSON(res, 404, { error: '不存在' });
      c.hidden = !c.hidden; saveDB();
      return sendJSON(res, 200, { hidden: c.hidden });
    }
    // 删除
    m = pathname.match(/^\/api\/admin\/checkins\/([^/]+)$/);
    if (m && method === 'DELETE') {
      if (!isAdmin) return sendJSON(res, 401, { error: '未授权' });
      const cid = m[1];
      db.checkins = db.checkins.filter((c) => c.id !== cid);
      db.likes = db.likes.filter((l) => l.checkin_id !== cid);
      db.comments = db.comments.filter((cm) => cm.checkin_id !== cid);
      saveDB();
      return sendJSON(res, 200, { ok: true });
    }
    // 评论管理
    m = pathname.match(/^\/api\/admin\/comments\/([^/]+)$/);
    if (m && method === 'DELETE') {
      if (!isAdmin) return sendJSON(res, 401, { error: '未授权' });
      const cmid = m[1];
      const cm = db.comments.find((x) => x.id === cmid);
      if (!cm) return sendJSON(res, 404, { error: '不存在' });
      cm.hidden = true; saveDB(); // 软隐藏
      return sendJSON(res, 200, { ok: true });
    }

    // 官方账号发布 (行政君) - 支持最多 3 张图片
    if (pathname === '/api/admin/checkin' && method === 'POST') {
      if (!isAdmin) return sendJSON(res, 401, { error: '未授权' });
      const text = (payload.text || '').trim();
      if (!text) return sendJSON(res, 400, { error: '请填写内容' });
      const images = [];
      if (Array.isArray(payload.images)) images.push(...payload.images.filter((x) => typeof x === 'string' && x.startsWith('data:')));
      else if (typeof payload.image === 'string' && payload.image.startsWith('data:')) images.push(payload.image);
      for (const img of images) {
        if (dataUrlBytes(img) > MAX_IMAGE_MB * 1024 * 1024)
          return sendJSON(res, 400, { error: `单张图片不能超过 ${MAX_IMAGE_MB}MB（云端持久化已开启，请压缩后重试）` });
      }
      const savedUrls = images.slice(0, 3).map((img) => saveUpload(img, 'checkin')).filter(Boolean);
      const rec = {
        id: uid(), user_id: 'official', display_name: RESERVED_NAME, avatar: null, is_official: true,
        text, imageUrl: savedUrls[0] || null, imageUrls: savedUrls, checkin_date: todayStr(), created_at: new Date().toISOString(), hidden: false,
      };
      db.checkins.push(rec); saveDB();
      return sendJSON(res, 200, { ok: true, checkin: publicCheckin(rec, null) });
    }

    // 指定用户为官方账号
    m = pathname.match(/^\/api\/admin\/users\/([^/]+)\/official$/);
    if (m && method === 'POST') {
      if (!isAdmin) return sendJSON(res, 401, { error: '未授权' });
      const u = findUser(m[1]);
      if (!u) return sendJSON(res, 404, { error: '用户不存在' });
      u.is_official = !u.is_official; saveDB();
      return sendJSON(res, 200, { is_official: u.is_official });
    }

    // 数据导出 (CSV, Excel 可直接打开)
    if (pathname === '/api/admin/export' && method === 'GET') {
      if (!isAdmin) return sendJSON(res, 401, { error: '未授权' });
      const header = ['打卡日期', '真实姓名', '工号', '发布昵称', '是否官方', '内容', '点赞数', '评论数', '发布时间'];
      const lines = [header];
      db.checkins.slice().sort((a, b) => (a.checkin_date < b.checkin_date ? -1 : 1)).forEach((c) => {
        const u = findUser(c.user_id);
        lines.push([
          c.checkin_date, u ? u.real_name : '(已注销)', u ? u.employee_id : '-', c.display_name,
          c.is_official ? '是' : '否', c.text, db.likes.filter((l) => l.checkin_id === c.id).length,
          db.comments.filter((cm) => cm.checkin_id === c.id).length, c.created_at,
        ]);
      });
      const csv = '﻿' + lines.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="checkin_export.csv"' });
      return res.end(csv);
    }

    // 月度达标汇总导出 (按用户)
    if (pathname === '/api/admin/export-summary' && method === 'GET') {
      if (!isAdmin) return sendJSON(res, 401, { error: '未授权' });
      const m = monthStr();
      const header = ['真实姓名', '工号', '发布昵称', '本月打卡天数', '是否达标'];
      const lines = [header];
      db.users.forEach((u) => {
        const days = new Set(db.checkins.filter((c) => c.user_id === u.id && c.checkin_date.startsWith(m)).map((c) => c.checkin_date)).size;
        lines.push([u.real_name, u.employee_id, u.display_name, days, days >= TARGET_DAYS ? '是' : '否']);
      });
      const csv = '﻿' + lines.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="checkin_summary.csv"' });
      return res.end(csv);
    }

    // 打卡提醒推送 (钉钉/企微 webhook)
    if (pathname === '/api/admin/reminder' && method === 'POST') {
      if (!isAdmin) return sendJSON(res, 401, { error: '未授权' });
      if (!db.config.reminderWebhook) return sendJSON(res, 400, { error: '请先在配置中填写推送 Webhook 地址' });
      const t = todayStr();
      const done = db.checkins.filter((c) => c.checkin_date === t).length;
      const content = `【每日AI打卡提醒】${db.config.bannerTitle}：今天已有 ${done} 人打卡，距月度达标还差一些天数，快来打卡吧！\n立即打开平台完成今日打卡 >>`;
      const ok = await pushWebhook(db.config.reminderWebhook, db.config.reminderType, content);
      return sendJSON(res, ok ? 200 : 502, { ok, msg: ok ? '推送成功' : '推送失败, 请检查 Webhook' });
    }

    // 未知
    return sendJSON(res, 404, { error: '接口不存在' });
  } catch (err) {
    console.error(err);
    sendJSON(res, 500, { error: '服务器错误: ' + err.message });
  }
});

function serveStatic(res, filePath) {
  try {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  } catch (e) {
    res.writeHead(404); res.end('Not Found');
  }
}

function publicUser(u) {
  return { id: u.id, displayName: u.display_name, realName: u.real_name, employeeId: u.employee_id, isOfficial: !!u.is_official, avatar: u.avatar || null };
}

function pushWebhook(webhook, type, content) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(webhook); } catch (e) { return resolve(false); }
    const bodyObj = { msgtype: 'text', text: { content } };
    const body = JSON.stringify(bodyObj);
    const lib = target.protocol === 'https:' ? require('https') : require('http');
    const opts = {
      hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 8000,
    };
    const r = lib.request(opts, (resp) => {
      let d = '';
      resp.on('data', (c) => (d += c));
      resp.on('end', () => resolve(resp.statusCode >= 200 && resp.statusCode < 300));
    });
    r.on('error', () => resolve(false));
    r.on('timeout', () => { r.destroy(); resolve(false); });
    r.write(body); r.end();
  });
}

async function bootstrap() {
  db = await loadDB();
  mergeDuplicateEmployees(); // 启动时合并历史重复工号(如曾龙英 1000286 两条)
  server.listen(PORT, () => {
    console.log(`每日AI打卡平台已启动: http://localhost:${PORT}`);
    console.log(`后台管理员密码: ${ADMIN_PASSWORD}  (可用环境变量 ADMIN_PASSWORD 修改)`);
    console.log(pgPool ? '[db] 持久化: Supabase Postgres (DATABASE_URL)' : '[db] 持久化: 本地 JSON 文件');
  });
}
bootstrap();
