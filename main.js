// ============================================================
//  豆包多开管理器 v3.0 · 视图池架构
//  核心思路继承自 doubao-video-multi:
//    单窗口 + WebContentsView 常驻视图池, 切号=显隐切换(毫秒级,不丢状态)
//  在其基础上修复/增强:
//    1. userData 重定向到本目录(E盘), 不再写 C 盘 AppData
//    2. GPU 硬件加速默认开启(兼容模式可选), 不再全局禁用
//    3. 渲染进程崩溃自动重建视图; 加载失败自动重试并标记状态
//    4. 掉线检测改用强凭证 Cookie(不再用 DOM 文本正则, 避免误报)
//    5. 缩放快捷键真正作用于豆包页面(原版只作用于主窗口, 无效)
//    6. 新增下载处理: 生成的视频/图片自动保存并可一键打开
//    7. 权限请求白名单; 关窗最小化到托盘(可关); 单实例锁
//    8. 登录监控防重入、定时器必清; 昵称提取只在登录成功时执行一次
// ============================================================
const { app, BrowserWindow, WebContentsView, ipcMain, Menu, session, shell, Tray, nativeImage, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');

// v3.0.12: 打包成便携版后没有 bat 帮忙传参数, 而部分机器的 GPU 进程沙箱会被系统策略拦截
// (表现为连续报 GPU process isn't usable 然后白屏/闪退)。在这里兜底, 双击 exe 即可启动。
try {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('disable-dev-shm-usage');
} catch (e) {}

// ---------- 路径与日志 ----------
const APP_DIR = __dirname;
// v3.0.12: 打包成便携版后, 代码在 resources/app 里, 数据若也写在那里会藏得很深;
// 所以打包态统一放到 exe 同级目录, 整个文件夹可以随便搬到别的电脑。
const DATA_DIR = app.isPackaged ? path.dirname(app.getPath('exe')) : APP_DIR;
const USER_DIR = path.join(DATA_DIR, 'userdata');
const DOWNLOAD_DIR = path.join(DATA_DIR, 'downloads');
const LOG_FILE = path.join(DATA_DIR, 'app-run.log');
app.setPath('userData', USER_DIR);
try { app.setPath('crashDumps', path.join(USER_DIR, 'crashes')); } catch (e) {}

function log(msg) {
  try { fs.appendFileSync(LOG_FILE, '[' + new Date().toISOString() + '] ' + msg + '\n'); } catch (e) {}
}
try {
  const st = fs.statSync(LOG_FILE);
  if (st.size > 1024 * 1024) fs.unlinkSync(LOG_FILE); // 超过 1MB 重新开始
} catch (e) {}
log('=== v3 启动 ===');

// ---------- 偏好设置(先于 ready 读取, 因为兼容模式要提前决定) ----------
const PREFS_FILE = path.join(USER_DIR, 'prefs.json');
function loadPrefs() {
  try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf-8')); } catch (e) { return {}; }
}
let prefs = Object.assign({ closeToTray: true, winBounds: null }, loadPrefs());
function savePrefs() {
  try {
    fs.mkdirSync(USER_DIR, { recursive: true });
    fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2), 'utf-8');
  } catch (e) { log('savePrefs 失败: ' + e.message); }
}

if (prefs.compatGpu) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  log('兼容模式: 已禁用 GPU');
}

// ---------- 全局常量 ----------
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
const DOUBAO_URL = 'https://www.doubao.com/chat/';
const SIDEBAR_WIDTH = 260;
const PALETTE = ['#4F86F7', '#00B578', '#FF7D00', '#E16531', '#7261A3', '#2BA6A0', '#D22E45', '#5B8C5A'];

// 登录凭证特征: 强凭证(登录后才会出现) 与 匿名/埋点 key
const AUTH_RE = /sessionid|session_tt|uid_tt|user_tt|user_ticket|login_uid|auth_token|user_token|passport_auth|sid_tt|sso_|store-region/i;
const ANON_RE = /ttwid|s_v_web_id|msToken|bd_ticket|__tea|tea_|flow_|logid|ab_|monitor|rum|perf|gid|vid|csrf|publish|i18next/i;

// ---------- 运行状态 ----------
let mainWindow = null;
let tray = null;
let activeAccountId = null;
const viewPool = new Map();          // accountId -> WebContentsView (常驻不销毁)
const badges = new Map();            // accountId -> 'online'|'pending'|'offline'|'loadfail'
const monitors = new Map();          // accountId -> {timer,diag,done}
const nameAttempts = new Map();      // accountId -> 昵称识别已尝试次数
const forceQuitting = { value: false };

// ---------- 账号持久化 ----------
const accountsFile = () => path.join(USER_DIR, 'accounts.json');
function loadAccounts() {
  try { return JSON.parse(fs.readFileSync(accountsFile(), 'utf-8') || '[]'); } catch (e) { return []; }
}
function saveAccounts(list) {
  try {
    fs.mkdirSync(USER_DIR, { recursive: true });
    fs.writeFileSync(accountsFile(), JSON.stringify(list, null, 2), 'utf-8');
  } catch (e) { log('saveAccounts 失败: ' + e.message); }
}

// ---------- 视图几何 ----------
function getContentBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return { x: SIDEBAR_WIDTH, y: 0, width: 900, height: 600 };
  const b = mainWindow.getContentBounds();
  return {
    x: SIDEBAR_WIDTH,
    y: 0,
    width: Math.max(400, b.width - SIDEBAR_WIDTH),
    height: Math.max(300, b.height)
  };
}

// ---------- 会话级钩子(下载/权限), 每个分区只挂一次 ----------
function ensureSessionHooks(accountId) {
  const key = 'persist:' + accountId;
  let ses;
  try { ses = session.fromPartition(key); } catch (e) { return; }
  if (!ses || ses.__hooksDone) return;
  ses.__hooksDone = true;

  // 记录本分区内出现过的"用户信息类"接口(含 Worker 发起的请求), 供昵称识别重放
  ses.__apiLog = [];
  try {
    ses.webRequest.onCompleted({ urls: ['*://*.doubao.com/*'] }, (details) => {
      try {
        if (details.method !== 'GET') return;
        const pathOnly = details.url.split('?')[0];
        const low = details.url.toLowerCase();
        const interesting = low.indexOf('/user') >= 0 || low.indexOf('userinfo') >= 0 ||
          low.indexOf('user_info') >= 0 || low.indexOf('/account') >= 0 ||
          low.indexOf('passport') >= 0 && low.indexOf('info') >= 0;
        const junk = ['beat', 'heartbeat', 'track', 'monitor', 'report', '/log'].some(j => low.indexOf(j) >= 0);
        if (interesting && !junk && ses.__apiLog.length < 60) {
          if (ses.__apiLog.indexOf(details.url) < 0) ses.__apiLog.push(details.url);
        }
      } catch (e) {}
    });
  } catch (e) { log('webRequest 钩子失败: ' + e.message); }

  // 下载: 自动存到 程序目录\downloads\账号ID\
  ses.on('will-download', (event, item) => {
    try {
      const dir = path.join(DOWNLOAD_DIR, accountId);
      fs.mkdirSync(dir, { recursive: true });
      const base = item.getFilename() || ('file-' + Date.now());
      let savePath = path.join(dir, base);
      let i = 1;
      while (fs.existsSync(savePath)) {
        const ext = path.extname(base), stem = path.basename(base, ext);
        savePath = path.join(dir, stem + '(' + i + ')' + ext); i++;
      }
      item.setSavePath(savePath);
      log('下载开始: ' + base);
    } catch (e) { log('下载设置失败: ' + e.message); }
    item.once('done', (e2, state) => {
      if (state === 'completed') {
        log('下载完成: ' + item.getSavePath());
        pushToRenderer('download:done', { file: path.basename(item.getSavePath()), dir: path.dirname(item.getSavePath()) });
        if (tray) { tray.displayBalloon && tray.displayBalloon({ title: '下载完成', content: path.basename(item.getSavePath()) }); }
      } else if (state === 'interrupted') {
        log('下载中断: ' + item.getFilename());
      }
    });
  });

  // 权限白名单: 常用放行, 其余拒绝(避免页面权限弹窗卡死)
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    const allow = ['media', 'clipboard-sanitized-write', 'notification', 'fullscreen', 'pointerLock', 'clipboard-read'];
    callback(allow.indexOf(permission) >= 0);
  });
}

