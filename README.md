# 豆包多开管理器

![version](https://img.shields.io/badge/version-3.0.16-blue) ![platform](https://img.shields.io/badge/platform-Windows-lightgrey) ![license](https://img.shields.io/badge/license-MIT-green)

一个本地豆包（Doubao）多账号管理器：单窗口内嵌多个**常驻豆包页面**，
切号即显隐切换 —— **毫秒级、不丢状态、所有账号同时在线**。

> 本项目基于 [niulaizhineng/doubao-multi-open](https://github.com/niulaizhineng/doubao-multi-open)（MIT）**修改优化**，
> 原作者：[牛来智能](https://github.com/niulaizhineng)。原版版权声明已按 MIT 要求保留在 [LICENSE](LICENSE) 中。

![应用截图](docs/screenshot.png)

## 下载即用（推荐普通用户）

不想装环境，直接去 [Releases](../../releases) 下载 `豆包多开管理器-vX.X.X.zip`，
解压到任意目录（**别放 `C:\Program Files`**），双击 `豆包多开管理器.exe` 就能用：

- **无需安装 Node.js**，无需联网装依赖，运行时已内置
- 数据全部在程序目录下（`userdata\`），整个文件夹可以随意搬迁
- 约 132 MB —— 体积基本都来自 Electron 运行时（Chromium + Node），代码本身只有 60 KB
- 换电脑后需重新扫码登录：登录态用本机密钥加密，拷过去解不开（账号列表、套餐信息会保留）

只想跑，就到这里。想改代码或自己构建，继续往下看。

## 原理

- Electron 单窗口 + `WebContentsView` 常驻视图池
- 每个账号一个 `persist:<id>` 分区会话 → Cookie / 存储完全隔离
- 不修改豆包官方任何文件；页面加载自 `www.doubao.com`，官方更新自动兼容

## 功能

- **一键切号**：侧栏点击 / 托盘菜单 / `Ctrl+1~9`
- **添加账号**：点 ＋ 后直接在右侧页面扫码，登录成功自动转正
- **自动识别昵称**：登录后自动重放官方用户信息接口读取昵称并改名（只改默认名，不覆盖手动修改）
- **双击就地改名**：双击侧栏名称原地编辑，Enter 保存 / Esc 取消
- **在线状态检测**：以官方用户接口为准判定登录态（未登录访客即使持有完整 session cookie 也不会被误判为在线）；侧栏「⟳ 检测账号状态」可全量刷新，点账号旁徽标可单独检测
- **套餐识别**：账号名旁显示套餐小字，鼠标悬停查看到期时间
- **跨账号完成提醒**：A 账号发指令后切到 B，A 跑完会在侧栏亮「新回复」并弹提示
- **视频生成后台等待**：视频任务转入后台，切走也持续跟进，真正生成完成才提示
- **自动更新**：侧栏顶部的版本号（或「帮助 → 检查更新」）点一下就能检测新版本，
  有新版本直接下载，下完点「重启并更新」即自动替换并重启，**账号数据不会被覆盖**
- **稳定性**：渲染进程崩溃自动重建视图；页面加载失败自动重试；单实例锁；记住窗口位置；内置 GPU 沙箱兼容参数
- **下载处理**：生成的视频/图片自动保存到 `downloads\<账号ID>\` 并弹提示
- **托盘常驻**：关闭窗口默认最小化到托盘

## 快捷键

| 快捷键 | 功能 |
|---|---|
| `Ctrl+N` | 添加账号 |
| `Ctrl+1~9` | 切换到第 N 个账号 |
| `Ctrl+R` | 重新加载当前页 |
| `Ctrl+= / Ctrl+- / Ctrl+0` | 页面放大 / 缩小 / 实际大小 |
| `Ctrl+Shift+Q` | 退出程序 |

## 目录结构

```
doubao-multi-open\
├─ main.js              主进程(视图池/会话隔离/托盘/IPC/状态检测)
├─ preload.js           IPC 安全桥(主窗口)
├─ member-preload.js    注入豆包页面的桥(读取昵称/套餐等官方接口)
├─ index.html           侧栏界面
├─ renderer.js          界面逻辑
├─ package.json         依赖声明(electron)
├─ .npmrc               国内镜像配置
├─ 启动豆包多开.bat      Windows 启动入口(缺依赖时自动安装)
├─ 启动豆包多开.ps1      PowerShell 启动入口
├─ app.ico              应用图标
├─ .gitignore           隐私数据与依赖忽略清单
├─ docs\screenshot.png  应用截图
└─ README.md            本文件

运行时自动生成(已被 .gitignore 排除):
├─ userdata\            各账号分区会话数据(含登录态,勿外传)
├─ downloads\           生成的视频图片落盘处
└─ app-run.log          运行日志
```

## 从源码运行（开发者）

> 只想用的话不需要看这一节，直接下载上面的便携版即可。

1. 安装 [Node.js](https://nodejs.org) ≥ 18
2. 双击 `启动豆包多开.bat`（首次会自动 `npm install`，已配置国内镜像）
3. 或手动: `npm install && npm start`

> 依赖安装在本目录 `node_modules\`，npm 下载缓存可通过环境变量
> `npm_config_cache` / `ELECTRON_CACHE` 自定义位置，实现 C 盘零占用。

### 首次运行报 `Windows cannot find ...electron.exe`

`npm install` 在 `node_modules\electron` 目录已存在时会报 `up to date`，
并跳过该包的 postinstall，导致 `dist\` 为空、`electron.exe` 永远补不上。

启动脚本已内置兜底：检测到 `dist\electron.exe` 缺失时会自动补跑 `node install.js`。
若仍然失败，手动执行：

```bash
cd node_modules/electron && node install.js
```

## 自动更新

侧栏顶部的版本号徽标就是更新入口（菜单「帮助 → 检查更新」同样可以打开）。
点开后会做三件事：比对版本 → 下载安装包 → 重启并就地替换。

- **默认更新源**：本仓库的 GitHub Releases（`releases/latest`），版本号取 Release 的 tag，
  安装包取该 Release 下第一个 `.zip` 资产，更新说明取 Release 正文
- **自定义更新源**：弹窗左下「更新源」里可以填自己的地址（留空即恢复默认），格式：

```json
{
  "version": "3.0.16",
  "notes": "更新说明，换行用 \\n",
  "url": "https://你的域名/豆包多开管理器-v3.0.16.zip",
  "size": 138412345,
  "sha256": "可选，填了会校验，不匹配就中止"
}
```

- **替换规则**：只覆盖程序文件，`userdata\`（登录态）、`downloads\`、`profiles\`、`node_modules\` 一律跳过，
  所以更新不会掉登录、不会丢生成的视频图片
- **更新包可以是整个便携目录**（含 exe 与 `resources\`），也可以是纯代码包（只有 js/html）；
  压缩包里套一层文件夹也能识别
- **失败排查**：看安装目录下的 `update.log`，脚本每一步都有记录

### 发布新版本（维护者）

1. 改版本号，共 4 处：`package.json`、`package-lock.json`（文件头和 `packages[""]` 各一处）、
   `README.md` 顶部的 badge。代码里的 `关于` 对话框已改为读 `package.json`，不用再手改
2. 打出便携版 zip（保持 `豆包多开管理器.exe` 与 `resources\` 同级）
3. 在 GitHub 建 Release，**tag 必须与 `package.json` 版本一致**（如 `v3.0.16` 或 `3.0.16`）
4. 把 zip 作为资产上传。客户端下次检查更新即可看到新版本

> 版本号比较只看前三段数字，`v` 前缀会被忽略；只有远端版本**大于**当前版本才会提示。

## 风险须知

工具使用 Chromium 分区会话隔离各账号，行为等同「多人共用一台电脑的浏览器」，
正常使用风险很低；但**没有任何方案能保证官方不可检测多账号**。
请勿用于批量注册、自动化群控等违反官方协议的行为。

## 致谢与许可

本项目的**架构与主体代码来自** [niulaizhineng/doubao-multi-open](https://github.com/niulaizhineng/doubao-multi-open)，
原作者 **牛来智能**，MIT 许可。在此基础上的修改优化包括：

- 新增套餐识别、跨账号完成提醒、视频生成后台等待
- 新增自动更新（检查版本 → 下载 → 重启就地替换，保留账号数据）
- 重做在线状态检测（强凭证 Cookie + 手动全量刷新 + 单账号检测）
- 移除原版的赞赏/收款码模块
- 内置 GPU 沙箱兼容参数，提供便携版打包

原版版权声明按 MIT 许可要求原样保留，见 [LICENSE](LICENSE)：

```
Copyright (c) 2026 牛来智能 (niulaizhineng)
```

本项目同样以 [MIT](LICENSE) 许可发布。
