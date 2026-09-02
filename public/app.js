/* 每日AI打卡 - 前端逻辑 */
const API = {
  async get(u) { return req('GET', u); },
  async post(u, b) { return req('POST', u, b); },
  async put(u, b) { return req('PUT', u, b); },
  async del(u, b) { return req('DELETE', u, b); },
};
async function req(method, url, body) {
  const opt = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(url, opt);
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch (e) { data = {}; }
  if (!r.ok) throw new Error(data.error || ('请求失败 ' + r.status));
  return data;
}

const state = { me: null, progress: null, banner: [], bannerTitle: '每日AI打卡', bannerTimer: null };

/* ---------- 工具 ---------- */
function $(id) { return document.getElementById(id); }
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2200); }
function fmtTime(iso) {
  const d = new Date(iso); const n = new Date();
  const diff = (n - d) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function avatarHtml(url, name) {
  if (url) return `<img class="avatar" src="${url}" alt="" />`;
  return `<div class="avatar">${(name || '?').slice(0, 1)}</div>`;
}
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (file.size > 100 * 1024 * 1024) return reject(new Error('图片不能超过 100MB'));
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('读取失败'));
    fr.readAsDataURL(file);
  });
}
function openLightbox(src) {
  const lb = el('div', 'lightbox'); lb.innerHTML = `<img src="${src}" />`;
  lb.onclick = () => lb.remove(); document.body.appendChild(lb);
}

/* ---------- 视图切换 ---------- */
function switchView(name) {
  ['wall', 'me'].forEach((v) => { $('view-' + v).style.display = v === name ? '' : 'none'; });
  document.querySelectorAll('.nav-link').forEach((a) => a.classList.toggle('active', a.dataset.view === name));
  if (name === 'wall') loadWall();
  if (name === 'me') loadMe();
  window.scrollTo(0, 0);
}

/* ---------- Banner ---------- */
async function loadConfig() {
  try {
    const { config } = await API.get('/api/config');
    state.banner = config.banners || [];
    state.bannerTitle = config.bannerTitle || '每日AI打卡';
  } catch (e) { /* 接口异常, 用默认空 banner */ }
  renderBanner();
}
function renderBanner() {
  $('bannerTitle').textContent = state.bannerTitle;
  const track = $('bannerTrack'); const dots = $('bannerDots');
  track.innerHTML = ''; dots.innerHTML = '';
  const imgs = state.banner.length ? state.banner : [null];
  imgs.forEach((src, i) => {
    const slide = el('div');
    if (src) { const im = el('img'); im.src = src; slide.appendChild(im); }
    else { slide.style.background = 'linear-gradient(135deg,#4f6ef7,#7b5cf0)'; }
    track.appendChild(slide);
    const dot = el('span'); if (i === 0) dot.className = 'on'; dots.appendChild(dot);
  });
  let idx = 0;
  clearInterval(state.bannerTimer);
  if (imgs.length > 1) {
    state.bannerTimer = setInterval(() => {
      idx = (idx + 1) % imgs.length;
      track.style.transform = `translateX(-${idx * 100}%)`;
      dots.querySelectorAll('span').forEach((d, i) => d.classList.toggle('on', i === idx));
    }, 3500);
  }
}