// ---------- 页面内脚本 ----------
const WEBDRIVER_PATCH = "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});";

// 昵称识别: 重放主进程记录到的用户信息接口(cands 由外部传入) + DOM 兜底策略
const DETECT_NAME_SCRIPT = `(async (cands) => {
  try {
  const clean = (s)=>String(s||'').replace(/\\s+/g,' ').trim();
  const bodyTxt = (document.body && document.body.innerText) || '';
  if (/扫码登录|手机号登录|验证码登录|^登录$/.test(bodyTxt)) return {name:'',source:'login-page'};
  const BAD = /(登录|退出|注册|下载|更多|最近|对话|工作|关于|设置|帮助|反馈|搜索|首页|返回|收起|展开|取消|确定|删除|重命名|新建|热门|推荐|免费|会员|升级|签到|消息|通知|历史|收藏|资料|我的|编辑|分享|复制|清空|全部|加载|暂无|PPT|图像|视频|研究|播客|录音|转写|文档|表格|代码|翻译|创作|技能|云盘|项目|置顶|深度思考|联网|豆包|助手|模型|默认)/i;
  const JUNK = /^(success|succeeded|failed|failure|fail|ok|okay|true|false|null|none|unknown|yes|no|0|1)$/i;
  const isName = (t)=>{
    t = clean(t);
    if (!t || t.length<1 || t.length>15) return false;
    if (BAD.test(t)) return false;
    if (JUNK.test(t)) return false;
    if (/^[0-9.-]+$/.test(t)) return false;
    return true;
  };

  // ---- 策略0(最可靠): 重放用户信息接口并深挖昵称字段 ----
  const NAME_KEY_RE = /^(nick|nickname|user_?name|display_?name|screen_?name|platform_screen_?name)$/i;
  function digName(obj, depth){
    if (!obj || typeof obj !== 'object' || depth > 6) return null;
    let generic = null;
    for (const k of Object.keys(obj)){
      let v;
      try { v = obj[k]; } catch(e){ continue; }
      if (v == null) continue;
      if (typeof v === 'string'){
        if (NAME_KEY_RE.test(k) && isName(v)) return clean(v);
        if (!generic && /^name$/i.test(k) && isName(v)) generic = clean(v);
      } else if (typeof v === 'object'){
        const r = digName(v, depth+1);
        if (r) return r;
      }
    }
    return generic;
  }
  async function tryUrl(u){
    try {
      const r = await fetch(u, { credentials:'include', headers:{'accept':'application/json'} });
      if (!r.ok) return null;
      const ct = r.headers.get('content-type') || '';
      if (ct.indexOf('json') < 0) return null;
      const j = await r.json();
      const root = (j && typeof j === 'object') ? (j.data || j.result || j.user || j) : null;
      const n = digName(root, 0);
      if (n) return { name:n, source:'api-replay:' + u.slice(0,90) };
    } catch(e){}
    return null;
  }
  // ---- 策略0a(首选): 豆包已知的用户信息接口, 直接带凭证重放 ----
  try {
    const known = [
      'https://www.doubao.com/passport/account/info/v2/?language=zh_cn',
      'https://www.doubao.com/passport/account/info/v2/'
    ];
    for (const u of known){
      const hit = await tryUrl(u);
      if (hit) return hit;
    }
  } catch(e){}

  // ---- 策略0b: 主进程记录到的其他候选接口 ----
  try {
    // 候选列表来自主进程 webRequest 记录(能覆盖 Web Worker 内的请求)
    const urls = Array.isArray(cands) ? cands : [];
    const seen = new Set();
    for (const u of urls){
      if (seen.has(u)) continue;
      seen.add(u);
      const hit = await tryUrl(u);
      if (hit) return hit;
    }
  } catch(e){}

  // ---- 策略1: 退出登录容器 ----
  let logoutEl = null;
  [...document.querySelectorAll('*')].forEach(el=>{
    if (el.children.length===0 && /^退出登录$/.test(clean(el.textContent))) logoutEl = el;
  });
  if (logoutEl) {
    let c = logoutEl;
    for (let i=0;i<4 && c.parentElement;i++) c = c.parentElement;
    const found = [];
    c.querySelectorAll('*').forEach(el=>{
      if (el.children.length>0) return;
      const t = clean(el.textContent || el.getAttribute('alt') || '');
      if (isName(t) && !/^退出登录$|^设置$|^更多$/.test(t)) found.push(t);
    });
    if (found.length) return {name:found[0], source:'logout-container'};
  }
  // ---- 策略2: localStorage 用户信息字段 ----
  try {
    for (let i=0;i<localStorage.length;i++){
      const k = localStorage.key(i);
      if (!/user|account|profile|passport/i.test(k)) continue;
      const v = localStorage.getItem(k);
      if (!v || v.length>8000) continue;
      try {
        const obj = JSON.parse(v);
        const cand = obj && (obj.nick || obj.nickname || obj.name || obj.user_name || obj.userName || (obj.data && (obj.data.nick||obj.data.name)));
        if (typeof cand === 'string' && isName(cand)) return {name:cand.trim(), source:'localStorage:'+k};
      } catch(e2) {}
    }
  } catch(e) {}
  // ---- 策略3: 左下角头像 alt ----
  const w = window.innerWidth, h = window.innerHeight;
  const imgs = [...document.querySelectorAll('img')]
    .map(i=>({el:i, r:i.getBoundingClientRect()}))
    .filter(a=>a.r.width>20 && a.r.left<w*0.5 && a.r.top>h*0.5);
  for (const a of imgs){
    const t = clean(a.el.alt || a.el.getAttribute('aria-label') || '');
    if (isName(t)) return {name:t, source:'avatar-alt'};
  }
  return {name:'', source:'none'};
  } catch(err){
    return {name:'', source:'exception:' + ((err && err.message) || String(err)).slice(0,120)};
  }
})`;

// 对默认名("账号 N")的账号尝试自动识别昵称并改名; force=true 时无视默认名限制
async function tryAutoRename(accountId, force) {
  const list = loadAccounts();
  const acc = list.find(a => a.id === accountId);
  if (!acc || acc.pending) return;
  if (!force && !/^账号\s*\d+$/.test(acc.label)) return;  const v = viewPool.get(accountId);
  if (!v || v.webContents.isDestroyed()) return;
  await new Promise(r => setTimeout(r, 3000));
  try {
    if (!v || v.webContents.isDestroyed()) return;
    // 候选: 主进程 webRequest 记录到的用户信息类接口(含 Worker 请求)
    let cands = [];
    try {
      const ses = session.fromPartition('persist:' + accountId);
      if (ses && Array.isArray(ses.__apiLog)) cands = ses.__apiLog.slice();
    } catch (e) {}
    const script = '(' + DETECT_NAME_SCRIPT + ')(' + JSON.stringify(cands) + ');';
    const res = await v.webContents.executeJavaScript(script, true).catch((err) => {
      return { __rejected: true, msg: ((err && err.message) || String(err)).slice(0, 200), stack: ((err && err.stack) || '').slice(0, 400) };
    });
    if (res && res.__rejected) {
      log('识别脚本REJECT: ' + res.msg + ' | stack: ' + res.stack);
      return;
    }
    const name = res && res.name ? String(res.name).trim() : '';
    if (!name) {
      const n = (nameAttempts.get(accountId) || 0) + 1;
      nameAttempts.set(accountId, n);
      log('昵称识别为空: ' + accountId + ' source=' + (res && res.source) + ' | 候选数=' + cands.length +
        (cands.length ? ' | 首个=' + String(cands[0]).slice(0, 90) : '') +
        ' | 尝试次数=' + n);
      // 未成功则安排重试(接口数据稍后才完整), 最多 20 次 × 10 秒
      if (n < 20 && !force) {
        setTimeout(() => { tryAutoRename(accountId, false); }, 10000);
      }
      // 首次失败时打印候选数(重试由上方定时器负责)
      if (n === 1 && cands.length === 0) {
        log('提示: ' + accountId + ' 暂无候选接口, 页面可能尚未发起用户信息请求');
      }
      return;
    }
    nameAttempts.delete(accountId);
    const list2 = loadAccounts();
    const acc2 = list2.find(a => a.id === accountId);
    if (!acc2 || acc2.label === name) return;
    const wasDefault = /^账号\s*\d+$/.test(acc2.label);
    acc2.label = name;
    saveAccounts(list2);
    log('昵称识别成功: ' + name + ' (' + accountId + ') source=' + res.source + (wasDefault ? ' [自动]' : ' [手动触发]'));
    pushToRenderer('account:ready', { id: accountId, label: name });
  } catch (e) { log('昵称识别异常: ' + e.message); }
}

