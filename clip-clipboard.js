'use strict';

// 构造「把多个文件 + 一段文字同时写进剪贴板」的 PowerShell 脚本。
//
// 为什么不能只用 Set-Clipboard：它一次只能写一种格式（文件 或 文字），
// 后一次调用会把前一次覆盖掉。混合复制必须借 WinForms 的 DataObject，
// 同时设置 CF_HDROP（FileDrop）和 UnicodeText；而且脚本要在 STA 线程里跑
// （主进程 spawn 时加 -STA），否则读写剪贴板会直接报线程错误。
//
// 文字不拼进命令行：走 UTF-8 临时文件，避免中文/引号/超长文本被 cmd 截断或转义坏。

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// files: 磁盘上的文件路径数组；textFile: 需要一起复制的文字文件（UTF-8），不传则只复制文件
function buildSetClipboardScript(files, textFile) {
  const list = (Array.isArray(files) ? files : []).map(psQuote).join(',');
  if (!textFile) {
    return 'Set-Clipboard -LiteralPath @(' + list + ')';
  }
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$files = @(' + list + ')',
    '$text = [System.IO.File]::ReadAllText(' + psQuote(textFile) + ', [System.Text.Encoding]::UTF8)',
    '$data = New-Object System.Windows.Forms.DataObject',
    '$data.SetData([System.Windows.Forms.DataFormats]::FileDrop, [string[]]$files)',
    '$data.SetData([System.Windows.Forms.DataFormats]::UnicodeText, $text)',
    '$ok = $false',
    'for ($i = 0; $i -lt 6 -and -not $ok; $i++) {',
    '  try { [System.Windows.Forms.Clipboard]::SetDataObject($data, $true); $ok = $true }',
    '  catch { Start-Sleep -Milliseconds 200 }',
    '}',
    "if (-not $ok) { throw '写入剪贴板失败（可能被其它程序占用）' }"
  ].join('\n');
}

module.exports = { psQuote, buildSetClipboardScript };