/* ---------- 动态墙 ---------- */
async function refreshMe() {
  try { const r = await API.get('/api/me'); state.me = r.user; state.progress = r.progress; }
  catch (e) { state.me = null; }
}
async function loadWall() {
  await refreshMe();
  renderProgress();
  const { checkins } = await API.get('/api/checkins');
  const feed = $('feed'); feed.innerHTML = '';
  $('feedEmpty').style.display = checkins.length ? 'none' : '';
  checkins.forEach((c) => feed.appendChild(renderCard(c)));
  updateCheckinBtn();
}
function renderProgress() {
  const card = $('progressCard');
  if (!state.me) { card.style.display = 'none'; return; }
  card.style.display = '';
  $('progressName').textContent = state.me.displayName;
  $('progressOfficial').style.display = state.me.isOfficial ? '' : 'none';
  const p = state.progress;
  $('progressDays').textContent = `${p.checkedDays}/${p.target} 天`;
  $('progressFill').style.width = Math.min(100, (p.checkedDays / p.target) * 100) + '%';
  const tip = $('progressTip');
  if (p.done) { tip.textContent = '🏅 本月挑战成功！继续保持~'; tip.className = 'progress-tip done'; }
  else { tip.textContent = `距 ${p.target} 天达标还差 ${p.remaining} 天`; tip.className = 'progress-tip'; }
}
function renderCard(c) {
  const card = el('div', 'card');
  const imgs = (c.imageUrls && c.imageUrls.length) ? c.imageUrls : (c.imageUrl ? [c.imageUrl] : []);
  const gallery = imgs.length
    ? `<div class="card-imgs imgs-${Math.min(imgs.length, MAX_IMAGES)}">${imgs.map((src) => `<img class="card-img" src="${src}" alt="打卡图" />`).join('')}</div>`
    : '';
  card.innerHTML = `
    <div class="card-head">
      ${avatarHtml(c.avatar, c.displayName)}
      <div><div class="card-name">${esc(c.displayName)}${c.isOfficial ? '<span class="badge-official">行政君</span>' : ''}</div>
      <div class="card-time">${fmtTime(c.createdAt)}</div></div>
    </div>
    <div class="card-text">${esc(c.text)}</div>
    ${gallery}
    <div class="card-actions">
      <span class="${c.liked ? 'liked' : ''}" data-act="like">${c.liked ? '❤️' : '🤍'} <b>${c.likeCount}</b></span>
      <span data-act="comment">💬 <b>${c.commentCount}</b></span>
    </div>
    <div class="card-comments" style="display:none"></div>`;
  card.querySelectorAll('.card-img').forEach((im) => { im.onclick = () => openLightbox(im.src); });
  card.querySelector('[data-act="like"]').onclick = () => toggleLike(c.id, card);
  card.querySelector('[data-act="comment"]').onclick = () => toggleComments(c.id, card);
  return card;
}
async function toggleLike(id, card) {
  try { const r = await API.post(`/api/checkins/${id}/like`); const span = card.querySelector('[data-act="like"]');
    span.className = r.liked ? 'liked' : ''; span.innerHTML = `${r.liked ? '❤️' : '🤍'} <b>${r.likeCount}</b>`;
  } catch (e) { toast(e.message); }
}