// ---------- 视图池 ----------
function markBadge(id, st) {
  badges.set(id, st);
  pushToRenderer('badge:update', { id, status: st });
}

function createViewForAccount(account) {
  ensureSessionHooks(account.id);
  const view = new WebContentsView({
    webPreferences: {
      partition: 'persist:' + account.id,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // v3.0.5: 采集套餐/会员信息(在主世界钩订阅接口), 见 member-preload.js
      preload: path.join(APP_DIR, 'member-preload.js'),
      // v3.0.3: 后台账号的页面也要保持正常节奏, 否则流式回复渲染被节流,
      // 完成信号会拖到很晚才出现(跨账号完成提醒会失效)
      backgroundThrottling: false
    }
  });
  view.__retries = 0;
  view.__createdAt = Date.now();   // v3.0.3: 用于过滤加载期的状态跳变
  const wc = view.webContents;

  wc.setUserAgent(CHROME_UA);

  // webdriver 补丁在 dom-ready 打(比 did-start-loading 更稳)
  wc.on('dom-ready', () => {
    wc.executeJavaScript(WEBDRIVER_PATCH, true).catch(() => {});
  });

  // v3.0.4: 回车发送的瞬间就把该账号标成"生成中"(侧栏立刻转圈),
  // 不用等豆包渲染出停止按钮(实测 1.1s), 也不用等下一轮轮询。
  wc.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'Enter' && !input.shift) {
      optimisticBusy(account.id);
    }
  });

  // 崩溃自愈: 渲染进程崩溃后自动重建同分区视图
  wc.on('render-process-gone', (e, detail) => {
    log('渲染进程退出: ' + account.id + ' reason=' + detail.reason);
    setTimeout(() => recreateView(account.id), 800);
  });

  // 加载失败: 自动重试 3 次, 之后标记 loadfail 由用户点击重试
  wc.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return; // -3=ABORTED(跳转被打断,忽略)
    log('加载失败: ' + account.id + ' code=' + code + ' url=' + url);
    if (view.__retries < 3) {
      view.__retries++;
      setTimeout(() => {
        try { if (!wc.isDestroyed()) wc.loadURL(DOUBAO_URL); } catch (err) {}
      }, 1200 * view.__retries);
    } else {
      markBadge(account.id, 'loadfail');
    }
  });
  wc.on('did-finish-load', () => {
    view.__retries = 0;
    const acc = loadAccounts().find(a => a.id === account.id);
    if (acc && acc.pending) markBadge(account.id, 'pending');
    else if (badges.get(account.id) !== 'offline') markBadge(account.id, 'online');
    // 已登录但仍是默认名的账号: 页面每次加载完自动尝试识别昵称
    if (acc && !acc.pending) setTimeout(() => tryAutoRename(account.id, false), 1000);
    // v3.0.6: 套餐信息改成短间隔轮询(拿到就停), 不再固定等 3 秒 / 9 秒
    // v3.0.7: 窗口放到 25 秒 —— 实测豆包订阅接口最晚到启动后 17 秒才返回
    waitMemberInfo(account.id, 25000);
  });

  // 弹窗一律交给系统浏览器
  wc.setWindowOpenHandler(({ url }) => {
    log('拦截新窗口: ' + url);
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  wc.loadURL(DOUBAO_URL).then(() => {
    log('视图加载完成: ' + account.label);
  }).catch((e) => log('视图加载失败: ' + account.label + ' ' + e.message));
  return view;
}

// 崩溃/异常后的重建: 保持分区不变, 若是当前激活视图则重新挂载
function recreateView(accountId) {
  const acc = loadAccounts().find(a => a.id === accountId);
  if (!acc) return;
  const old = viewPool.get(accountId);
  const wasActive = (activeAccountId === accountId);
  if (old) {
    try { mainWindow.contentView.removeChildView(old); } catch (e) {}
    try { if (!old.webContents.isDestroyed()) old.webContents.close(); } catch (e) {}
    viewPool.delete(accountId);
  }
  const nv = createViewForAccount(acc);
  viewPool.set(accountId, nv);
  if (wasActive && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.contentView.addChildView(nv);
    nv.setBounds(getContentBounds());
  }
  log('视图已重建: ' + accountId);
}

// ---------- 切号核心 ----------
function setActiveAccount(id) {
  const account = loadAccounts().find(a => a.id === id);
  if (!account) return false;

  if (activeAccountId && viewPool.has(activeAccountId)) {
    try { mainWindow.contentView.removeChildView(viewPool.get(activeAccountId)); } catch (e) {}
  }
  if (!viewPool.has(id)) {
    viewPool.set(id, createViewForAccount(account));
    log('视图池新建: ' + account.label);
  }
  const view = viewPool.get(id);
  mainWindow.contentView.addChildView(view);
  view.setBounds(getContentBounds());
  activeAccountId = id;
  prefs.lastActiveId = id;
  savePrefs();
  log('切换账号: ' + account.label + ' (池=' + viewPool.size + ')');

  // 兜底: 已登录但仍是默认名的账号, 切过去后给一次识别机会
  if (!account.pending && /^账号\s*\d+$/.test(account.label)) {
    setTimeout(() => tryAutoRename(id, false), 4000);
  }
  // v3.0.2: 切到该账号后自动核一次在线状态。
  // 用户往往是在这个页面上扫码登录的, 而添加时的登录监控可能早就超时结束了。
  setTimeout(() => autoCheckAccount(id), 2500);
  // v3.0.3: 切过来即视为已查看, 清掉"后台回复完成"标记并停止闪任务栏
  if (genDone.delete(id)) {
    pushToRenderer('badge:update', { id, status: badges.get(id) || 'online' });
  }
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(false); } catch (e) {}
  // v3.0.4: 切号瞬间立刻核一遍生成状态, 避免"刚发完消息就切走"的账号转圈迟到
  tickGenWatcher();
  return true;
}

function getActiveView() {
  if (!activeAccountId) return null;
  const v = viewPool.get(activeAccountId);
  return (v && !v.webContents.isDestroyed()) ? v : null;
}

// ---------- 登录监控 ----------
function clearMonitor(id) {
  const m = monitors.get(id);
  if (m) {
    if (m.timer) clearInterval(m.timer);
    if (m.diag) clearInterval(m.diag);
    monitors.delete(id);
  }
}

// ===== 账号在线状态检测(v3.0.2) =====
// 只在真实登录后才会出现的强凭证 cookie; 匿名/埋点类(ttwid/msToken/s_v_web_id 等)一律不算
const STRONG_AUTH_COOKIES = [
  'sessionid', 'sessionid_ss', 'sid_tt', 'uid_tt', 'uid_tt_ss',
  'sid_guard', 'multi_sids', 'sid_ucp_v1', 'ssid_ucp_v1',
  'passport_auth_status', 'passport_auth_status_ss'
];

function isStrongAuthCookie(name) {
  if (!name) return false;
  const n = String(name).toLowerCase();
  if (STRONG_AUTH_COOKIES.indexOf(n) >= 0) return true;
  if (ANON_RE.test(n)) return false;   // 埋点/匿名类先排除
  return AUTH_RE.test(n);
}

// 取该分区里所有豆包域 cookie。
// 实测(Electron 43): cookies.get({domain:'.doubao.com'}) 本身是能匹配的(24 条),
// 但会漏掉 www.doubao.com / accounts.doubao.com 等子域下的条目(全量 29 条)。
// 所以这里全量取一次再本地过滤, 覆盖更全, 也不依赖 Electron 的 domain 匹配语义。
async function getDoubaoCookies(accountId) {
  const ses = session.fromPartition('persist:' + accountId);
  const all = await ses.cookies.get({});
  return all.filter(c => {
    const d = String(c.domain || '').replace(/^\./, '').toLowerCase();
    return d === 'doubao.com' || d.endsWith('.doubao.com');
  });
}

