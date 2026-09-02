/* 每日AI打卡 - 独立管理后台逻辑 */
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

/* ---------- 工具 ---------- */
function $(id) { return document.getElementById(id); }
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2200); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }
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

/* ---------- 登录 ---------- */
$('adminLoginBtn').onclick = async () => {
  try {
    await API.post('/api/admin/login', { password: $('adminPwd').value });
    $('adminLogin').style.display = 'none';
    $('adminPanel').style.display = '';
    loadAdmin();
  } catch (e) { $('adminLoginErr').textContent = e.message; }
};
$('adminPwd').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('adminLoginBtn').click(); });

async function loadAdmin() {
  const { config } = await API.get('/api/admin/config');
  $('bannerTitleInput').value = config.bannerTitle || '每日AI打卡';
  $('reminderType').value = config.reminderType || '';
  $('reminderWebhook').value = config.reminderWebhook || '';
  const bp = $('bannerPreview'); bp.innerHTML = '';
  (config.banners || []).forEach((src) => { const im = el('img'); im.src = src; bp.appendChild(im); });

  // Banner 保存
  $('saveBanner').onclick = async () => {
    const files = $('bannerFiles').files; const banners = (config.banners || []).slice();
    for (const f of files) { try { banners.push(await readFileAsDataUrl(f)); } catch (e) { toast(e.message); } }
    try { const r = await API.put('/api/admin/config', { banners, bannerTitle: $('bannerTitleInput').value }); config.banners = r.config.banners; config.bannerTitle = r.config.bannerTitle; toast('Banner 已保存'); }
    catch (e) { toast(e.message); }
  };
  // 提醒
  $('saveReminder').onclick = async () => {
    try { await API.put('/api/admin/config', { reminderType: $('reminderType').value, reminderWebhook: $('reminderWebhook').value }); toast('提醒配置已保存'); }
    catch (e) { toast(e.message); }
  };
  $('testReminder').onclick = async () => {
    $('reminderHint').textContent = '发送中...';
    try { const r = await API.post('/api/admin/reminder'); $('reminderHint').textContent = r.msg || '已发送'; toast(r.msg || '已发送'); }
    catch (e) { $('reminderHint').textContent = e.message; toast(e.message); }
  };
  // 官方发布 (支持最多 3 张)
  $('officialPost').onclick = async () => {
    const text = $('officialText').value.trim();
    const files = Array.from($('officialImage').files);
    if (!text) { toast('请填写内容'); return; }
    if (!files.length) { toast('请上传至少 1 张图片'); return; }
    const images = [];
    for (const f of files.slice(0, 3)) { try { images.push(await readFileAsDataUrl(f)); } catch (e) { toast(e.message); return; } }
    try { await API.post('/api/admin/checkin', { text, images }); toast('行政君已发布'); $('officialText').value = ''; $('officialImage').value = ''; }
    catch (e) { toast(e.message); }
  };
  // 导出
  $('exportBtn').onclick = () => window.open('/api/admin/export');
  $('exportSummaryBtn').onclick = () => window.open('/api/admin/export-summary');
  // 登出
  $('adminLogout').onclick = async () => { await API.post('/api/admin/logout'); $('adminLogin').style.display = ''; $('adminPanel').style.display = 'none'; };

  loadLeaderboard();
  await loadAdminTables();
}

/* ---------- 排行榜 ---------- */
async function loadLeaderboard() {
  const { rows, stats } = await API.get('/api/leaderboard');
  $('lbStats').innerHTML = `
    <div class="lb-stat"><b>${stats.totalUsers}</b><span>参与人数</span></div>
    <div class="lb-stat"><b>${stats.totalCheckins}</b><span>总打卡数</span></div>
    <div class="lb-stat"><b>${stats.monthDone}</b><span>本月达标</span></div>`;
  const list = $('lbList'); list.innerHTML = '';
  if (!rows.length) list.appendChild(el('div', 'empty', '本月还没有人打卡~'));
  rows.forEach((r, i) => {
    const row = el('div', 'lb-row');
    const rankCls = i === 0 ? 'top1' : i === 1 ? 'top2' : i === 2 ? 'top3' : '';
    row.innerHTML = `
      <div class="lb-rank ${rankCls}">${i + 1}</div>
      ${avatarHtml(r.avatar, r.displayName)}
      <div class="lb-info"><div class="nm">${esc(r.displayName)}${r.isOfficial ? '<span class="badge-official">行政君</span>' : ''} ${r.done ? '<span class="medal">🏅</span>' : ''}</div></div>
      <div class="lb-days">${r.checkedDays} 天</div>`;
    list.appendChild(row);
  });
}

/* ---------- 数据表 ---------- */
function checkinImages(c) {
  if (Array.isArray(c.imageUrls) && c.imageUrls.length) return c.imageUrls;
  if (c.imageUrl) return [c.imageUrl];
  return [];
}
async function loadAdminTables() {
  const { checkins } = await API.get('/api/admin/checkins');
  const tbl = $('adminCheckinTable');
  tbl.innerHTML = '<tr><th>日期</th><th>昵称</th><th>姓名/工号</th><th>内容</th><th>图</th><th>操作</th></tr>';
  checkins.forEach((c) => {
    const tr = el('tr');
    const imgs = checkinImages(c);
    const imgCell = imgs.length ? '<div class="mini-imgs">' + imgs.slice(0, 3).map((s) => `<img src="${s}" alt="" />`).join('') + '</div>' : '-';
    tr.innerHTML = `<td>${c.checkinDate}</td><td>${esc(c.displayName)}${c.isOfficial ? ' <span class="badge-official">行政君</span>' : ''}</td><td>${esc(c.realName)}/${esc(c.employeeId)}</td><td>${esc(c.text).slice(0, 30)}</td><td>${imgCell}</td><td></td>`;
    const op = tr.lastElementChild;
    const hideBtn = el('button', 'mini-btn hide', c.hidden ? '显示' : '隐藏');
    hideBtn.onclick = async () => { await API.post(`/api/admin/checkins/${c.id}/hide`); loadAdminTables(); };
    const delBtn = el('button', 'mini-btn danger', '删除');
    delBtn.onclick = async () => { if (confirm('确认删除该打卡记录？')) { await API.del(`/api/admin/checkins/${c.id}`); loadAdminTables(); } };
    op.appendChild(hideBtn); op.appendChild(delBtn);
    tbl.appendChild(tr);
  });

  // 全员明细表
  const dt = $('adminTable');
  dt.innerHTML = '<tr><th>日期</th><th>昵称</th><th>真实姓名/工号</th><th>内容</th><th>点赞</th><th>评论</th><th>官方</th></tr>';
  checkins.forEach((c) => {
    const tr = el('tr');
    tr.innerHTML = `<td>${c.checkinDate}</td><td>${esc(c.displayName)}</td><td>${esc(c.realName)}/${esc(c.employeeId)}</td><td>${esc(c.text).slice(0, 24)}</td><td>${c.likeCount}</td><td>${c.commentCount}</td><td>${c.isOfficial ? '是' : ''}</td>`;
    dt.appendChild(tr);
  });

  const search = $('searchInput');
  search.oninput = () => {
    const kw = search.value.trim().toLowerCase();
    [tbl, dt].forEach((t) => t.querySelectorAll('tr').forEach((tr, i) => {
      if (i === 0) return; const tx = tr.textContent.toLowerCase(); tr.style.display = (!kw || tx.includes(kw)) ? '' : 'none';
    }));
  };
}