/* ---------- 评论（卡片内联展开） ---------- */
function toggleComments(id, card) {
  const box = card.querySelector('.card-comments');
  if (box.style.display === 'block') { box.style.display = 'none'; return; }
  box.style.display = 'block';
  box.innerHTML = '<div class="empty" style="padding:14px">加载中...</div>';
  API.get(`/api/checkins/${id}/comments`).then(({ comments }) => {
    renderComments(id, card, comments);
  }).catch((e) => { box.innerHTML = `<div class="empty">${e.message}</div>`; });
}
function renderComments(id, card, comments) {
  const box = card.querySelector('.card-comments');
  box.innerHTML = '';
  const list = el('div', 'comment-list');
  if (!comments.length) list.appendChild(el('div', 'empty', '还没有评论，来抢沙发~'));
  comments.forEach((cm) => {
    const item = el('div', 'comment-item');
    item.innerHTML = `${avatarHtml(cm.avatar, cm.displayName)}<div class="comment-body"><div class="comment-name">${esc(cm.displayName)}${cm.isOfficial ? '<span class="badge-official">行政君</span>' : ''}</div><div class="comment-text">${esc(cm.text)}</div></div>`;
    list.appendChild(item);
  });
  box.appendChild(list);
  // 输入区
  const row = el('div', 'comment-input-row');
  const input = el('input', 'form-input'); input.placeholder = '说点什么...';
  const btn = el('button', 'btn', '发送'); btn.style.marginTop = '0'; btn.style.width = 'auto'; btn.style.padding = '0 18px';
  btn.onclick = async () => {
    const t = input.value.trim(); if (!t) return;
    btn.disabled = true;
    try {
      await API.post(`/api/checkins/${id}/comments`, { text: t });
      const { comments } = await API.get(`/api/checkins/${id}/comments`);
      renderComments(id, card, comments);
      updateCommentCount(card, comments.length);
      input.value = ''; toast('评论成功');
    }
    catch (e) { toast(e.message); }
    finally { btn.disabled = false; }
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') btn.click(); };
  row.appendChild(input); row.appendChild(btn); box.appendChild(row);
  // 收起
  const collapse = el('div', 'comment-collapse', '收起 ▲');
  collapse.onclick = () => { box.style.display = 'none'; };
  box.appendChild(collapse);
}
function updateCommentCount(card, n) {
  const b = card.querySelector('[data-act="comment"] b'); if (b) b.textContent = n;
}

/* ---------- 发布 / 登记 ---------- */
function closeAllModals() {
  const m = $('modalMask'); if (m) m.style.display = 'none';
}
function openCheckin() {
  closeAllModals();
  if (!state.me) return openIdentify();
  openPublish();
}
// 单入口智能身份识别: 工号+姓名; 系统自动判断新登记/认回老身份, 员工无需选择
function openIdentify() {
  closeAllModals();
  const mask = $('modalMask'); mask.style.display = 'flex'; $('modalTitle').textContent = '身份识别';
  const b = $('modalBody');
  b.innerHTML = `
    <div class="form-hint" style="margin-top:0">输入<b>工号 + 真实姓名</b>即可识别身份（无需密码）。首次打卡请填写发布昵称。</div>
    <label class="form-label">真实姓名</label><input id="rName" class="form-input" placeholder="如：张三" />
    <label class="form-label">工号</label><input id="rId" class="form-input" placeholder="如：E1024" />
    <label class="form-label">发布昵称 / 花名（公开显示，首次必填）</label><input id="rNick" class="form-input" maxlength="20" placeholder="如：产品小A" />
    <label class="form-label">头像（选填）</label><input id="rAvatar" type="file" accept="image/*" />
    <div class="form-err" id="rErr"></div>
    <button class="btn" id="rSubmit">识别并继续</button>`;
  $('rSubmit').onclick = async () => {
    const real_name = $('rName').value.trim(), employee_id = $('rId').value.trim();
    const display_name = $('rNick').value.trim(), avatarFile = $('rAvatar').files[0];
    if (!real_name || !employee_id) { $('rErr').textContent = '请填写真实姓名与工号'; return; }
    let avatar = null;
    try { if (avatarFile) avatar = await readFileAsDataUrl(avatarFile); } catch (e) { $('rErr').textContent = e.message; return; }
    $('rSubmit').textContent = '识别中...'; $('rSubmit').disabled = true;
    try {
      await API.post('/api/identify', { real_name, employee_id, display_name, avatar });
      const me = await API.get('/api/me'); state.me = me.user; state.progress = me.progress; openPublish();
    }
    catch (e) { $('rErr').textContent = e.message; $('rSubmit').textContent = '识别并继续'; $('rSubmit').disabled = false; }
  };
}
const MAX_IMAGES = 3;
async function openPublish() {
  closeAllModals();
  const mask = $('modalMask'); mask.style.display = 'flex'; $('modalTitle').textContent = '今日打卡';
  const b = $('modalBody');
  b.innerHTML = `
    <div class="form-hint" style="margin-top:0">以身份 <b>${esc(state.me.displayName)}</b> 发布（可在「我的 → 个人设置」修改昵称）。</div>
    <label class="form-label">文字介绍（必填，描述AI提效案例）</label>
    <textarea id="pText" class="form-input" rows="4" placeholder="今天用 AI 做了什么提效？"></textarea>
    <label class="form-label">图片证明（必填，最多 3 张，单张≤100MB）</label>
    <input id="pImg" type="file" accept="image/*" multiple />
    <div class="img-previews" id="pImgs"></div>
    <div class="form-err" id="pErr"></div>
    <button class="btn" id="pSubmit">确认发布</button>`;
  const imgInput = $('pImg'); const imgBox = $('pImgs');
  let pending = []; // 已选图片 dataURL 列表
  function renderPreviews() {
    imgBox.innerHTML = '';
    pending.forEach((src, i) => {
      const wrap = el('div', 'img-thumb');
      wrap.innerHTML = `<img src="${src}" /><span class="img-del" data-i="${i}">✕</span>`;
      wrap.querySelector('.img-del').onclick = () => { pending.splice(i, 1); renderPreviews(); };
      imgBox.appendChild(wrap);
    });
  }
  imgInput.onchange = async () => {
    const files = Array.from(imgInput.files);
    for (const f of files) {
      if (pending.length >= MAX_IMAGES) { $('pErr').textContent = `最多上传 ${MAX_IMAGES} 张图片`; break; }
      try { pending.push(await readFileAsDataUrl(f)); } catch (e) { $('pErr').textContent = e.message; }
    }
    imgInput.value = ''; renderPreviews();
  };
  $('pSubmit').onclick = async () => {
    const text = $('pText').value.trim();
    if (!text) { $('pErr').textContent = '请填写文字介绍'; return; }
    if (!pending.length) { $('pErr').textContent = '请至少上传 1 张图片证明'; return; }
    $('pSubmit').textContent = '发布中...'; $('pSubmit').disabled = true;
    try {
      const r = await API.post('/api/checkins', { text, images: pending.slice(0, MAX_IMAGES) });
      state.progress = r.progress; closeAllModals(); toast('打卡成功 🎉'); loadWall();
    } catch (e) { $('pErr').textContent = e.message; $('pSubmit').textContent = '确认发布'; $('pSubmit').disabled = false; }
  };
}

/* ---------- 底部按钮状态 ---------- */
async function updateCheckinBtn() {
  const btn = $('btnCheckin');
  if (!state.me) { btn.textContent = '今日打卡'; btn.classList.remove('done'); btn.disabled = false; return; }
  try {
    const { checkins } = await API.get('/api/checkins');
    const today = new Date().toISOString().slice(0, 10);
    const todayDone = checkins.some((c) => c.mine && c.createdAt && c.createdAt.slice(0, 10) === today);
    if (todayDone) { btn.textContent = '今日已打卡 ✓'; btn.classList.add('done'); btn.disabled = true; }
    else { btn.textContent = '今日打卡'; btn.classList.remove('done'); btn.disabled = false; }
  } catch (e) { btn.textContent = '今日打卡'; btn.classList.remove('done'); btn.disabled = false; }
}

/* ---------- 我的 ---------- */
async function loadMe() {
  await refreshMe();
  if (!state.me) { $('meGuest').style.display = ''; $('mePanel').style.display = 'none'; return; }
  $('meGuest').style.display = 'none'; $('mePanel').style.display = '';
  $('meName').textContent = state.me.displayName;
  $('meOfficial').style.display = state.me.isOfficial ? '' : 'none';
  $('meSub').textContent = `工号 ${state.me.employeeId} · 真实姓名仅后台可见`;
  if (state.me.avatar) $('meAvatar').src = state.me.avatar; else $('meAvatar').style.display = 'none';
  $('meAvatar').style.display = state.me.avatar ? '' : 'none';
  $('meFill').style.width = Math.min(100, (state.progress.checkedDays / state.progress.target) * 100) + '%';
  const tip = $('meTip');
  if (state.progress.done) { tip.textContent = '🏅 本月挑战成功！'; tip.className = 'progress-tip done'; }
  else { tip.textContent = `已打卡 ${state.progress.checkedDays} 天，还差 ${state.progress.remaining} 天达标`; tip.className = 'progress-tip'; }
  $('setName').value = state.me.displayName;
  // 我的记录
  const { checkins } = await API.get('/api/checkins');
  const mine = checkins.filter((c) => c.displayName === state.me.displayName);
  const list = $('myList'); list.innerHTML = '';
  if (!mine.length) { $('myEmpty').style.display = ''; } else { $('myEmpty').style.display = 'none';
    mine.forEach((c) => { const it = el('div', 'my-item'); it.innerHTML = `<div>${esc(c.text)}</div><div class="my-date">${c.checkinDate} ${fmtTime(c.createdAt)}</div>`; list.appendChild(it); });
  }
}

/* ---------- 转义 ---------- */
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }

