/**
 * app.js — AI 声鉴所 主流程
 * 首页选文案 → 录音 → 本地声纹特征 → AI 分析 → 结果页 → 分享 / 再测一次
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  /* ================= 配置 ================= */
  const API_BASE = String((window.APP_CONFIG && window.APP_CONFIG.API_BASE) || "").replace(/\/+$/, "");
  const ANALYZE_URL = (API_BASE || "") + "/api/analyze";
  const IS_DEMO = new URLSearchParams(location.search).has("demo");
  const SITE_URL = location.origin + location.pathname;

  const MAX_REC_MS = 40 * 1000;   // 自动截断
  const MIN_REC_MS = 5 * 1000;    // 最短可用

  /* ================= 文案库 ================= */
  const SCRIPTS = [
    {
      id: "night",
      title: "晚安电台 · 治愈系",
      emoji: "🌙",
      text: "夜色像一杯温热的牛奶，缓缓漫过城市的肩膀。今天辛苦了，把没说出口的疲惫都交给晚风吧。愿你今晚被世界温柔以待，晚安，好梦。",
    },
    {
      id: "poetry",
      title: "古风独白 · 文艺系",
      emoji: "🏮",
      text: "山河远阔，人间烟火。愿你眼里藏着星辰，心里装着山海。往后的路，风起时想你，落雪时念你，一程山水一年华，各自欢喜，各自天涯。",
    },
    {
      id: "energy",
      title: "元气播报 · 活力系",
      emoji: "⚡",
      text: "叮咚！你的今日份快乐已发货：阳光充足，微风免费，好运正在派件中。请保持嘴角上扬十五度，心情舒畅，签收美好的一天！",
    },
  ];

  const TIPS = [
    "小提示：越放松，声音越好听",
    "小提示：低音区的声音自带故事感，请放心慢慢念",
    "小提示：正在分析你的音高、明亮度与节奏",
    "小提示：世界上没有两段完全相同的声音，就像指纹",
    "小提示：语速放缓 10%，感染力会悄悄上涨",
    "小提示：正在比对 12 种声音人格模型",
    "小提示：读完这段，你的声音就有专属档案啦",
  ];

  /* ================= 状态 ================= */
  const state = {
    scriptId: SCRIPTS[0].id,
    recorder: null,
    blob: null,
    preparing: false,
    result: null,
    recStart: 0,
    timerId: 0,
    autoStopId: 0,
    tipsId: 0,
    stepIds: [],
  };

  /* ================= 工具 ================= */
  function toast(msg, ms = 2400) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    el.classList.remove("hidden");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), ms);
  }

  function showScreen(id) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
    $(id).classList.add("active");
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  }

  function fmtTime(ms) {
    const s = Math.floor(ms / 1000);
    return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }

  function currentScript() {
    return SCRIPTS.find((s) => s.id === state.scriptId) || SCRIPTS[0];
  }

  /* ================= 首页：文案选择 ================= */
  function renderScripts() {
    const box = $("scriptList");
    box.innerHTML = "";
    SCRIPTS.forEach((s) => {
      const card = document.createElement("div");
      card.className = "script-card" + (s.id === state.scriptId ? " selected" : "");
      card.innerHTML = `<h4>${s.emoji} ${s.title}</h4><p>${s.text}</p>`;
      card.addEventListener("click", () => {
        state.scriptId = s.id;
        document.querySelectorAll("#scriptList .script-card").forEach((c) => c.classList.remove("selected"));
        card.classList.add("selected");
      });
      box.appendChild(card);
    });
  }

  /* ================= 波形绘制 ================= */
  const wave = $("waveCanvas");
  const wctx = wave.getContext("2d");

  function sizeWave() {
    const dpr = window.devicePixelRatio || 1;
    wave.width = wave.clientWidth * dpr;
    wave.height = wave.clientHeight * dpr;
  }
  window.addEventListener("resize", sizeWave);

  function drawWaveIdle() {
    const { width: W, height: H } = wave;
    wctx.clearRect(0, 0, W, H);
    wctx.fillStyle = "rgba(148,163,184,0.4)";
    const n = 42;
    for (let i = 0; i < n; i++) {
      const x = (W / n) * (i + 0.5);
      wctx.beginPath();
      wctx.arc(x, H / 2, Math.max(1.2, W / wave.clientWidth / 260), 0, Math.PI * 2);
      wctx.fill();
    }
  }

  function drawWaveLive(freq) {
    const { width: W, height: H } = wave;
    wctx.clearRect(0, 0, W, H);
    const n = 42;
    const step = Math.floor(freq.length / n) || 1;
    const grad = wctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, "#a78bfa");
    grad.addColorStop(1, "#22d3ee");
    wctx.fillStyle = grad;
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let j = 0; j < step; j++) v += freq[i * step + j] || 0;
      v = v / step / 255;
      const h = Math.max(3, v * H * 0.92);
      const x = (W / n) * (i + 0.5);
      const r = Math.min(W / n * 0.32, 6);
      wctx.beginPath();
      if (wctx.roundRect) wctx.roundRect(x - r / 2, (H - h) / 2, r, h, r / 2);
      else wctx.rect(x - r / 2, (H - h) / 2, r, h);
      wctx.fill();
    }
  }

  let idleAnimId = 0;
  function idleWaveLoop() {
    cancelAnimationFrame(idleAnimId);
    const t0 = performance.now();
    const loop = (t) => {
      const { width: W, height: H } = wave;
      wctx.clearRect(0, 0, W, H);
      const n = 42;
      const grad = wctx.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0, "rgba(167,139,250,0.5)");
      grad.addColorStop(1, "rgba(34,211,238,0.5)");
      wctx.fillStyle = grad;
      const amp = Math.sin((t - t0) / 900) * 0.5 + 0.5;
      for (let i = 0; i < n; i++) {
        const wave1 = Math.sin((t - t0) / 520 + i * 0.55) * 0.5 + 0.5;
        const h = 4 + wave1 * 22 * (0.4 + amp * 0.6);
        const x = (W / n) * (i + 0.5);
        const r = Math.min((W / n) * 0.32, 6);
        wctx.beginPath();
        if (wctx.roundRect) wctx.roundRect(x - r / 2, (H - h) / 2, r, h, r / 2);
        else wctx.rect(x - r / 2, (H - h) / 2, r, h);
        wctx.fill();
      }
      idleAnimId = requestAnimationFrame(loop);
    };
    idleAnimId = requestAnimationFrame(loop);
  }

  /* ================= 录音 ================= */
  function resetRecordUI() {
    $("btnRec").classList.remove("recording");
    $("btnRec").querySelector("span").textContent = "🎤";
    $("recTimer").textContent = "00:00";
    $("recHint").textContent = "点击开始录音 · 建议 15~30 秒";
    $("recActions").classList.add("hidden");
    $("btnAnalyze").disabled = false;
    state.blob = null;
    idleWaveLoop();
  }

  async function onRecClick() {
    const btn = $("btnRec");
    if (btn.classList.contains("recording")) {
      await stopRecording();
    } else {
      await startRecording();
    }
  }

  async function startRecording() {
    cancelAnimationFrame(idleAnimId);
    try {
      state.recorder = new window.VoiceAudio.Recorder();
      await state.recorder.start((level, freq) => {
        drawWaveLive(freq);
      });
    } catch (err) {
      idleWaveLoop();
      toast("无法访问麦克风：" + (err && err.message ? err.message : "请检查权限"));
      return;
    }
    $("btnRec").classList.add("recording");
    $("btnRec").querySelector("span").textContent = "⏹";
    $("recHint").textContent = "正在录音 · 点击停止";
    $("recActions").classList.add("hidden");
    state.recStart = Date.now();
    state.timerId = setInterval(() => {
      const el = Date.now() - state.recStart;
      $("recTimer").textContent = fmtTime(el);
      if (el > MAX_REC_MS - 11000 && el < MAX_REC_MS - 10000) {
        $("recHint").textContent = "快 30 秒啦，可以收了～";
      }
    }, 200);
    state.autoStopId = setTimeout(() => stopRecording(), MAX_REC_MS);
  }

  async function stopRecording() {
    clearTimeout(state.autoStopId);
    clearInterval(state.timerId);
    const btn = $("btnRec");
    if (!state.recorder) return;
    const dur = Date.now() - state.recStart;
    const blob = await state.recorder.stop();
    state.recorder = null;

    btn.classList.remove("recording");
    btn.querySelector("span").textContent = "🎤";
    $("recTimer").textContent = fmtTime(dur);
    drawWaveIdle();

    if (dur < MIN_REC_MS) {
      $("recHint").textContent = "太短啦，至少说 5 秒 · 再来一次";
      state.blob = null;
      idleWaveLoop();
      return;
    }

    state.blob = blob;
    const player = $("player");
    if (player.src) URL.revokeObjectURL(player.src);
    player.src = URL.createObjectURL(blob);
    $("recHint").textContent = `录音完成（${fmtTime(dur)}），试听一下？`;
    $("recActions").classList.remove("hidden");
  }

  /* ================= 本地演示结果 ================= */
  const PERSONAS = {
    low: ["醇厚威士忌", "🥃", "低音炮，故事感拉满"],
    deep: ["深夜电台主理人", "🎙️", "低频治愈，听你说话像泡温泉"],
    mid: ["温润白瓷音", "🏺", "干净温软，自带柔光滤镜"],
    bright: ["元气气泡水", "🫧", "高音亮、节奏快，行走的充电宝"],
  };
  const HIDDEN = {
    low: ["猫系慵懒音", "笑起来的时候，你会解锁松弛的慵懒款"],
    deep: ["沉静大提琴", "认真陈述一件事时，你的声音稳得能压场"],
    mid: ["蜜桃乌龙音", "和喜欢的人说话时，甜度会悄悄上线"],
    bright: ["清冽薄荷音", "慢下来的独白时刻，藏着少年感的清冷"],
  };

  function mockResult(payload) {
    const f = (payload && payload.features) || {};
    const f0 = f.f0Hz || 160;
    const key = f0 < 115 ? "low" : f0 < 150 ? "deep" : f0 < 185 ? "mid" : "bright";
    const [name, emoji, tagline] = PERSONAS[key];
    const [hName, hNote] = HIDDEN[key];
    const script = currentScript();

    const rnd = (a, b) => a + Math.round(Math.random() * (b - a));
    const scores = {
      timbre: rnd(78, 94),
      infect: rnd(74, 92),
      rhythm: rnd(74, 90),
      unique: rnd(76, 95),
      warmth: rnd(76, 96),
    };
    const overall = Math.round(
      scores.timbre * 0.3 + scores.infect * 0.25 + scores.rhythm * 0.15 + scores.unique * 0.15 + scores.warmth * 0.15
    );
    const p = Math.max(0, (overall - 70) / 28);
    const valueYuan = Math.max(600, Math.min(26600, Math.round((600 + Math.pow(p, 2.1) * 26000) / 100) * 100));
    const beatPercent = Math.min(99.9, Math.max(30, Math.round((30 + p * 69.9) * 10) / 10));
    const quoteSrc = script.text.slice(0, 12);

    return {
      personaName: name,
      personaEmoji: emoji,
      personaTitle: `被天使吻过的喉咙 No.${rnd(1000, 9999)}`,
      tagline,
      scores,
      overall,
      valueYuan,
      beatPercent,
      quote: `你在念「${quoteSrc}…」时的停顿处理非常老练，这段声音值得单曲循环。`,
      diagnosis: {
        timbre: `平均音高约 ${f0}Hz，明亮度 ${Math.round((f.bright01 ?? 0.5) * 10)}/10，是典型的${key === "low" || key === "deep" ? "低频温厚" : "中高频清亮"}声线，耐听且治愈。`,
        highlight: "你的语速与呼吸配合得恰到好处，句尾收音干净利落，有一种让人安心的节奏感。",
        easter: "你的声音在深夜场景里杀伤力翻倍——安静的环境会让你的音色质感再上一个台阶。",
      },
      scenes: key === "low" || key === "deep" ? ["晚安电台", "有声书旁白", "纪录片配音"] : ["播客主播", "广告配音", "少儿故事"],
      manual: ["朗读前先深呼吸两次，让气息托住声音，音色会更稳更厚。", "句尾放慢 10%，留一点余韵，听感会高级一个档位。"],
      hiddenPersona: { name: hName, note: hNote },
    };
  }

  /* ================= 分析流程 ================= */
  function runAnalyzeAnimations() {
    const steps = Array.from($("analyzeSteps").children);
    steps.forEach((li) => (li.className = ""));
    const tips = $("analyzeTip");
    clearInterval(state.tipsId);
    state.stepIds.forEach(clearTimeout);
    state.stepIds = [];

    let tipIdx = 0;
    tips.textContent = TIPS[0];
    state.tipsId = setInterval(() => {
      tipIdx = (tipIdx + 1) % TIPS.length;
      tips.textContent = TIPS[tipIdx];
    }, 2600);

    const seq = [
      [200, () => { steps[0].className = "doing"; }],
      [2600, () => { steps[0].className = "done"; steps[1].className = "doing"; }],
      [7000, () => { steps[1].className = "done"; steps[2].className = "doing"; }],
    ];
    seq.forEach(([ms, fn]) => state.stepIds.push(setTimeout(fn, ms)));
  }

  function finishAnalyzeAnimations() {
    clearInterval(state.tipsId);
    const steps = Array.from($("analyzeSteps").children);
    steps.forEach((li) => (li.className = "done"));
  }

  async function fetchAnalyze(payload) {
    if (IS_DEMO) {
      await new Promise((r) => setTimeout(r, 3200));
      return { result: mockResult(payload), mock: true };
    }
    const res = await fetch(ANALYZE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      throw new Error(json.error || `服务异常 (${res.status})`);
    }
    return json;
  }

  async function startAnalyze() {
    if (!state.blob || state.preparing) return;
    state.preparing = true;
    $("btnAnalyze").disabled = true;
    $("btnAnalyze").textContent = "声纹处理中…";

    let payload;
    try {
      payload = await window.VoiceAudio.prepareForUpload(state.blob);
    } catch (err) {
      state.preparing = false;
      $("btnAnalyze").disabled = false;
      $("btnAnalyze").textContent = "开始鉴定 ✨";
      toast("音频处理失败，请重录一次");
      return;
    }
    payload.scriptId = state.scriptId;
    payload.scriptTitle = currentScript().title;

    showScreen("screen-analyze");
    runAnalyzeAnimations();
    const t0 = Date.now();

    let data;
    try {
      data = await fetchAnalyze(payload);
    } catch (err) {
      console.warn("API 调用失败，切换演示模式：", err);
      $("mockBanner").classList.remove("hidden");
      toast("AI 后端暂未连接，已切换演示模式", 3200);
      await new Promise((r) => setTimeout(r, 2200));
      data = { result: mockResult(payload), mock: true };
    }

    // 至少让动画播 6.5 秒，避免闪烁
    const elapsed = Date.now() - t0;
    if (elapsed < 6500) await new Promise((r) => setTimeout(r, 6500 - elapsed));
    finishAnalyzeAnimations();
    await new Promise((r) => setTimeout(r, 350));

    state.preparing = false;
    $("btnAnalyze").disabled = false;
    $("btnAnalyze").textContent = "开始鉴定 ✨";
    renderResult(data.result, !!data.mock);
  }

  /* ================= 结果渲染 ================= */
  function renderResult(r, isMock) {
    state.result = r;
    if (isMock) $("mockBanner").classList.remove("hidden");

    $("rEmoji").textContent = r.personaEmoji || "🎙";
    $("rName").textContent = r.personaName || "神秘混响体";
    $("rTitle").textContent = r.personaTitle || "被天使吻过的喉咙";
    $("rTagline").textContent = r.tagline || "";
    $("rValue").textContent = Number(r.valueYuan || 0).toLocaleString("en-US");
    $("rBeat").textContent = r.beatPercent;
    $("rQuote").textContent = r.quote || "";
    $("rDiagTimbre").textContent = r.diagnosis?.timbre || "";
    $("rDiagHighlight").textContent = r.diagnosis?.highlight || "";
    $("rDiagEaster").textContent = r.diagnosis?.easter || "";
    $("rHiddenName").textContent = r.hiddenPersona?.name || "";
    $("rHiddenNote").textContent = " — " + (r.hiddenPersona?.note || "");

    const chips = $("rScenes");
    chips.innerHTML = "";
    (r.scenes || []).forEach((s) => {
      const el = document.createElement("span");
      el.textContent = s;
      chips.appendChild(el);
    });

    const manual = $("rManual");
    manual.innerHTML = "";
    (r.manual || []).forEach((m) => {
      const li = document.createElement("li");
      li.textContent = m;
      manual.appendChild(li);
    });

    showScreen("screen-result");
    // 击败率条动画
    setTimeout(() => {
      $("rBeatBar").style.width = Math.min(100, Number(r.beatPercent) || 0) + "%";
    }, 150);
    // 雷达动画
    const radar = $("radar");
    const dpr = window.devicePixelRatio || 1;
    const cssW = radar.clientWidth || 320;
    const cssH = Math.round(cssW * 0.95);
    radar.style.height = cssH + "px";
    radar.width = Math.round(cssW * dpr);
    radar.height = Math.round(cssH * dpr);
    window.VoiceShare.animateRadar(radar, r.scores || {}, 800);
  }

  /* ================= 分享 ================= */
  function buildShareText(r) {
    return (
      `我在【AI 声鉴所】测出了「${r.personaName}」声音人格！AI 估值我的声音 ¥${Number(r.valueYuan).toLocaleString("en-US")}/条，击败了全国 ${r.beatPercent}% 的声音🔊 你也来测测你的声音值多少钱 → `
    );
  }

  async function downloadBlob(blob, filename) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1200);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (e2) { /* noop */ }
      ta.remove();
      return ok;
    }
  }

  async function onShare() {
    const r = state.result;
    if (!r) return;
    try {
      const canvas = window.VoiceShare.buildShareCard(r, SITE_URL);
      const blob = await window.VoiceShare.canvasToBlob(canvas);
      const file = new File([blob], "voice-aura.png", { type: "image/png" });
      const text = buildShareText(r);

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], text, title: "AI 声鉴所 · 声音鉴定报告" });
          return;
        } catch (e) {
          if (e && e.name === "AbortError") return; // 用户取消
          // 继续走降级
        }
      }
      await downloadBlob(blob, `声音鉴定报告-${r.personaName}.png`);
      const ok = await copyText(text + SITE_URL);
      toast(ok ? "卡片已保存、文案已复制，去发布吧 ✨" : "卡片已保存 ✨", 3000);
    } catch (e) {
      toast("分享失败，请重试：" + (e && e.message ? e.message : ""));
    }
  }

  /* ================= 再测一次 ================= */
  function retest(keepScript = true) {
    state.result = null;
    state.blob = null;
    $("mockBanner").classList.add("hidden");
    resetRecordUI();
    if (keepScript) {
      const s = currentScript();
      $("scriptCard").innerHTML = `<h4>${s.emoji} ${s.title}</h4><p>${s.text}</p>`;
      showScreen("screen-record");
    } else {
      showScreen("screen-home");
    }
  }

  /* ================= 事件绑定 ================= */
  function bind() {
    $("btnStart").addEventListener("click", () => {
      const s = currentScript();
      $("scriptCard").innerHTML = `<h4>${s.emoji} ${s.title}</h4><p>${s.text}</p>`;
      resetRecordUI();
      showScreen("screen-record");
    });
    $("btnRec").addEventListener("click", onRecClick);
    $("btnRedo").addEventListener("click", () => {
      state.blob = null;
      $("recActions").classList.add("hidden");
      $("recTimer").textContent = "00:00";
      $("recHint").textContent = "点击开始录音 · 建议 15~30 秒";
      $("btnAnalyze").disabled = false;
    });
    $("btnAnalyze").addEventListener("click", startAnalyze);
    $("btnShare").addEventListener("click", onShare);
    $("btnRetest").addEventListener("click", () => retest(true));
    $("btnChangeScript").addEventListener("click", (e) => {
      e.preventDefault();
      retest(false);
    });
  }

  /* ================= 启动 ================= */
  function init() {
    renderScripts();
    sizeWave();
    drawWaveIdle();
    idleWaveLoop();
    bind();
    if (IS_DEMO) $("mockBanner").classList.remove("hidden");
    window.__testRenderResult = renderResult; // 测试钩子：浏览器控制台直接渲染结果页
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