// 检测单个账号。
// v3.0.13: 实测推翻"有强凭证 cookie = 已登录"这个前提 ——
// 未登录访客只要在页面上做过操作(例如发消息触发图形验证码), 豆包就会下发一整套
// sessionid / sid_tt / uid_tt / sid_guard(实测该访客分区有 21 个 cookie, 其中 8 个"强凭证")。
// 所以改成以 passport 接口为准:
//   真登录 -> { name:"qweqwe", user_id:7xxxxxxxxxx }
//   访客   -> { name:"account_info_error", user_id:0 }
async function detectAccountStatus(accountId, opts) {
  const o = opts || {};
  const res = { id: accountId, online: false, strong: [], cookieCount: 0, api: 'skip', verified: false };
  let cookies = [];
  try {
    cookies = await getDoubaoCookies(accountId);
  } catch (e) {
    res.error = e.message;
    return res;
  }
  res.cookieCount = cookies.length;
  res.strong = cookies.map(c => c.name).filter(isStrongAuthCookie);

  // 连凭证 cookie 都没有, 一定没登录, 不必请求接口
  if (!res.strong.length) { res.online = false; res.verified = true; return res; }

  // 只做"有没有凭证"的粗筛(登录监控用), 不下最终结论
  if (o.probe === false) { res.online = true; res.uncertain = true; return res; }

  try {
    const ses = session.fromPartition('persist:' + accountId);
    const r = await ses.fetch('https://www.doubao.com/passport/account/info/v2/?language=zh_cn', {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'include'
    });
    res.api = r.ok ? 'ok' : ('http-' + r.status);
    if (r.ok) {
      const j = await r.json().catch(() => null);
      const d = (j && j.data) || {};
      const name = String(d.name || '');
      const uid = Number(d.user_id || 0);
      const real = uid > 0 && !!name && name !== 'account_info_error' && d.is_visitor_account !== true;
      res.online = real;
      res.verified = true;
      res.nickname = real ? name : '';
      if (!real) res.guest = true;   // 明确的访客态(从未登录过)
    }
  } catch (e) {
    res.api = 'error';
  }
  // 接口没给出结论(网络异常等): 标记不确定, 由上层保持原状态, 避免网络抖动误判
  if (!res.verified) { res.uncertain = true; res.online = false; }
  return res;
}

// 把检测结果落到 accounts.json 与侧栏徽标。保活与手动检测共用同一出口。
function applyDetectResult(accountId, r) {
  const list = loadAccounts();
  const acc = list.find(a => a.id === accountId);
  if (!acc) return null;

  const curBadge = badges.get(accountId);
  // 页面自己都加载失败时, 状态判断没有意义, 不覆盖 loadfail
  if (curBadge === 'loadfail') {
    return { id: accountId, label: acc.label, online: r.online, skipped: 'loadfail', strong: r.strong.length };
  }

  // 接口没给出结论(网络异常): 保持现状, 别因为一次抖动把在线账号标成掉线
  if (r.uncertain) {
    return {
      id: accountId, label: acc.label,
      online: curBadge === 'online',
      uncertain: true, strong: r.strong.length, api: r.api
    };
  }

  const wasPending = !!acc.pending;

  if (r.online) {
    if (acc.pending) { acc.pending = false; saveAccounts(list); }
    if (curBadge !== 'online') markBadge(accountId, 'online');
    if (wasPending) {
      log('检测到已登录, 自动转正: ' + acc.label + ' | 凭证=' + r.strong.slice(0, 4).join(',') +
        ' | cookie=' + r.cookieCount + ' | api=' + r.api + (r.nickname ? ' | 昵称=' + r.nickname : ''));
      pushToRenderer('account:ready', { id: accountId, label: acc.label });
      // 转正后自动识别昵称(走统一的多策略识别)
      setTimeout(() => tryAutoRename(accountId, false), 1200);
    }
  } else if (r.guest) {
    // v3.0.13: 接口明确判定为访客态(有 cookie 但没登录)。
    // 归为"待登录"而不是"掉线" —— 访客 cookie 不代表曾经登录过。
    if (!acc.pending) { acc.pending = true; saveAccounts(list); }
    if (curBadge !== 'pending') {
      markBadge(accountId, 'pending');
      log('接口判定为未登录(访客态), 归为待登录: ' + acc.label + ' | cookie=' + r.cookieCount);
    }
  } else if (!acc.pending) {
    if (curBadge !== 'offline') {
      markBadge(accountId, 'offline');
      log('检测到掉线(强凭证消失): ' + acc.label + ' | cookie=' + r.cookieCount);
      pushToRenderer('account:logout', { id: accountId, label: acc.label });
    }
  } else if (curBadge !== 'pending') {
    // 从未登录过的新账号: 维持待登录
    markBadge(accountId, 'pending');
  }

  return { id: accountId, label: acc.label, online: r.online, wasPending, strong: r.strong.length, api: r.api };
}

async function autoCheckAccount(accountId) {
  try {
    const r = await detectAccountStatus(accountId);
    applyDetectResult(accountId, r);
  } catch (e) { log('自动检测异常: ' + e.message); }
}

function startLoginMonitor(accountId) {
  if (monitors.has(accountId)) return; // 防重入
  const m = { timer: null, diag: null, done: false };
  monitors.set(accountId, m);

  const getViewWC = () => {
    const v = viewPool.get(accountId);
    return (v && !v.webContents.isDestroyed()) ? v.webContents : null;
  };

  const finish = async (how) => {
    if (m.done) return;
    m.done = true;
    clearMonitor(accountId);
    const list = loadAccounts();
    const acc = list.find(a => a.id === accountId);
    if (!acc) return;

    if (how === 'success') {
      acc.pending = false;
      acc.addedAt = Date.now();
      saveAccounts(list);
      markBadge(accountId, 'online');
      pushToRenderer('account:ready', { id: accountId, label: acc.label });
      // 登录成功后自动识别昵称(走统一的多策略识别)
      setTimeout(() => tryAutoRename(accountId, false), 2000);
    } else {
      markBadge(accountId, 'pending');
      pushToRenderer('account:login-timeout', { id: accountId });
    }
  };

  const pollAll = async () => {
    if (m.done) return;
    // 第一步: 只看有没有凭证 cookie(便宜、不产生请求)
    const quick = await detectAccountStatus(accountId, { probe: false });
    if (!quick.online) return;            // 连 cookie 都没有, 继续等扫码

    // 第二步: 访客也会下发同一套 cookie, 必须让接口确认真的是登录了
    // (访客接口返回 { name:"account_info_error", user_id:0 })
    if (Date.now() - (m.lastProbe || 0) < 10000) return;  // 访客态每 10 秒才复核一次, 别把接口打爆
    m.lastProbe = Date.now();

    const v = await detectAccountStatus(accountId, { probe: true });
    if (v.verified && v.online) {
      log('登录成功(接口确认): ' + accountId + (v.nickname ? ' 昵称=' + v.nickname : ''));
      finish('success');
    } else if (v.verified) {
      log('cookie 已出现但接口判为访客态, 继续等待扫码: ' + accountId);
    } else {
      log('接口暂不可用, 稍后重试: ' + accountId + ' api=' + v.api);
    }
  };

  const wc = getViewWC();
  if (wc) {
    wc.on('did-navigate', pollAll);
    wc.on('did-navigate-in-page', pollAll);
    wc.once('did-finish-load', () => {
      setTimeout(() => {
        if (!m.done) {
          pollAll();
          m.timer = setInterval(pollAll, 2000);
        }
      }, 2500);
    });
    // 诊断日志: 每 10 秒一条, 仅登录期
    m.diag = setInterval(async () => {
      const w2 = getViewWC();
      if (!w2) return;
      try {
        const u = w2.getURL();
        log('[登录诊断] ' + accountId + ' url=' + u.slice(0, 90));
      } catch (e) {}
    }, 10000);
  }
  // 5 分钟超时(保持待登录状态, 用户可继续扫码或删除)
  setTimeout(() => { if (!m.done) finish('timeout'); }, 5 * 60 * 1000);
}

