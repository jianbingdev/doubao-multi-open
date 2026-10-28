// 会员信息采集 preload(v3.0.5)
// 作用: 在豆包页面主世界钩住 fetch/XHR, 把订阅接口的响应体存到 window.__MEMBER__,
//       主进程用 executeJavaScript 读取解析。
// 为什么不用 CDP: Electron 的 webContents.debugger 在页面未加载时 Page.enable 会挂死;
// 为什么不用主进程直接调接口: URL 带 msToken/a_bogus 签名, 外部构造不出来。
const { webFrame } = require('electron');

// 诊断日志: 确认钩子到底有没有注入成功(每个视图一行, 量很小)
let __diag = () => {};
try {
  const fs = require('fs');
  const path = require('path');
  const LOG = path.join(__dirname, 'userdata', 'member-preload.log');
  __diag = (s) => {
    try {
      fs.mkdirSync(path.join(__dirname, 'userdata'), { recursive: true });
      const st = fs.existsSync(LOG) ? fs.statSync(LOG) : null;
      if (st && st.size > 256 * 1024) fs.unlinkSync(LOG);
      fs.appendFileSync(LOG, '[' + new Date().toISOString() + '] pid=' + process.pid + ' ' + s + '\n', 'utf-8');
    } catch (e) {}
  };
} catch (e) {}

const HOOK = `(() => {
  try {
    if (window.top !== window) return;
    if (window.__MEMBER_HOOKED__) return;
    window.__MEMBER_HOOKED__ = true;
    window.__MEMBER__ = {};

    var want = function (u) { return /\\/alice\\/commerce\\/sale\\/subscription\\//.test(u || ''); };
    var save = function (url, body) {
      try {
        if (/subscription\\/entry\\/config/.test(url)) window.__MEMBER__.entry = JSON.parse(body);
        else if (/subscription\\/quota\\/summary/.test(url)) window.__MEMBER__.quota = JSON.parse(body);
      } catch (e) {}
    };

    var of = window.fetch;
    if (of) {
      window.fetch = function (input, init) {
        var url = (typeof input === 'string') ? input : ((input && input.url) || '');
        var p = of.apply(this, arguments);
        // 只对订阅接口做 clone 读取, 其它请求零开销
        if (want(url)) {
          try {
            p.then(function (r) {
              try { r.clone().text().then(function (t) { save(url, t); }).catch(function () {}); } catch (e) {}
            }).catch(function () {});
          } catch (e) {}
        }
        return p;
      };
    }

    var XO = window.XMLHttpRequest;
    if (XO && XO.prototype) {
      var oo = XO.prototype.open, os = XO.prototype.send;
      XO.prototype.open = function (m, u) { this.__memberUrl = u; return oo.apply(this, arguments); };
      XO.prototype.send = function () {
        var u = this.__memberUrl;
        if (want(u)) {
          try {
            this.addEventListener('load', function () { try { save(u, this.responseText); } catch (e) {} });
          } catch (e) {}
        }
        return os.apply(this, arguments);
      };
    }
  } catch (e) {}
})();`;

try {
  __diag('preload 开始, executeJavaScript 调用前');
  webFrame.executeJavaScript(HOOK)
    .then(() => __diag('钩子注入 OK'))
    .catch((e) => __diag('钩子注入失败: ' + (e && e.message)));
} catch (e) {
  __diag('executeJavaScript 抛错: ' + (e && e.message));
}

// ========== 图片多选复制（v4.2.2）==========
// 注入代码放在独立文件 image-picker-inject.js，改逻辑不用动这里。
// 通信链路：页面主世界 postMessage → preload(隔离世界) → ipcRenderer.invoke → 主进程
//          主进程结果 → preload → postMessage 回页面主世界
(function initImagePicker() {
  const { ipcRenderer } = require('electron');
  const fs = require('fs');
  const path = require('path');

  const file = path.join(__dirname, 'image-picker-inject.js');
  if (!fs.existsSync(file)) {
    __diag('图片选择器: 找不到 image-picker-inject.js, 跳过');
    return;
  }

  const parsed = (raw) => {
    if (typeof raw !== 'string') return raw;
    try { return JSON.parse(raw); } catch (e) { return null; }
  };

  // 页面 -> 主进程（action: copy | download）
  window.addEventListener('message', (e) => {
    const d = parsed(e.data);
    if (!d || !Array.isArray(d.urls) || !d.urls.length) return;
    const action = d.__dbPick;
    if (action !== 'copy' && action !== 'download') return;

    __diag('图片' + (action === 'copy' ? '复制' : '下载') + '请求: ' + d.urls.length + ' 张');
    ipcRenderer.invoke('images:' + action, d.urls)
      .then((r) => {
        __diag('图片' + action + '结果: ' + JSON.stringify(r && { ok: r.ok, count: r.count, error: r.error }));
        window.postMessage(JSON.stringify({
          __dbPickResult: true,
          action: action,
          ok: !!(r && r.ok),
          count: (r && r.count) || 0,
          failed: (r && r.failed) || 0,
          dir: (r && r.dir) || '',
          error: (r && r.error) || ''
        }), '*');
      })
      .catch((err) => {
        const msg = (err && err.message) ? err.message : String(err);
        __diag('图片' + action + '异常: ' + msg);
        window.postMessage(JSON.stringify({
          __dbPickResult: true, action: action, ok: false, error: msg
        }), '*');
      });
  });

  try {
    const code = fs.readFileSync(file, 'utf-8');
    webFrame.executeJavaScript(code)
      .then(() => __diag('图片选择器注入 OK'))
      .catch((e) => __diag('图片选择器注入失败: ' + (e && e.message)));
  } catch (e) {
    __diag('图片选择器读取失败: ' + (e && e.message));
  }
})();
