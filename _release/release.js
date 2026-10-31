#!/usr/bin/env node
/**
 * 豆包多开管理器 —— 一键发版脚本
 *
 * 用法:
 *   set GH_TOKEN=ghp_xxx
 *   node _release\release.js 4.1
 *
 * 可选参数:
 *   --dry-run        只做本地构建与打包, 不碰 GitHub (调试用)
 *   --skip-build     复用 _release\build\v<ver> 已有目录, 不重新复制运行时
 *   --skip-source    不推送源码到 main (只发 Release)
 *   --notes "文本"   直接给更新说明, 不读 notes\v<ver>.md
 *
 * 它做的事情, 顺序固定:
 *   1. 改版本号 (package.json + package-lock.json 两处)
 *   2. 构建便携版 _release\build\v<ver>\  (Electron 运行时 + resources\app)
 *   3. 压缩 _release\dist\DoubaoMultiOpen-v<ver>-windows-portable.zip
 *   4. 推源码到 main (单个 commit, 原子)
 *   5. 建 tag v<ver> + Release (tag 自动指向 main 最新, 不会再指旧提交)
 *   6. 上传便携包为 Release 资产
 *   7. 校验 releases/latest
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const OWNER = 'jianbingdev';
const REPO = 'doubao-multi-open';
const ROOT = path.resolve(__dirname, '..');
const TOKEN = process.env.GH_TOKEN;

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : null;
};
const VERSION = argv.find((a) => /^v?\d+(\.\d+){0,2}$/i.test(a));
const DRY = flag('--dry-run');
const SKIP_BUILD = flag('--skip-build');
const SKIP_SOURCE = flag('--skip-source');
const FULL_ONLY = flag('--full-only');
const CORE_ONLY = flag('--core-only');
const FULL_FROM = opt('--full-from');
const NOTES_ARG = opt('--notes');

if (FULL_ONLY && CORE_ONLY) {
  console.error('--full-only 和 --core-only 不能同时用。');
  process.exit(1);
}

if (!VERSION) {
  console.error('用法: node _release\\release.js <版本号>  [选项]');
  console.error('  例: node _release\\release.js 4.2');
  console.error('  --dry-run        只本地构建, 不碰 GitHub');
  console.error('  --full-only      只发完整包, 不产出/上传核心包(客户端要下 143MB)');
  console.error('  --core-only      只发核心包(增量), 不产出/上传完整包');
  console.error('                   完整包提示默认指向 Releases 列表; 想指到某个版本加');
  console.error('                   --full-from 4.2  → 提示里直接给 v4.2 的下载页');
  process.exit(1);
}
const VER = VERSION.replace(/^v/i, '');
const TAG = 'v' + VER;

const say = (step, msg) => console.log(step ? `[${step}] ${msg}` : msg);
const die = (msg) => {
  console.error('\n!! 失败: ' + msg);
  process.exit(1);
};

// ---------- GitHub API ----------
function req(method, host, urlPath, { headers = {}, body = null, redirect = true } = {}) {
  return new Promise((resolve, reject) => {
    const r = https.request({ method, host, path: urlPath, headers }, (res) => {
      if (redirect && [301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const u = new URL(res.headers.location);
        return req(method === 'POST' ? 'GET' : method, u.host, u.pathname + u.search, {
          headers,
          body: null,
          redirect
        }).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try {
          json = JSON.parse(buf.toString('utf8'));
        } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const gh = (method, urlPath, payload) => {
  const body = payload ? JSON.stringify(payload) : null;
  return req(method, 'api.github.com', urlPath, {
    headers: {
      'User-Agent': 'doubao-release-script',
      Authorization: 'Bearer ' + TOKEN,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {})
    },
    body
  });
};

// ---------- 版本号 ----------
function cmpVer(a, b) {
  const p = (v) => String(v || '0').replace(/^v/i, '').trim().split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
  const A = p(a), B = p(b);
  for (let i = 0; i < 3; i++) {
    const x = A[i] || 0, y = B[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

// 只改顶部 N 个 version 字段。
// package-lock.json 里每个依赖都有自己的 "version", 无差别 replace 会把整份锁文件写坏。
function bumpVersion(ver) {
  const targets = [
    { file: 'package.json', count: 1 },      // 顶层 version
    { file: 'package-lock.json', count: 2 }  // 顶层 version + packages[""].version
  ];
  for (const { file, count } of targets) {
    const p = path.join(ROOT, file);
    const before = fs.readFileSync(p, 'utf8');
    let done = 0;
    const after = before.replace(/"version":\s*"[^"]*"/g, (m) => (done++ < count ? `"version": "${ver}"` : m));
    if (before === after) {
      say(1, file + ' 版本号本来一致, 未改动');
    } else {
      fs.writeFileSync(p, after, 'utf8');
      say(1, `${file} 已改为 ${ver} (${done >= count ? count : done} 处)`);
    }
    // 立刻校验 JSON 仍可解析, 防止把锁文件写坏
    try {
      JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      die(file + ' 写入后 JSON 解析失败: ' + e.message);
    }
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  if (pkg.version !== ver) die('package.json 版本校验失败, 实际 ' + pkg.version);
  if (lock.version !== ver || (lock.packages && lock.packages[''] && lock.packages[''].version !== ver)) {
    die('package-lock.json 版本校验失败, 实际 ' + lock.version);
  }
  // 依赖数量必须保持一致, 否则就是误伤了别的 version 字段
  const deps = Object.keys(lock.packages || {}).length;
  say(1, `锁文件完好: ${deps} 个包条目`);
}

// ---------- 构建便携版 ----------
const APP_FILES = ['main.js', 'preload.js', 'member-preload.js', 'image-picker-inject.js', 'index.html', 'renderer.js', 'app.ico', 'README.md', 'LICENSE'];

// 清空/删除一个目录。
// 不能用 fs.rmSync(recursive): 本机安全策略对"单次删除超过 50 个文件"会直接拒绝,
// 而 build\v<版本> 里有几百个文件, 一重跑就卡住。robocopy 用空目录 /MIR 是等效且稳定的做法。
function wipeDir(dir) {
  if (!fs.existsSync(dir)) return;
  const empty = path.join(require('os').tmpdir(), 'dbmo_empty_' + process.pid + '_' + Date.now());
  fs.mkdirSync(empty, { recursive: true });
  const r = spawnSync('robocopy', [empty, dir, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/MT:8'], { stdio: 'ignore' });
  try {
    fs.rmdirSync(empty);
  } catch (e) {}
  try {
    fs.rmdirSync(dir); // 内容已空, 顺手把目录本身也去掉
  } catch (e) {}
  if (r.error) die('清空目录失败: ' + dir + ' (' + r.error.message + ')');
  if (r.status !== null && r.status >= 8) die('清空目录失败: ' + dir + ' (robocopy 退出码 ' + r.status + ')');
}

function buildPortable(ver) {
  const out = path.join(__dirname, 'build', 'v' + ver);
  const dist = path.join(ROOT, 'node_modules', 'electron', 'dist');
  if (!fs.existsSync(dist)) die('找不到 Electron 运行时: ' + dist + '  (先 npm install)');

  if (SKIP_BUILD && fs.existsSync(path.join(out, 'DoubaoMultiOpen.exe'))) {
    say(2, '跳过构建, 复用 ' + out);
  } else {
    wipeDir(out);
    say(2, '复制 Electron 运行时 (约 360 MB, 稍等)…');
    // 必须用 robocopy: fs.cpSync 在这里复制几百 MB 会直接把 node 进程搞崩
    // (Windows 下创建海量文件句柄翻车), robocopy 带 /MT 只要几百毫秒
    const rc = spawnSync(
      'robocopy',
      [dist, out, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/MT:8'],
      { stdio: 'ignore' }
    );
    // robocopy 的返回码 0~7 都是成功语义(0=无变化, 1=有复制, 3=有复制+额外文件)
    if (rc.error || rc.status === null || rc.status >= 8) {
      die('复制运行时失败 (robocopy 退出码 ' + (rc.status === null ? '未启动' : rc.status) + ')');
    }
    say(2, `运行时已复制 (${(dirSize(out) / 1024 / 1024).toFixed(0)} MB, robocopy=${rc.status})`);

    // 移除 electron 自带示例应用, 否则会盖掉我们的入口
    for (const f of ['default_app.asar', path.join('resources', 'default_app.asar')]) {
      const p = path.join(out, f);
      if (fs.existsSync(p)) fs.rmSync(p, { force: true });
    }
    const exe = path.join(out, 'electron.exe');
    if (!fs.existsSync(exe)) die('运行时里没有 electron.exe');
    const targetExe = path.join(out, 'DoubaoMultiOpen.exe');
    fs.renameSync(exe, targetExe);
    say(2, '可执行文件已命名为 DoubaoMultiOpen.exe');

    // 写 exe 图标。图标在 PE 资源段里, 光改名没用 —— 不写的话
    // 资源管理器里显示的永远是 Electron 的原子图标(和 app.ico 无关)。
    const iconPath = path.join(ROOT, 'app.ico');
    const rceditExe = path.join(ROOT, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe');
    if (fs.existsSync(rceditExe) && fs.existsSync(iconPath)) {
      const r2 = spawnSync(rceditExe, [targetExe, '--set-icon', iconPath], { stdio: 'pipe', encoding: 'utf8' });
      if (r2.status === 0) {
        say(2, 'exe 图标已写入 (rcedit)');
      } else {
        // 写不进去不算致命: 程序能跑, 只是图标还是 Electron 的
        console.log('  注意: exe 图标设置失败(不影响运行): ' + String(r2.stderr || r2.status).trim().slice(0, 160));
      }
    } else {
      console.log('  注意: 找不到 rcedit 或 app.ico, 跳过 exe 图标设置');
    }
  }

  // resources\app
  const appDir = path.join(out, 'resources', 'app');
  wipeDir(appDir);
  fs.mkdirSync(appDir, { recursive: true });
  for (const f of APP_FILES) {
    const src = path.join(ROOT, f);
    if (!fs.existsSync(src)) die('缺少应用文件: ' + f);
    fs.copyFileSync(src, path.join(appDir, f));
  }
  // docs 里的图片是 README 引用的, 逐个复制避免 cpSync 在大目录上翻车
  const docs = path.join(ROOT, 'docs');
  if (fs.existsSync(docs)) {
    const docsOut = path.join(appDir, 'docs');
    fs.mkdirSync(docsOut, { recursive: true });
    for (const f of fs.readdirSync(docs)) {
      const s = path.join(docs, f);
      if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(docsOut, f));
    }
  }

  // app 的 package.json: 只保留运行必需字段
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  fs.writeFileSync(
    path.join(appDir, 'package.json'),
    JSON.stringify(
      {
        name: pkg.name,
        productName: pkg.productName || pkg.name,
        version: ver,
        description: pkg.description,
        author: pkg.author,
        main: pkg.main,
        license: pkg.license
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  // 启动脚本: ASCII 内容 + set 清变量, 避免 ELECTRON_RUN_AS_NODE 继承导致变纯 Node
  const bat = [
    '@echo off',
    `title Doubao Multi-Account Manager v${ver}`,
    'REM Clear inherited env vars that force Electron into pure Node mode.',
    'set "ELECTRON_RUN_AS_NODE="',
    'set "ELECTRON_NO_ATTACH_CONSOLE="',
    'cd /d "%~dp0"',
    '',
    'if not exist "%~dp0DoubaoMultiOpen.exe" (',
    '  echo [ERROR] DoubaoMultiOpen.exe not found.',
    '  echo         Please unzip the whole archive and keep files together.',
    '  pause',
    '  exit /b 1',
    ')',
    '',
    'REM --no-sandbox: GPU sandbox is blocked on some machines (white screen).',
    'start "" "%~dp0DoubaoMultiOpen.exe" --no-sandbox --disable-gpu-sandbox --disable-dev-shm-usage',
    'exit',
    ''
  ].join('\r\n');
  fs.writeFileSync(path.join(out, '启动豆包多开.bat'), bat, 'latin1');

  // 绝不能带用户数据
  for (const junk of ['userdata', 'downloads', 'profiles', 'app-run.log', 'update.log']) {
    const p = path.join(out, junk);
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  }

  const size = dirSize(out);
  say(2, `构建完成: ${out}  (${(size / 1024 / 1024).toFixed(0)} MB)`);
  return out;
}

function dirSize(p) {
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name);
    total += e.isDirectory() ? dirSize(f) : fs.statSync(f).size;
  }
  return total;
}

// ---------- 压缩 ----------
// 统一的压缩实现。srcExpr 是给 Compress-Archive 的 -Path 表达式:
// 传目录 + '\*' 可以保证 zip 顶层直接是文件, 不带一层目录名。
function compress(srcExpr, zip, label) {
  if (fs.existsSync(zip)) fs.rmSync(zip, { force: true });
  // 注意: 不能用 tar -a -cf, 本机 Git Bash 会生成 tar 而不是 zip
  const ps = path.join(__dirname, '.zip-job.ps1');
  fs.writeFileSync(
    ps,
    '\uFEFF' +
      [
        '$ErrorActionPreference = "Stop"',
        `Compress-Archive -Path '${srcExpr}' -DestinationPath '${zip}' -CompressionLevel Optimal -Force`,
        '$b = [System.IO.File]::ReadAllBytes("' + zip + '")[0..3]',
        '"HEAD=" + (($b | ForEach-Object { $_.ToString("x2") }) -join " ")'
      ].join('\r\n'),
    'utf8'
  );
  say(3, '压缩中 ' + label + '…');
  // 不要加 -WindowStyle Hidden / windowsHide, 本机上会导致 PowerShell 根本起不来
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps], {
    stdio: 'inherit'
  });
  fs.rmSync(ps, { force: true });
  if (r.status !== 0) die('压缩失败(' + label + '), 退出码 ' + r.status);
  if (!fs.existsSync(zip)) die('压缩后找不到 zip: ' + zip);

  const head = fs.readFileSync(zip).slice(0, 4);
  if (!(head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04)) {
    die('产物不是有效 ZIP: ' + path.basename(zip) + ' 头字节 = ' + [...head].map((x) => x.toString(16)).join(' '));
  }
  say(3, `打包完成: ${path.basename(zip)}  (${(fs.statSync(zip).size / 1024).toFixed(0)} KB)`);
  return zip;
}

function zipPortable(srcDir, ver) {
  const distDir = path.join(__dirname, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const zip = path.join(distDir, `DoubaoMultiOpen-v${ver}-windows-portable.zip`);
  // 清掉历史包, 避免 dist 里堆一堆
  for (const f of fs.readdirSync(distDir)) {
    if (/\.zip$/i.test(f) && path.join(distDir, f) !== zip) {
      try {
        fs.rmSync(path.join(distDir, f), { force: true });
      } catch (e) {}
    }
  }
  return compress(srcDir, zip, '完整便携版');
}

// 精简版 package.json: 只保留运行必需字段
function leanPackageJson(ver) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return JSON.stringify(
    {
      name: pkg.name,
      productName: pkg.productName || pkg.name,
      version: ver,
      description: pkg.description,
      author: pkg.author,
      main: pkg.main,
      license: pkg.license
    },
    null,
    2
  ) + '\n';
}

// ---------- 核心包(自动更新用) ----------
// 内容 = resources\app 里那几个文件, 几百 KB。
// 刻意保留 resources\app 这层结构, 原因:
//   * v4.1+ 认得它, 只覆盖 resources\app, 不动 exe/运行时/userdata
//   * v4.0 及更早的客户端只会把整包解压后 robocopy 到安装根目录,
//     有了这层结构, 文件正好落到 resources\app 里 —— 旧版也能一次到位,
//     不用为了让老客户端升级而下 140 MB 的完整包。
// 发版前清掉开发标识。
// 工作区的 main.js 带着 APP_VERSION_LABEL = '开发版vX'（侧栏和关于窗口会显示），
// README 徽章是 vX--dev。这些都是开发时看的，不能进发布包，
// 更不能推上公开仓 —— 4.2.4 就是漏了这一步，下载包的用户看到了「开发版v4.2.4」。
function sanitizeFile(relPath, content) {
  const before = content.toString('utf-8');
  let s = before;
  if (relPath === 'main.js') {
    s = s.replace(/^const APP_VERSION_LABEL = '[^']*';\r?\n/m, '');
    s = s.replace(/message: '豆包多开管理器 ' \+ APP_VERSION_LABEL,/, "message: '豆包多开管理器 v' + APP_VERSION,");
    s = s.replace(/versionLabel: APP_VERSION_LABEL,/, "versionLabel: 'v' + APP_VERSION,");
  } else if (relPath === 'README.md') {
    s = s.replace(/(version-[\d.]+)--dev/g, '$1');
  }
  if (s === before) return content;
  console.log('   清理开发标识: ' + relPath + '  (' + before.length + ' → ' + s.length + ' 字节)');
  return Buffer.from(s, 'utf-8');
}

function zipCore(ver) {
  const stage = path.join(__dirname, 'build', 'core-v' + ver);
  wipeDir(stage);
  const stageApp = path.join(stage, 'resources', 'app');
  fs.mkdirSync(stageApp, { recursive: true });
  for (const f of APP_FILES) {
    const src = path.join(ROOT, f);
    if (!fs.existsSync(src)) die('缺少应用文件: ' + f);
    // main.js / README.md 要过一遍 sanitize，其余原样复制
    fs.writeFileSync(path.join(stageApp, f), sanitizeFile(f, fs.readFileSync(src)));
  }
  // docs 是 README 里的截图（5 张 PNG，约 340 KB）。core 包不带：
  // ① 它是增量更新包，职责只是替换代码；
  // ② 1Panel 的上传上限是 512 KB（524288 字节），带上就超了，超了会被静默丢弃。
  // 完整包（buildPortable）仍然带 docs，首次安装的用户照样能看到截图。
  fs.writeFileSync(path.join(stageApp, 'package.json'), leanPackageJson(ver), 'utf8');

  const distDir = path.join(__dirname, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const zip = path.join(distDir, `DoubaoMultiOpen-v${ver}-core.zip`);
  compress(path.join(stage, '*'), zip, '核心包');
  const kb = fs.statSync(zip).size / 1024;
  if (kb > 4096) {
    console.log('   注意: 核心包 ' + kb.toFixed(0) + ' KB, 比预期(几百 KB)大不少, 检查是否混进了无关文件');
  }
  return zip;
}

// ---------- 更新说明 ----------
function loadNotes(ver) {
  if (NOTES_ARG) return NOTES_ARG.replace(/\\n/g, '\n');
  const p = path.join(__dirname, 'notes', 'v' + ver + '.md');
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tpl = [
      '## 本次更新',
      '',
      '- ',
      '',
      '## 功能一览',
      '',
      '多账号视图池 · 在线状态检测 · 套餐识别 · 跨账号完成提醒 · 视频生成后台等待 · 自动更新'
    ].join('\n');
    fs.writeFileSync(p, tpl, 'utf8');
    console.log('\n已生成更新说明模板: ' + p);
    console.log('请编辑它 (把「- 」后面填上本次改动), 然后重新运行本脚本。\n');
    process.exit(2);
  }
  const body = fs.readFileSync(p, 'utf8').trim();
  if (!body) die('更新说明是空的: ' + p);
  return body;
}

function fullNotes(ver, body) {
  const asset = `DoubaoMultiOpen-v${ver}-windows-portable.zip`;
  const core = `DoubaoMultiOpen-v${ver}-core.zip`;

  // --full-only: 这次没传核心包, 上面那套"点检查更新只拉几百 KB"的说法就不成立了,
  // 得换成如实说明, 否则用户等着 200 KB 的更新却等来 143 MB。
  if (FULL_ONLY) {
    return [
      `> [!IMPORTANT]`,
      `> **这一版只提供完整包**（没有增量核心包）`,
      `> - 已经装了旧版的 → 打开软件点侧栏版本徽标 → 检查更新，会下载约 143 MB 的完整包，`,
      `>   装完账号不用重新登录（更新会跳过 \`userdata\` / \`downloads\`）`,
      `> - 第一次安装 → 直接下载 \`${asset}\`，解压到任意目录（**别放 Program Files**）双击即用`,
      `> - 名字很像、只有 200 KB 左右的 \`${REPO}-${ver}.zip\` 是 GitHub **自动生成的源码包**，`,
      `>   里面只有 js/html，**没有 exe，不能直接运行**`,
      `>`,
      `> 浏览器若提示「检测到病毒」，是未签名程序的信誉误报（新发布、零下载量），在下载列表点「保留」即可。`,
      '',
      `## 豆包多开管理器 v${ver}`,
      '',
      body,
      '',
      '---',
      `完整包自带 Electron 运行时，解压即用，不需要装 Node.js。`
    ].join('\n');
  }

  // --core-only: 小版本只发增量, 完整包留在之前的大版本里(省得每版都传 144 MB)。
  // 说明必须明确指路, 否则第一次装的人只看到一个几百 KB 的包, 会以为下载坏了。
  if (CORE_ONLY) {
    const fullHint = FULL_FROM
      ? `> - **第一次安装 / 想重新装一份干净的** → 这一版没带完整包，请先下载 ` +
        `[v${FULL_FROM} 完整版](https://github.com/${OWNER}/${REPO}/releases/tag/v${FULL_FROM})，` +
        `装好后点「检查更新」就升上来了`
      : `> - **第一次安装 / 想重新装一份干净的** → 这一版没带完整包，` +
        `请到 Releases 列表里找带 \`-windows-portable.zip\` 的版本下载，装好后点「检查更新」就升上来了`;
    return [
      `> [!IMPORTANT]`,
      `> **这一版只有核心包**（增量更新，几百 KB）`,
      `> - 已经装了旧版的 → 打开软件点侧栏版本徽标 → 检查更新，只会拉 \`${core}\`，`,
      `>   几秒钟装完，只替换程序文件，账号不用重新登录`,
      fullHint,
      `> - 名字很像、只有 200 KB 左右的 \`${REPO}-${ver}.zip\` 是 GitHub **自动生成的源码包**，`,
      `>   里面只有 js/html，**没有 exe，不能直接运行**`,
      `>`,
      `> 浏览器若提示「检测到病毒」，是未签名程序的信誉误报（新发布、零下载量），在下载列表点「保留」即可。`,
      '',
      `## 豆包多开管理器 v${ver}`,
      '',
      body,
      '',
      '---',
      `更新只覆盖程序文件，跳过 \`userdata\` / \`downloads\` / \`profiles\`，登录态不会丢。`
    ].join('\n');
  }

  return [
    `> [!IMPORTANT]`,
    `> **该下载哪个？**`,
    `> - 已经装了旧版的 → **不用手动下载**。打开软件点侧栏顶部版本徽标 → 检查更新，`,
    `>   它只会拉 \`${core}\`（几百 KB，只替换程序文件，账号不用重新登录）`,
    `> - 第一次安装 / 想重新装一份干净的 → 下载 \`${asset}\`（自带 Electron 运行时，解压即用）`,
    `> - 名字很像、但只有 **200 KB 左右**的 \`${REPO}-${ver}.zip\` 是 GitHub **自动生成的源码包**，`,
    `>   里面只有 js/html，**没有 exe，不能直接运行**`,
    `>`,
    `> 浏览器若提示「检测到病毒」，是未签名程序的信誉误报（新发布、零下载量），在下载列表点「保留」即可。`,
    '',
    `## 豆包多开管理器 v${ver}`,
    '',
    `**从这一版开始改成增量更新**：检查更新只下载核心包（约 200 KB），`,
    `只覆盖 \`resources\\app\` 里的程序文件，不碰 Electron 运行时、不碰 \`userdata\`。`,
    `以后每次升级都是几秒钟的事。`,
    '',
    body,
    '',
    '---',
    `完整便携版：解压到任意目录（**别放 Program Files**），双击 \`启动豆包多开.bat\`。`,
    `旧版用户（v4.0 及更早）：检查更新会先下一次完整包完成过渡，之后就走增量了。`,
    `更新只覆盖程序文件，跳过 \`userdata\` / \`downloads\` / \`profiles\`，登录态不会丢。`
  ].join('\n');
}

// ---------- 推源码 ----------
// 推送到 main 的文件清单。注意 app.ico 是二进制, 走 blob API 时用 base64。
// v4.2: 补 app.ico(之前漏了, 换图标后源码里还是旧的) 和发版脚本本身。
const SRC_FILES = ['main.js', 'preload.js', 'member-preload.js', 'image-picker-inject.js', 'index.html', 'renderer.js', 'package.json', 'package-lock.json', 'README.md', 'app.ico', '_release/release.js'];
// 本次的更新说明也要带上(文件名随版本号变, 在 pushSource 里动态补)

async function pushSource(ver, notesBody) {
  const ref = await gh('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/main`);
  if (ref.status !== 200) die('读取 main 失败: HTTP ' + ref.status);
  const baseSha = ref.json.object.sha;
  const base = await gh('GET', `/repos/${OWNER}/${REPO}/git/commits/${baseSha}`);
  say(4, 'main 当前: ' + baseSha.slice(0, 7));

  const entries = [];
  const files = SRC_FILES.slice();
  const notesRel = '_release/notes/v' + ver + '.md';
  if (fs.existsSync(path.join(ROOT, notesRel))) files.push(notesRel);
  for (const f of files) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) die('缺少源文件: ' + f);
    const content = sanitizeFile(f, fs.readFileSync(p));
    const blob = await gh('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
      content: content.toString('base64'),
      encoding: 'base64'
    });
    if (blob.status !== 201) die(`上传 blob 失败 ${f}: HTTP ${blob.status}`);
    entries.push({ path: f, mode: '100644', type: 'blob', sha: blob.json.sha });
    say(4, '  ' + f.padEnd(20) + (content.length / 1024).toFixed(1) + ' KB');
  }

  const tree = await gh('POST', `/repos/${OWNER}/${REPO}/git/trees`, { base_tree: base.json.tree.sha, tree: entries });
  if (tree.status !== 201) die('建 tree 失败: HTTP ' + tree.status + ' ' + JSON.stringify(tree.json).slice(0, 200));

  const commit = await gh('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    message: `release: v${ver}\n\n${notesBody.split('\n').slice(0, 12).join('\n')}`,
    tree: tree.json.sha,
    parents: [baseSha]
  });
  if (commit.status !== 201) die('建 commit 失败: HTTP ' + commit.status);

  const upd = await gh('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/main`, { sha: commit.json.sha, force: false });
  if (upd.status !== 200) die('更新 main 失败: HTTP ' + upd.status + ' ' + JSON.stringify(upd.json).slice(0, 200));
  say(4, 'main 已更新: ' + baseSha.slice(0, 7) + ' → ' + commit.json.sha.slice(0, 7));
  return commit.json.sha;
}

// ---------- 建 Release 并上传 ----------
async function createRelease(ver, notes, commitSha) {
  const exist = await gh('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
  if (exist.status === 200) {
    say(5, `Release ${TAG} 已存在 (id=${exist.json.id}), 将覆盖说明并替换资产`);
    const p = await gh('PATCH', `/repos/${OWNER}/${REPO}/releases/${exist.json.id}`, { name: `豆包多开管理器 v${ver}`, body: notes });
    if (p.status !== 200) die('更新 Release 说明失败: HTTP ' + p.status);
    return p.json;
  }
  const created = await gh('POST', `/repos/${OWNER}/${REPO}/releases`, {
    tag_name: TAG,
    target_commitish: commitSha || 'main',
    name: `豆包多开管理器 v${ver}`,
    body: notes,
    draft: false,
    prerelease: false
  });
  if (created.status !== 201) die('创建 Release 失败: HTTP ' + created.status + ' ' + JSON.stringify(created.json).slice(0, 300));
  say(5, `已创建 Release ${TAG} (id=${created.json.id})`);
  return created.json;
}

// 上传顺序: 核心包先传, 完整包后传。
// 旧客户端(<=v4.0)取的是"第一个 .zip", 让它拿到几百 KB 的核心包 ——
// 核心包内部是 resources\app 结构, 旧版解压后 robocopy 到安装根目录正好落对位置,
// 所以老用户升级也不用量 140 MB。新版(v4.1+)则明确按 *-core.zip 名字挑, 顺序无关。
async function uploadAssets(release, zipPaths) {
  for (const a of release.assets || []) {
    const d = await gh('DELETE', `/repos/${OWNER}/${REPO}/releases/assets/${a.id}`);
    say(6, '删除旧资产 ' + a.name + ' => ' + d.status);
  }
  const out = [];
  for (const zipPath of zipPaths) {
    const name = path.basename(zipPath);
    const buf = fs.readFileSync(zipPath);
    const up = await req('POST', 'uploads.github.com', `/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
      headers: {
        'User-Agent': 'doubao-release-script',
        Authorization: 'Bearer ' + TOKEN,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/zip',
        'Content-Length': buf.length
      },
      body: buf
    });
    if (up.status !== 201) die('上传失败: HTTP ' + up.status + ' ' + JSON.stringify(up.json).slice(0, 300));
    say(6, `上传成功: ${up.json.name}  (${(up.json.size / 1024).toFixed(0)} KB)`);
    out.push(up.json);
  }
  return out;
}

// ---------- 主流程 ----------
(async () => {
  console.log('\n===== 豆包多开管理器 发版 v' + VER + (DRY ? '  [DRY RUN]' : '') + ' =====\n');

  const cur = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  say(0, '当前版本: ' + cur + ' → 目标版本: ' + VER);
  // 允许相等: 手动把 package.json 改到目标版本后再发版是常见做法。
  // 只拦"降版本", 因为客户端只认「远端 > 本地」。
  if (cmpVer(VER, cur) < 0) {
    die(`目标版本 ${VER} 小于当前 ${cur}。客户端只认「远端 > 本地」, 版本号不能倒退。`);
  }

  const notesBody = loadNotes(VER);
  bumpVersion(VER);
  // --core-only: 不产出完整包, 省掉 144 MB 的运行时复制/压缩/上传
  const outDir = CORE_ONLY ? null : buildPortable(VER);
  const zipPath = CORE_ONLY ? null : zipPortable(outDir, VER);
  // --full-only: 只发完整包, 不产出也不上传核心包。
  // 代价是客户端「检查更新」要下 143 MB(而不是 300 KB)。
  const corePath = FULL_ONLY ? null : zipCore(VER);

  if (DRY) {
    console.log('\n[DRY RUN] 本地构建与打包已完成, 未触碰 GitHub。');
    if (outDir) console.log('  便携版目录: ' + outDir);
    if (zipPath) console.log('  完整包    : ' + zipPath);
    else console.log('  完整包    : (--core-only 已跳过)');
    if (corePath) console.log('  核心包    : ' + corePath);
    else console.log('  核心包    : (--full-only 已跳过)');
    console.log('\n确认无误后去掉 --dry-run 再跑一次即可发布。\n');
    process.exit(0);
  }

  if (!TOKEN) die('缺少 GH_TOKEN 环境变量。用法: set GH_TOKEN=ghp_xxx');
  const me = await gh('GET', '/user');
  if (me.status !== 200) die('Token 无效: HTTP ' + me.status);
  say(0, '已认证: ' + me.json.login);

  let commitSha = null;
  if (SKIP_SOURCE) {
    say(4, '跳过源码推送 (--skip-source)');
  } else {
    commitSha = await pushSource(VER, notesBody);
  }

  const release = await createRelease(VER, fullNotes(VER, notesBody), commitSha);
  // 核心包先传, 完整包后传(旧客户端只认第一个 zip)
  const assets = FULL_ONLY ? [zipPath] : CORE_ONLY ? [corePath] : [corePath, zipPath];
  await uploadAssets(release, assets);

  const latest = await gh('GET', `/repos/${OWNER}/${REPO}/releases/latest`);
  const l = latest.json || {};
  say(7, 'releases/latest => ' + l.tag_name + '  ' + (l.assets || []).map((a) => a.name).join(', '));
  if (l.tag_name !== TAG) {
    console.log('\n注意: latest 仍是 ' + l.tag_name + ', 可能因为该 Release 被标成了草稿/预发布。');
  }
  const names = (l.assets || []).map((a) => a.name);
  if (l.tag_name === TAG && !FULL_ONLY) {
    if (!names.some((n) => /-core\.zip$/i.test(n))) console.log('\n!! 警告: latest 里没有核心包, 客户端会退化成下载完整包。');
    if (names.length && !/-core\.zip$/i.test(names[0])) {
      console.log('\n!! 警告: 第一个资产不是核心包(' + names[0] + '), 旧客户端会去下完整包。');
    }
  }

  console.log('\n===== 完成 =====');
  console.log('Release 页面 : https://github.com/' + OWNER + '/' + REPO + '/releases/tag/' + TAG);
  console.log('本地压缩包   : ' + (zipPath || corePath || '(无)'));
  console.log('\n下一步: 打开旧版软件 → 点侧栏版本徽标 → 检查更新, 应能看到 v' + VER + '。');
  process.exit(0);
})().catch((e) => die(e.message));