// 点添加账号: 新建视图, 直接在视图里扫码, 检测到凭证自动转正
function startLoginInView() {
  return new Promise((resolve) => {
    const tempId = 'acct-' + Date.now();
    const accounts = loadAccounts();
    // 编号取现有"账号 N"的最大值+1, 避免并发添加时重名
    let maxN = 0;
    accounts.forEach(a => {
      const m = /^账号\s*(\d+)$/.exec(a.label);
      if (m) { const n = parseInt(m[1], 10); if (n > maxN) maxN = n; }
    });
    const account = {
      id: tempId,
      label: '账号 ' + (maxN + 1),
      color: PALETTE[accounts.length % PALETTE.length],
      note: '',
      addedAt: Date.now(),
      pending: true
    };
    accounts.push(account);
    saveAccounts(accounts);
    markBadge(tempId, 'pending');
    setActiveAccount(tempId);
    log('视图内登录开始: ' + tempId);
    startLoginMonitor(tempId);
    resolve({ id: tempId, label: account.label });
  });
}

// ---------- 保活/掉线检测(强凭证版, 每 45 秒) ----------
function startKeepAlive() {
  setInterval(async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const accounts = loadAccounts();
    for (const acc of accounts) {
      // v3.0.2 修复: 这里原先对 pending 账号直接 continue。
      // 后果是"添加后 5 分钟登录监控超时, 之后才扫码登录"的账号永远停在待登录 ——
      // 用户已经登录了, 界面还显示未登录。现在所有账号都复查, 有强凭证就自动转正。
      // v3.0.13: 保活也要走接口确认 —— 访客同样有强凭证 cookie。
      // 没有凭证 cookie 的账号会在本地直接返回, 不产生任何请求。
      const r = await detectAccountStatus(acc.id);
      applyDetectResult(acc.id, r);
      // v3.0.7: 套餐信息缺失或已过期时顺手补一次(接口可能比首轮轮询更晚返回)
      const mi = memberInfo.get(acc.id);
      if (!mi || !mi.active || (mi.endTime && mi.endTime < Date.now())) {
        readMemberFromPage(acc.id);
      }
    }
  }, 45000);
}

// ---------- 跨账号完成提醒(v3.0.3) ----------
// 原理(实测, 探针见工作区 notify-probe/):
//   豆包生成回复期间, 输入区会出现 [data-testid="chat_input_local_break_button"](停止生成);
//   它消失即代表本轮回复结束, 正文长度随之定格。
//   实测时间线: 发送后 1.1s 出现 → 5.2s 消失。
// 用主进程统一轮询(而不是页面内 setInterval), 因为后台视图的定时器会被浏览器节流。
const genBusy = new Map();     // accountId -> 侧栏显示的"生成中"
const genDone = new Map();     // accountId -> 有未查看的完成
const genSince = new Map();    // accountId -> 本轮"生成中"起始时间
const genSeen = new Set();     // 本轮是否真的看到过"停止生成"按钮
const genStartLen = new Map(); // accountId -> 本轮生成开始时的正文长度
const genTaskWait = new Map();   // accountId -> {len0, startedAt} 后台长任务等待中
const genSettle = new Map();     // accountId -> {until} 刚结束、正在观察最后一段文案
const genProbing = new Set();  // 正在进行中的探测, 防止堆积
let genTickRunning = false;

const GEN_MIN_DURATION = 1500;      // 短于此的"生成中"视为噪声
const GEN_WARMUP = 8000;            // 视图创建后这段时间内不做完成通知(仍在加载)
const GEN_OPTIMISTIC_GRACE = 3000;  // 回车后等真实信号的宽限期, 超时才回落
const GEN_TASK_MAX_WAIT = 20 * 60 * 1000;  // 后台任务等待上限(实测 5 秒视频约 5 分钟)
// v3.0.11: "停止按钮消失"的时刻早于最后一段话渲染完。
// 若在那一刻只读一次文案, 就会漏掉"大约需要 1-3 分钟…"这种刚出现的任务提示,
// 表现为"提前切走就不转圈、也不提示"。所以结束后先开一个观察窗, 期间文案一出现就转入等待态。
const GEN_SETTLE_MS = 2500;

const GEN_STATE_SCRIPT = `(() => {
  try {
    // 判据只认 [data-testid="chat_input_local_break_button"](停止生成按钮)。
    // 不能把 message_loading 一起算: 实测它在"加载历史消息"时也会出现,
    // 而生成中它 2.6s 就消失了(真正生成到 5.2s), 拿它当信号会误报。
    var b = !!document.querySelector('[data-testid="chat_input_local_break_button"]');
    var txt = document.body ? document.body.innerText : '';
    var tail = txt.slice(-600);

    // v3.0.10 实测(你好啊账号真实生成 5 秒视频)得到的两个关键文案:
    //   任务已提交(按钮消失但还在后台跑):
    //     "…大约需要 1-3 分钟。视频生成好后，我会主动发送给你。本次生成将消耗每日免费额度。"
    //   任务完成:
    //     "你的视频生成好了。"
    // 注意: 页面里始终没有 <video> 元素, 所以不能拿 video 数量当产物判据。
    // 关键词必须够"硬" —— 之前用"生成中/正在生成"这类宽泛词, 会把普通对话也误判成后台任务。
    var taskPending = /生成好后[^。]{0,12}会主动发送|本次生成将消耗|预计等待\\s*\\d+\\s*分钟|大约需要\\s*\\d+[-~]?\\d*\\s*分钟/.test(tail);
    var taskDone = /视频生成好了|生成好了|生成完成|已生成好|视频已生成/.test(tail);

    var p = location.pathname || '';
    var inChat = /^\\/chat\\/[^\\/]+/.test(p);
    return {
      busy: b,
      len: txt.length,
      inChat: inChat,
      taskPending: taskPending,
      taskDone: taskDone,
      tail: tail.slice(-160)
    };
  } catch (e) { return null; }
})()`;

async function probeGenerating(accountId) {
  const v = viewPool.get(accountId);
  if (!v || v.webContents.isDestroyed()) return null;
  if (genProbing.has(accountId)) return null;   // 上一次还没返回, 本次跳过
  genProbing.add(accountId);
  try {
    return await v.webContents.executeJavaScript(GEN_STATE_SCRIPT, true);
  } catch (e) {
    return null;
  } finally {
    genProbing.delete(accountId);
  }
}

function onGenerateFinished(accountId) {
  const acc = loadAccounts().find(a => a.id === accountId);
  if (!acc) return;
  // 视图刚建好时页面还在加载, 期间的 loading 残留不代表真实生成
  const v = viewPool.get(accountId);
  if (v && v.__createdAt && Date.now() - v.__createdAt < GEN_WARMUP) {
    log('忽略加载期状态跳变: ' + acc.label);
    return;
  }
  // 用户就守在这个账号页面上, 不需要打扰
  if (accountId === activeAccountId) {
    log('生成完成(当前账号, 不提示): ' + acc.label);
    return;
  }
  genDone.set(accountId, true);
  log('后台账号生成完成: ' + acc.label);
  pushToRenderer('account:done', { id: accountId, label: acc.label });
  try {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
      mainWindow.flashFrame(true);   // 窗口不在前台时闪任务栏
    }
  } catch (e) {}
}

// 侧栏"生成中"状态一变就推给界面。
// v3.0.4 修: 之前只在"完成"时推事件, 开始生成时只改了内存,
// 界面要等别的动作(切号/检测/徽标更新)触发刷新才看到转圈 —— 表现为"转圈要等一会才出来"。
function pushBusy(accountId) {
  pushToRenderer('account:busy', { id: accountId, busy: !!genBusy.get(accountId) });
}
function setGenBusy(accountId, busy) {
  const cur = genBusy.get(accountId) || false;
  if (cur === busy) return false;
  genBusy.set(accountId, busy);
  pushBusy(accountId);
  return true;
}

