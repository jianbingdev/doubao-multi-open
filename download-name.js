'use strict';

// 下载文件自动命名。纯 Node，不依赖 electron，可以直接在命令行里跑测试。
//
// 边界（用户 2026-11-10 明确要求）：
//   - 只负责「文件名」，不写 CSV 清单、不采集提示词、不注入页面、不建子文件夹
//   - 设置开关关闭时，调用方走原始分支，这里一行都不会被执行
//   - 名字那一段取的是**下载的原文件名**（例：奶白色钢制衣柜视频制作方案.mp4），不读页面
//
// 从 2026-11-09 那版 download-manifest.js 里只摘出命名这一块，
// CSV / 提示词 / 来源 / 页面注入那套一概不要。

const path = require('path');

// ---------- 格式模板 ----------
// {文件名} 含扩展名，程序不会重复补。占位符见 PLACEHOLDERS。
// 这份是单一数据源：设置弹窗的下拉通过 IPC download:formats 取，HTML 里不重复写 key。
const PRESET_TEMPLATES = {
  account_date_name:     '{账号}_{日期}_{文件名}',
  account_dot_name:      '{账号}-{点日期}-{文件名}',
  date_account_name:     '{点日期}-{账号}-{文件名}',
  account_name:          '{账号}-{文件名}',
  account_datetime_name: '{账号}-{点日期}-{时间}-{文件名}'
};

const DEFAULT_FORMAT = 'account_date_name';       // 保持 11-10 恢复时的老行为
const DEFAULT_CUSTOM = '{账号}-{点日期}-{文件名}';

const FORMAT_OPTIONS = [
  { key: 'account_date_name',     label: '账号_2026-11-10_文件名（默认）',        tpl: PRESET_TEMPLATES.account_date_name },
  { key: 'account_dot_name',      label: '账号-2026.11.10-文件名',                tpl: PRESET_TEMPLATES.account_dot_name },
  { key: 'date_account_name',     label: '2026.11.10-账号-文件名',                tpl: PRESET_TEMPLATES.date_account_name },
  { key: 'account_name',          label: '账号-文件名（不带日期）',                 tpl: PRESET_TEMPLATES.account_name },
  { key: 'account_datetime_name', label: '账号-2026.11.10-10.11.13-文件名（带时分秒）', tpl: PRESET_TEMPLATES.account_datetime_name },
  { key: 'custom',                label: '自定义…',                               tpl: '' }
];

const PLACEHOLDERS = ['{账号}', '{日期}', '{点日期}', '{时间}', '{文件名}'];

// 账号名可能带空格、emoji、Windows 非法字符，直接拼进文件名会失败
function safeSegment(s, maxLen) {
  let t = String(s === null || s === undefined ? '' : s)
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/[\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  t = t.replace(/^[.\s]+/, '').trim();       // 不能以点/空白开头（.. .. etc 也要清干净）
  if (!t) t = '未命名';
  return (t.slice(0, maxLen || 20).trim() || '未命名');
}

function dateTag(d, sep) {
  const s = sep || '-';
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + s + p(d.getMonth() + 1) + s + p(d.getDate());
}

function timeTag(d, sep) {
  const s = sep || '.';
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + s + p(d.getMinutes()) + s + p(d.getSeconds());
}

// 手动按分隔符切最后一段。不能用 path.basename：
// Windows 下 'a:b.mp4' 里的 'a:' 会被当成盘符，basename 直接返回 'b.mp4'，吃掉一段名字。
function splitOriginal(originalName) {
  const raw = String(originalName === null || originalName === undefined || originalName === ''
    ? 'file' : originalName);
  const parts = raw.split(/[\\/]/);
  let base = (parts[parts.length - 1] || '').replace(/[\\/:*?"<>|\r\n]/g, '_');
  if (!base || base === '.' || base === '..') base = 'file';
  const ext = path.extname(base);
  return { base, ext };
}

// 只做字符串计算，不碰磁盘。
// formatKey 不认识、custom 为空、模板算出来是空串，统统退回默认格式，不会抛出坏文件名。
function formatFileName(originalName, accountLabel, now, formatKey, customTpl) {
  const d = now || new Date();
  const key = String(formatKey || DEFAULT_FORMAT);
  let tpl = (key === 'custom') ? String(customTpl || '').trim() : PRESET_TEMPLATES[key];
  if (!tpl) tpl = PRESET_TEMPLATES[DEFAULT_FORMAT];

  const { base } = splitOriginal(originalName);
  const acct = safeSegment(accountLabel || '未分配账号', 20)
    .replace(/[\\/:*?"<>|\r\n]/g, '_');
  const map = {
    '{账号}': acct,
    '{日期}': dateTag(d, '-'),
    '{点日期}': dateTag(d, '.'),
    '{时间}': timeTag(d, '.'),
    '{文件名}': base
  };

  let out = tpl;
  for (const k of Object.keys(map)) out = out.split(k).join(map[k]);
  // 自定义模板里可能带路径分隔符或非法字符，整串再过一遍
  out = out.replace(/[\\/:*?"<>|\r\n]/g, '_').replace(/^\.+/, '').trim();
  if (!out) out = PRESET_TEMPLATES[DEFAULT_FORMAT]
    .split('{账号}').join(acct)
    .split('{日期}').join(map['{日期}'])
    .split('{文件名}').join(base);

  // Windows 单文件名上限 255，留余量给 (1)(2) 后缀；截 stem 保留扩展名
  if (out.length > 200) {
    const ext = path.extname(out);
    const stem = ext ? out.slice(0, -ext.length) : out;
    out = stem.slice(0, 200 - ext.length) + ext;
  }
  return out;
}

// 兼容入口：不传格式时就是 11-10 恢复的那版 账号_日期_原文件名
function buildFileName(originalName, accountLabel, now) {
  return formatFileName(originalName, accountLabel, now, DEFAULT_FORMAT, '');
}

module.exports = {
  PRESET_TEMPLATES, FORMAT_OPTIONS, PLACEHOLDERS, DEFAULT_FORMAT, DEFAULT_CUSTOM,
  safeSegment, dateTag, timeTag, formatFileName, buildFileName
};