/* ---------- 事件绑定 ---------- */
$('brandHome').onclick = () => switchView('wall');
document.querySelectorAll('.nav-link').forEach((a) => { if (a.dataset.view) a.onclick = () => switchView(a.dataset.view); });
$('btnCheckin').onclick = () => openCheckin();
$('btnMyRecord').onclick = () => { switchView('me'); };
$('modalClose').onclick = closeAllModals;
$('modalMask').onclick = (e) => { if (e.target === $('modalMask')) closeAllModals(); };

/* 个人设置保存 */
document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'saveSettings') {
    (async () => {
      const dn = $('setName').value.trim(); $('setNameErr').textContent = '';
      if (!dn) { $('setNameErr').textContent = '昵称不能为空'; return; }
      if (dn === '行政君' && !(state.me && state.me.isOfficial)) { $('setNameErr').textContent = '该昵称已被官方保留，请更换'; return; }
      let avatar = undefined; const f = $('setAvatar').files[0];
      if (f) { try { avatar = await readFileAsDataUrl(f); } catch (err) { $('setNameErr').textContent = err.message; return; } }
      try { const r = await API.put('/api/me', { display_name: dn, avatar }); state.me = r.user; toast('设置已保存'); loadMe(); }
      catch (err) { $('setNameErr').textContent = err.message; }
    })();
  }
});

/* ---------- 启动 ---------- */
(async function init() {
  await loadConfig();
  switchView('wall');
})();