// 用户按下回车的那一刻先点亮"生成中": 豆包要 1.1s 才渲染出停止按钮, 再等轮询更久。
// 若 3 秒内没等到真实信号(比如输入为空按了回车), 静默回落, 不会误报完成。
function optimisticBusy(accountId) {
  genSeen.delete(accountId);
  genStartLen.delete(accountId);
  genSettle.delete(accountId);
  if (!genBusy.get(accountId)) {
    genSince.set(accountId, Date.now());
    setGenBusy(accountId, true);
  }
}

async function tickGenWatcher() {
  if (genTickRunning) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  genTickRunning = true;
  try {
    for (const id of Array.from(viewPool.keys())) {
      const real = await probeGenerating(id);
      if (!real) continue;                 // 视图不可用/正忙, 保持原状态

      // ---- v3.0.10: 后台长任务等待中(视频生成等) ----
      // 实测: 提交后页面会停在"…大约需要 1-3 分钟…视频生成好后我会主动发送给你"，
      // 期间没有任何 DOM 产物，真正的完成信号是正文里多出一句「你的视频生成好了」并伴随正文变长。
      if (genTaskWait.has(id)) {
        const tw = genTaskWait.get(id);
        const grew = real.len - (tw.len0 || 0);
        const done = real.taskDone && grew > 5;
        const overtime = Date.now() - tw.startedAt > GEN_TASK_MAX_WAIT;
        if (done || overtime) {
          genTaskWait.delete(id);
          genSince.delete(id);
          genSeen.delete(id);
          genStartLen.delete(id);
          genSettle.delete(id);
          setGenBusy(id, false);
          log((done
            ? '后台任务完成(出现"生成好了"文案, 正文 +' + grew + ')'
            : '后台任务等待超时, 强制收尾') + ': ' + id);
          onGenerateFinished(id);
        }
        continue;   // 等待期间不改 busy, 保持转圈
      }

      if (real.busy && real.inChat) {
        genSeen.add(id);
        if (!genBusy.get(id)) {
          genSince.set(id, Date.now());
          setGenBusy(id, true);
        }
        if (!genStartLen.has(id)) genStartLen.set(id, real.len);   // 记下生成起点正文长度
        continue;
      }

      // 还在"停止按钮"状态但不在具体对话里(首页/设置页) —— 不予采信, 按非生成处理

      // v3.0.9: 这里原本有个"启动恢复"判断(页面尾部有任务话术就恢复转圈),
      // 实测会误伤 —— 页面残留的旧文案会让没在跑任务的账号一直转圈。
      // 按用户要求取消: 只跟踪软件打开之后真实发生的生成过程。
      if (!genBusy.get(id)) continue;      // 本来就不忙, 无事发生

      const seen = genSeen.has(id);
      const dur = Date.now() - (genSince.get(id) || 0);

      // 回车后的乐观态: 真实信号可能还没出现, 先别回落, 否则转圈会闪一下
      if (!seen && dur < GEN_OPTIMISTIC_GRACE) continue;

      const grew = real.len - (genStartLen.get(id) || 0);

      // 1) 明确的"任务已提交"信号 —— 立刻转入后台等待, 转圈不停
      if (real.taskPending && !real.taskDone) {
        genSettle.delete(id);
        genTaskWait.set(id, { len0: real.len, startedAt: Date.now() });
        log('检测到后台任务(已提交, 待产物), 保持转圈: ' + id +
          ' | 末尾: ' + String(real.tail || '').replace(/\s+/g, ' ').slice(-70));
        continue;
      }

      // 2) 刚结束: 先别急着下结论。
      // "停止按钮消失"比最后一段话渲染完更早, 提前切走时那次读取会漏掉任务提示。
      // 观察窗口内只要出现任务话术就转 1) 分支, 否则窗口结束才算真完成。
      const settle = genSettle.get(id);
      if (!settle) {
        genSettle.set(id, { until: Date.now() + GEN_SETTLE_MS });
        log('生成结束, 观察 ' + GEN_SETTLE_MS + 'ms 等末段文案: ' + id);
        continue;
      }
      if (Date.now() < settle.until) continue;
      genSettle.delete(id);

      setGenBusy(id, false);
      genSince.delete(id);
      genSeen.delete(id);
      genStartLen.delete(id);

      if (!seen) { log('乐观状态回落(未检测到生成): ' + id); continue; }
      if (dur < GEN_MIN_DURATION) { log('忽略极短状态跳变(' + dur + 'ms): ' + id); continue; }
      // 真实生成一定让正文变长; 没变长说明是页面加载残留的按钮状态, 不是真生成
      if (grew < 10) { log('正文未增长(' + grew + ' 字符), 视为加载残留: ' + id); continue; }
      log('生成完成: ' + id + ' | 时长=' + dur + 'ms | 正文 +' + grew +
        ' | 末尾: ' + String(real.tail || '').replace(/\s+/g, ' ').slice(-70));
      onGenerateFinished(id);              // 由"生成中"落到"已完成"
    }
  } finally {
    genTickRunning = false;
  }
}

function startGenWatcher() {
  setInterval(tickGenWatcher, 700);
}

// ---------- 会员/套餐识别(v3.0.5) ----------
// 数据来源(实测, 探针 11): 豆包页面自己会请求
//   /alice/commerce/sale/subscription/entry/config/   -> has_active_subscription, membership_display_name
//   /alice/commerce/sale/subscription/quota/summary/  -> current_subscription.sku_key / display.short_name / end_time
// 这两个接口的 URL 带 msToken/a_bogus 签名, 主进程构造不出来, 所以由 member-preload.js
// 在页面主世界钩住 fetch/XHR 把响应存到 window.__MEMBER__, 这里再读取解析。
const memberInfo = new Map();   // accountId -> { active, name, sku, endTime, isGift, checkedAt }
const memberExpiredLogged = new Set();  // 已记录过"套餐过期"的账号, 避免日志刷屏

// v3.0.6: 套餐结果落盘, 下次启动立刻就能显示, 不用干等页面把订阅接口请求完
const MEMBER_CACHE_FILE = path.join(USER_DIR, 'member-cache.json');
function loadMemberCache() {
  try {
    const j = JSON.parse(fs.readFileSync(MEMBER_CACHE_FILE, 'utf-8'));
    let n = 0;
    Object.keys(j || {}).forEach(id => {
      const v = j[id];
      if (v && typeof v === 'object') { memberInfo.set(id, v); if (v.active) n++; }
    });
    if (n) log('套餐缓存已恢复: ' + n + ' 个账号有套餐(启动瞬间即可显示)');
  } catch (e) {}
}
function saveMemberCache() {
  try {
    const o = {};
    memberInfo.forEach((v, k) => { o[k] = v; });
    fs.mkdirSync(USER_DIR, { recursive: true });
    fs.writeFileSync(MEMBER_CACHE_FILE, JSON.stringify(o, null, 2), 'utf-8');
  } catch (e) {}
}
loadMemberCache();

function parseMemberPayload(d) {
  if (!d || (!d.entry && !d.quota)) return null;
  const entry = d.entry && d.entry.data;
  const quota = d.quota && d.quota.data;
  const cs = (quota && quota.current_subscription) || {};
  const mi = (quota && quota.member_info) || {};
  const display = cs.display || {};
  const active = entry && typeof entry.has_active_subscription === 'boolean'
    ? !!entry.has_active_subscription
    : !!mi.hasActiveSubscription;
  const name = (entry && entry.membership_display_name) || display.short_name || display.product_name || '';
  return {
    active: active,
    name: String(name || ''),
    sku: String(cs.sku_key || ''),
    endTime: Number(cs.end_time || 0),
    isGift: !!cs.is_gift
  };
}

