'use strict';

// 豆包页面尾部文案判定（后台任务 / 成功 / 失败）。
// 这段逻辑会以源码形式嵌进注入脚本 GEN_STATE_SCRIPT（.toString()），
// 主进程和测试跑的是同一份实现，避免两边判据走样。
//
// 关键：页面上历史消息也在 tail 里，不能只看"有没有失败两个字"，
// 要按出现位置判断"最近一条状态"。实测失败文案：
//   "…本次生成将消耗每日免费额度。 视频生成失败，生成额度未扣除。"
// 失败文案出现在任务提交文案之后，才算本轮失败；
// 反向（旧失败在前、新任务提交在后）不能误判。

function classifyGenTail(tail) {
  const s = String(tail == null ? '' : tail);
  const lastAt = (re) => {
    let m;
    let at = -1;
    re.lastIndex = 0;
    while ((m = re.exec(s))) at = m.index;
    return at;
  };

  const pendingIdx = lastAt(
    /生成好后[^。]{0,12}会主动发送|本次生成将消耗|预计等待\s*\d+\s*分钟|大约需要\s*\d+[-~]?\d*\s*分钟/g
  );
  const doneIdx = lastAt(/视频生成好了|生成好了|生成完成|已生成好|视频已生成/g);
  // 失败文案收得比较紧：必须带标点 / 额度 / 重试，避免把回复正文里的
  // "视频生成失败的原因是什么"之类当成任务失败。
  const failIdx = lastAt(
    /视频生成失败[，,。]|生成失败[，,][^。\n]{0,12}(?:重试|额度|稍后|再试)/g
  );

  return {
    taskPending: pendingIdx >= 0,
    // 成功文案要排在「任务已提交」之后，避免上一轮的成功文案把本轮提前判成完成
    taskDone: doneIdx >= 0 && (pendingIdx < 0 || doneIdx > pendingIdx) && doneIdx > failIdx,
    taskFailed: failIdx >= 0 && failIdx > Math.max(pendingIdx, doneIdx)
  };
}

function buildStateScript() {
  return `(() => {
  try {
    // 判据只认停止生成按钮；message_loading 在"加载历史消息"时也会出现，不能算生成。
    var b = !!document.querySelector('[data-testid="chat_input_local_break_button"]');
    var txt = document.body ? document.body.innerText : '';
    var tail = txt.slice(-600);

    // v3.0.10 实测后台任务的两句关键文案：
    //   已提交："…本次生成将消耗每日免费额度。"
    //   完成：  "你的视频生成好了。"
    //   失败：  "视频生成失败，生成额度未扣除。"（2026-11-16 生产实测）
    // 页面里始终没有 <video> 元素，不能拿 video 数量当产物判据。
    var classify = ${classifyGenTail.toString()};
    var st = classify(tail);

    var p = location.pathname || '';
    var inChat = /^\\/chat\\/[^\\/]+/.test(p);
    return {
      busy: b,
      len: txt.length,
      inChat: inChat,
      taskPending: st.taskPending,
      taskDone: st.taskDone,
      taskFailed: st.taskFailed,
      tail: tail.slice(-160)
    };
  } catch (e) { return null; }
})()`;
}

module.exports = { classifyGenTail, buildStateScript };