async function readMemberFromPage(accountId) {
  const v = viewPool.get(accountId);
  if (!v || v.webContents.isDestroyed()) return null;
  let payload;
  try {
    const raw = await v.webContents.executeJavaScript('JSON.stringify(window.__MEMBER__ || null)', true);
    payload = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  const m = parseMemberPayload(payload);
  if (!m) return null;
  m.checkedAt = Date.now();
  const prev = memberInfo.get(accountId);
  memberInfo.set(accountId, m);
  if (!prev || prev.active !== m.active || prev.name !== m.name || prev.endTime !== m.endTime) {
    const acc = loadAccounts().find(a => a.id === accountId);
    log('套餐识别: ' + (acc ? acc.label : accountId) + ' -> ' +
      (m.active ? (m.name || '有套餐') + (m.sku ? ' [' + m.sku + ']' : '') : '无套餐'));
    saveMemberCache();
    pushToRenderer('badge:update', { id: accountId, status: badges.get(accountId) || 'online' });
  }
  return m;
}

// v3.0.6: 页面订阅接口一返回就能读到, 用短间隔轮询代替"固定等 3 秒 / 9 秒"。
// 拿到结果立刻停, 没拿到最多等 maxMs。
async function waitMemberInfo(accountId, maxMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (maxMs || 12000)) {
    const m = await readMemberFromPage(accountId);
    if (m) return m;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

// ---------- 删除账号(含分区清理三连兜底 + 待清扫机制) ----------
async function deleteAccountDeep(id) {
  // 1. 清监控与视图(释放句柄)
  clearMonitor(id);
  if (viewPool.has(id)) {
    try { mainWindow.contentView.removeChildView(viewPool.get(id)); } catch (e) {}
    try { viewPool.get(id).webContents.close(); } catch (e) {}
    viewPool.delete(id);
    if (activeAccountId === id) activeAccountId = null;
  }
  // 2. 清内存态 session 数据
  try {
    const ses = session.fromPartition('persist:' + id);
    await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'] });
    await ses.clearCache();
  } catch (e) { log('session 清理失败: ' + e.message); }
  await new Promise(r => setTimeout(r, 250));

  // 3. 删分区目录: fs.rmSync → PowerShell .NET → cmd rmdir
  const partDir = path.join(USER_DIR, 'Partitions', id);
  if (!fs.existsSync(partDir)) { log('分区目录不存在: ' + id); return; }
  let cleaned = false;
  try {
    fs.rmSync(partDir, { recursive: true, force: true });
    cleaned = !fs.existsSync(partDir);
  } catch (e1) { log('rmSync 失败: ' + e1.message); }
  if (!cleaned) {
    try {
      const psScript = "$t='" + partDir.replace(/\\/g, '\\\\') + "'; if (Test-Path -LiteralPath $t) { [System.IO.Directory]::Delete($t, $true) }";
      require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-Command', psScript], { stdio: 'ignore', timeout: 10000 });
      cleaned = !fs.existsSync(partDir);
    } catch (e2) {}
  }
  if (!cleaned) {
    try {
      require('child_process').execFileSync('cmd.exe', ['/c', 'rmdir', '/S', '/Q', partDir], { stdio: 'ignore', timeout: 10000 });
      cleaned = !fs.existsSync(partDir);
    } catch (e3) {}
  }
  if (!cleaned) {
    log('三种删除均失败, 记入待清扫: ' + id);
    try {
      const pendFile = path.join(USER_DIR, 'pending-cleanup.json');
      let pend = [];
      if (fs.existsSync(pendFile)) pend = JSON.parse(fs.readFileSync(pendFile, 'utf-8') || '[]');
      if (pend.indexOf(id) < 0) pend.push(id);
      fs.writeFileSync(pendFile, JSON.stringify(pend, null, 2));
    } catch (e4) {}
  } else {
    log('分区已清除: ' + id);
  }
  // 4. 顺带清掉该账号的下载目录(若有)
  const dlDir = path.join(DOWNLOAD_DIR, id);
  try {
    if (fs.existsSync(dlDir)) {
      const left = fs.readdirSync(dlDir);
      if (left.length === 0) {
        fs.rmdirSync(dlDir);
        log('已清理空下载目录: ' + id);
      } else {
        log('下载目录有文件, 保留待用户处理: ' + dlDir + ' (' + left.length + ' 项)');
      }
    }
  } catch (e5) {}
}

function sweepPendingCleanups() {
  try {
    const pendFile = path.join(USER_DIR, 'pending-cleanup.json');
    if (!fs.existsSync(pendFile)) return;
    const pend = JSON.parse(fs.readFileSync(pendFile, 'utf-8') || '[]');
    if (!pend.length) return;
    const remaining = [];
    for (const id of pend) {
      const p = path.join(USER_DIR, 'Partitions', id);
      if (fs.existsSync(p)) {
        try { fs.rmSync(p, { recursive: true, force: true }); log('启动清扫分区: ' + id); }
        catch (e) { remaining.push(id); }
      }
    }
    fs.writeFileSync(pendFile, JSON.stringify(remaining, null, 2));
  } catch (e) { log('sweepPendingCleanups 异常: ' + e.message); }
}

// ---------- 推送到渲染层 ----------
function pushToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ---------- 主窗口 ----------
function createMainWindow() {
  const b = prefs.winBounds || {};
  mainWindow = new BrowserWindow({
    width: b.width || 1400,
    height: b.height || 900,
    x: (typeof b.x === 'number') ? b.x : undefined,
    y: (typeof b.y === 'number') ? b.y : undefined,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#f5f5f7',
    title: '豆包多开管理器',
    show: false,
    icon: path.join(APP_DIR, 'app.ico'),
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.once('ready-to-show', () => { mainWindow.show(); });

  // 尺寸变化同步给激活视图
  const syncBounds = () => {
    if (activeAccountId && viewPool.has(activeAccountId)) {
      try { viewPool.get(activeAccountId).setBounds(getContentBounds()); } catch (e) {}
    }
  };
  mainWindow.on('resize', syncBounds);
  mainWindow.on('maximize', syncBounds);
  mainWindow.on('restore', syncBounds);
  mainWindow.on('enter-full-screen', syncBounds);
  mainWindow.on('leave-full-screen', syncBounds);

  // 记录窗口位置
  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    prefs.winBounds = mainWindow.getBounds();
    savePrefs();
  };
  mainWindow.on('close', (e) => {
    saveBounds();
    if (prefs.closeToTray && !forceQuitting.value) {
      e.preventDefault();
      mainWindow.hide();
      if (tray) {
        try { tray.displayBalloon({ title: '豆包多开管理器', content: '已最小化到托盘, 双击图标可恢复。' }); } catch (e2) {}
      }
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; activeAccountId = null; });
  mainWindow.loadFile('index.html').catch((e) => log('loadFile 失败: ' + e.message));
}

// ---------- 缩放(作用于豆包页面本身) ----------
function zoomActive(delta) {
  const v = getActiveView();
  if (!v) return;
  let lvl = v.webContents.getZoomLevel();
  let next = delta === 0 ? 0 : Math.max(-4, Math.min(4, lvl + delta));
  v.webContents.setZoomLevel(next);
}

function reloadActiveView() {
  const v = getActiveView();
  if (v) {
    v.__retries = 0;
    v.webContents.loadURL(DOUBAO_URL).catch(() => {});
  }
}

function selectByIndex(i) {
  const accounts = loadAccounts();
  if (i < 0 || i >= accounts.length) return;
  setActiveAccount(accounts[i].id);
  pushToRenderer('active:changed', { id: accounts[i].id });
}

// ---------- 应用菜单 ----------
function buildAppMenu() {
  const template = [
    {
      label: '文件(&F)',
      submenu: [
        { label: '添加豆包账号', accelerator: 'CmdOrCtrl+N', click: () => pushToRenderer('menu:addAccount') },
        { label: '打开下载目录', click: () => { try { fs.mkdirSync(DOWNLOAD_DIR, { recursive: true }); shell.openExternal('file:///' + DOWNLOAD_DIR.replace(/\\/g, '/')); } catch (e) {} } },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Shift+Q', click: () => { forceQuitting.value = true; app.quit(); } }
      ]
    },
    {
      label: '编辑(&E)',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图(&V)',
      submenu: [
        { label: '重新加载当前页', accelerator: 'CmdOrCtrl+R', click: () => reloadActiveView() },
        { type: 'separator' },
        { label: '放大', accelerator: 'CmdOrCtrl+=', click: () => zoomActive(+0.5) },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => zoomActive(-0.5) },
        { label: '实际大小', accelerator: 'CmdOrCtrl+0', click: () => zoomActive(0) },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '切换(&S)',
      submenu: (() => {
        const arr = [];
        for (let i = 1; i <= 9; i++) {
          arr.push({
            label: '第 ' + i + ' 个账号',
            accelerator: 'CmdOrCtrl+' + i,
            click: () => selectByIndex(i - 1)
          });
        }
        return arr;
      })()
    },
    {
      label: '帮助(&H)',
      submenu: [
        {
          label: '关于', click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于',
              message: '豆包多开管理器 v3.0.13',
              detail: '视图池架构 · 单窗口毫秒级切号\n数据目录: ' + USER_DIR + '\n\n原理: 使用 Chromium 分区会话隔离各账号,\n不修改豆包官方程序。'
            });
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- 托盘 ----------
function buildTray() {
  try {
    const icoPath = path.join(APP_DIR, 'app.ico');
    tray = new Tray(nativeImage.createFromPath(icoPath));
  } catch (e) {
    tray = new Tray(nativeImage.createEmpty());
  }
  tray.setToolTip('豆包多开管理器');
  tray.on('double-click', () => ShowMain());
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const items = [];
  const accounts = loadAccounts();
  for (const acc of accounts.slice(0, 15)) {
    items.push({
      label: ((badges.get(acc.id) === 'offline' || acc.pending) ? '○ ' : '● ') + acc.label,
      click: () => {
        setActiveAccount(acc.id);
        ShowMain();
      }
    });
  }
  if (accounts.length) items.push({ type: 'separator' });
  items.push({ label: '显示主窗口', click: () => ShowMain() });
  items.push({
    label: '退出',
    click: () => { forceQuitting.value = true; app.quit(); }
  });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function ShowMain() {
  if (!mainWindow || mainWindow.isDestroyed()) { createMainWindow(); return; }
  mainWindow.show();
  mainWindow.focus();
}

// ---------- IPC ----------
ipcMain.handle('accounts:list', () => {
  const accounts = loadAccounts();
  const now = Date.now();
  return accounts.map(a => {
    const m = memberInfo.get(a.id);
    // v3.0.7: 缓存的套餐可能已经过期(账号掉线/页面没加载出来时刷不到新数据)。
    // end_time 过了就不显示, 宁可空着也不能挂着过期会员误导人。
    // endTime 为 0 表示没有明确到期时间, 这种情况下保留显示。
    const expired = !!(m && m.active && m.endTime && m.endTime < now);
    if (expired && !memberExpiredLogged.has(a.id)) {
      memberExpiredLogged.add(a.id);
      log('套餐已过期, 不再显示: ' + a.label + ' (到期 ' +
        new Date(m.endTime).toLocaleString('zh-CN') + ')');
    }
    return Object.assign({}, a, {
      badge: a.pending ? 'pending' : (badges.get(a.id) || 'online'),
      done: !!genDone.get(a.id),     // 后台已完成、尚未查看
      busy: !!genBusy.get(a.id),     // 正在生成
      // 有套餐才返回, 侧栏据此在名字旁边显示小字
      plan: (m && m.active && !expired)
        ? { name: m.name || '套餐', sku: m.sku, endTime: m.endTime, checkedAt: m.checkedAt }
        : null
    });
  });
});
ipcMain.handle('accounts:add', async () => await startLoginInView());
ipcMain.handle('accounts:select', (e, id) => { setActiveAccount(id); return true; });
ipcMain.handle('accounts:rename', (e, payload) => {
  const accounts = loadAccounts();
  const acc = accounts.find(a => a.id === payload.id);
  if (acc) { acc.label = String(payload.label).trim().slice(0, 20); saveAccounts(accounts); }
  return accounts;
});
ipcMain.handle('accounts:delete', async (e, id) => {
  const accounts = loadAccounts().filter(a => a.id !== id);
  saveAccounts(accounts);
  badges.delete(id);
  nameAttempts.delete(id);
  genBusy.delete(id);
  genDone.delete(id);
  genSince.delete(id);
  genSeen.delete(id);
  genStartLen.delete(id);
  genTaskWait.delete(id);
  genSettle.delete(id);
  memberInfo.delete(id);
  saveMemberCache();
  await deleteAccountDeep(id);
  rebuildTrayMenu();
  return accounts;
});
ipcMain.handle('accounts:detectName', async (e, id) => {
  const list = loadAccounts();
  const acc = list.find(a => a.id === id);
  if (!acc || acc.pending) return { ok: false, msg: '账号待登录' };
  const v = viewPool.get(id);
  if (!v || v.webContents.isDestroyed()) return { ok: false, msg: '请先切换到该账号(视图未加载)' };
  try {
    const res = await v.webContents.executeJavaScript(DETECT_NAME_SCRIPT, true);
    const name = res && res.name ? String(res.name).trim() : '';
    if (name) {
      acc.label = name;
      saveAccounts(list);
      pushToRenderer('account:ready', { id, label: name });
      return { ok: true, name };
    }
    return { ok: false, msg: '未能从页面识别到昵称(' + (res ? res.source : '?') + ')' };
  } catch (err) { return { ok: false, msg: err.message }; }
});
// v3.0.2 新增: 手动检测账号在线状态(逐个查, 含待登录账号)
ipcMain.handle('accounts:checkAll', async () => {
  const accounts = loadAccounts();
  const details = [];
  for (const acc of accounts) {
    const r = await detectAccountStatus(acc.id);
    const brief = applyDetectResult(acc.id, r);
    if (brief) details.push(brief);
  }
  const online = details.filter(x => x.online).length;
  log('手动检测全部账号: ' + online + '/' + details.length + ' 在线');
  return {
    total: details.length,
    online,
    notOnline: details.length - online,
    details
  };
});
ipcMain.handle('accounts:checkOne', async (e, id) => {
  const r = await detectAccountStatus(id);
  return applyDetectResult(id, r) || { id, label: '', online: false, missing: true };
});
ipcMain.handle('prefs:get', () => prefs);ipcMain.handle('prefs:set', (e, patch) => {
  prefs = Object.assign(prefs, patch || {});
  savePrefs();
  return prefs;
});
ipcMain.handle('downloads:openFolder', () => {
  try {
    fs.mkdirSync(path.join(DOWNLOAD_DIR, activeAccountId || '_通用'), { recursive: true });
    shell.openExternal('file:///' + DOWNLOAD_DIR.replace(/\\/g, '/'));
  } catch (e) {}
  return true;
});

// v3.0.9: 按用户要求移除"支持作者/收款码"整套功能
// (独立窗口 + 悬停预览卡 + 相关 IPC 全部删除, 收款码图片也已清理)


// ---------- 单实例 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => ShowMain());
}

// ---------- 启动流程 ----------
app.whenReady().then(() => {
  log('app ready, userData=' + app.getPath('userData'));
  sweepPendingCleanups();
  buildAppMenu();
  buildTray();
  createMainWindow();
  startKeepAlive();
  startGenWatcher();
  setTimeout(bootWarmup, 800);
  setInterval(rebuildTrayMenu, 15000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}).catch((e) => log('whenReady 失败: ' + e.message));

// 启动预热: 恢复上次激活账号; 其余已登录账号后台建视图(全部在线+触发昵称识别)
function bootWarmup() {
  const accounts = loadAccounts();
  if (!accounts.length) return;
  let target = accounts.find(a => a.id === prefs.lastActiveId && !a.pending);
  if (!target) target = accounts.find(a => !a.pending);
  if (!target) target = accounts[0];
  try { setActiveAccount(target.id); } catch (e) { log('warmup 激活失败: ' + e.message); }

  const others = accounts.filter(a => a.id !== target.id && !a.pending);
  others.forEach((acc, i) => {
    setTimeout(() => {
      if (!viewPool.has(acc.id)) {
        viewPool.set(acc.id, createViewForAccount(acc));
        log('后台预热视图: ' + acc.label);
      }
    }, 1200 + i * 800);
  });
}

app.on('window-all-closed', () => {
  log('所有窗口关闭, 退出');
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  log(forceQuitting.value ? '正常退出流程' : '收到退出请求(来源未标记)');
});

// 子进程(GPU/渲染器等)异常退出追踪
app.on('child-process-gone', (e, details) => {
  log('child-process-gone: type=' + details.type + ' reason=' + details.reason + ' exitCode=' + details.exitCode);
});

process.on('uncaughtException', (err) => log('uncaughtException: ' + err.message + '\n' + (err.stack || '')));
process.on('unhandledRejection', (err) => log('unhandledRejection: ' + String(err)));
