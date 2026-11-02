/**
 * share.js — 五维雷达图绘制 + 分享卡片生成（Canvas）
 * 暴露: window.VoiceShare.drawRadar / buildShareCard / canvasToBlob
 */
window.VoiceShare = (() => {
  "use strict";

  const DIMS = [
    ["timbre", "音色魅力"],
    ["infect", "感染力"],
    ["rhythm", "节奏感"],
    ["unique", "辨识度"],
    ["warmth", "亲和力"],
  ];

  const FONT = "'PingFang SC', 'HarmonyOS Sans SC', 'Microsoft YaHei', sans-serif";

  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(x, y, w, h, r);
      return;
    }
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ---------------- 雷达图 ---------------- */
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Record<string, number>} scores 五维分数
   * @param {{progress?:number, dark?:boolean}} opts progress 0~1 动画进度
   */
  function drawRadar(canvas, scores, opts = {}) {
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const dprLike = W / 320; // 按 CSS 宽度 320 设计的坐标缩放
    const progress = opts.progress == null ? 1 : Math.max(0, Math.min(1, opts.progress));

    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.scale(dprLike, dprLike);
    const w = W / dprLike, h = H / dprLike;
    const cx = w / 2, cy = h / 2 + 6;
    const R = Math.min(w, h) * 0.335;
    const N = DIMS.length;

    const pt = (i, rr) => {
      const ang = -Math.PI / 2 + (i * 2 * Math.PI) / N;
      return [cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr];
    };

    // 网格环
    for (let ring = 5; ring >= 1; ring--) {
      ctx.beginPath();
      for (let i = 0; i <= N; i++) {
        const [x, y] = pt(i % N, (R * ring) / 5);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.strokeStyle = ring === 5 ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.08)";
      ctx.lineWidth = ring === 5 ? 1.2 : 0.8;
      ctx.stroke();
    }
    // 轴线
    for (let i = 0; i < N; i++) {
      const [x, y] = pt(i, R);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x, y);
      ctx.strokeStyle = "rgba(255,255,255,0.09)";
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }

    // 数据多边形
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const d = DIMS[i % N];
      const v = Math.max(0, Math.min(100, Number(scores[d[0]]) || 0)) / 100;
      const [x, y] = pt(i % N, R * v * progress);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
    const g = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
    g.addColorStop(0, "rgba(167,139,250,0.55)");
    g.addColorStop(1, "rgba(34,211,238,0.35)");
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = "rgba(167,139,250,0.95)";
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // 顶点 + 标签
    for (let i = 0; i < N; i++) {
      const d = DIMS[i];
      const v = Math.max(0, Math.min(100, Number(scores[d[0]]) || 0)) / 100;
      const [x, y] = pt(i, R * v * progress);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = "#e0e7ff";
      ctx.fill();

      const [lx, ly] = pt(i, R + 26);
      ctx.fillStyle = "rgba(226,232,240,0.92)";
      ctx.font = `600 12.5px ${FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(d[1], lx, ly - 7);
      ctx.fillStyle = "#8b9bc4";
      ctx.font = `11px ${FONT}`;
      ctx.fillText(String(Math.round(Number(scores[d[0]]) || 0)), lx, ly + 9);
    }
    ctx.restore();
  }

  /* 带动画的雷达绘制 */
  function animateRadar(canvas, scores, ms = 700) {
    const t0 = performance.now();
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / ms);
      drawRadar(canvas, scores, { progress: 1 - Math.pow(1 - p, 3) });
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /* ---------------- 文本换行 ---------------- */
  function wrapText(ctx, text, maxWidth, maxLines) {
    const lines = [];
    let line = "";
    for (const ch of String(text)) {
      if (ctx.measureText(line + ch).width > maxWidth && line) {
        lines.push(line);
        line = ch;
        if (lines.length >= maxLines) break;
      } else {
        line += ch;
      }
    }
    if (lines.length < maxLines && line) lines.push(line);
    if (lines.length === maxLines && (line || String(text).length > lines.join("").length)) {
      lines[maxLines - 1] = lines[maxLines - 1].replace(/.{1}$/, "") + "…";
    }
    return lines;
  }

  /* ---------------- 分享卡片 1080×1440 ---------------- */
  function buildShareCard(data, siteUrl) {
    const W = 1080, H = 1440;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");

    // 背景渐变
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, "#0a0d18");
    bg.addColorStop(0.55, "#131a36");
    bg.addColorStop(1, "#0a0d18");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // 光晕
    const glow1 = ctx.createRadialGradient(160, 140, 0, 160, 140, 560);
    glow1.addColorStop(0, "rgba(139,92,246,0.4)");
    glow1.addColorStop(1, "rgba(139,92,246,0)");
    ctx.fillStyle = glow1;
    ctx.fillRect(0, 0, W, 900);
    const glow2 = ctx.createRadialGradient(950, 620, 0, 950, 620, 520);
    glow2.addColorStop(0, "rgba(34,211,238,0.28)");
    glow2.addColorStop(1, "rgba(34,211,238,0)");
    ctx.fillStyle = glow2;
    ctx.fillRect(400, 100, W - 400, 1100);

    // 顶部小字
    ctx.fillStyle = "rgba(148,163,184,0.9)";
    ctx.font = `600 30px ${FONT}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText("🎙 AI 声鉴所", 64, 96);
    ctx.textAlign = "right";
    ctx.font = `500 24px ${FONT}`;
    ctx.fillStyle = "rgba(100,116,139,0.9)";
    ctx.fillText("VOICE AURA REPORT", W - 64, 96);

    // 玻璃面板
    roundRectPath(ctx, 56, 150, W - 112, 1080, 44);
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.13)";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.textAlign = "center";
    // emoji
    ctx.font = "110px " + FONT;
    ctx.fillText(data.personaEmoji || "🎙", W / 2, 330);

    // 人格名（渐变字）
    const nameG = ctx.createLinearGradient(200, 360, W - 200, 440);
    nameG.addColorStop(0, "#a78bfa");
    nameG.addColorStop(1, "#22d3ee");
    ctx.fillStyle = nameG;
    ctx.font = `800 92px ${FONT}`;
    ctx.fillText(data.personaName || "神秘混响体", W / 2, 452);

    // 称号
    ctx.font = `500 32px ${FONT}`;
    ctx.fillStyle = "#c7d2fe";
    ctx.fillText(data.personaTitle || "被天使吻过的喉咙", W / 2, 522);

    // tagline
    ctx.font = `400 33px ${FONT}`;
    ctx.fillStyle = "#9aa6c4";
    const tagLines = wrapText(ctx, data.tagline || "", 760, 2);
    tagLines.forEach((l, i) => ctx.fillText(l, W / 2, 578 + i * 44));

    // 雷达（离屏绘制后拷贝）
    const radar = document.createElement("canvas");
    radar.width = 560;
    radar.height = 500;
    drawRadar(radar, data.scores || {}, { progress: 1 });
    ctx.drawImage(radar, (W - 560) / 2, 640);

    // 估值
    ctx.textAlign = "center";
    ctx.font = `500 28px ${FONT}`;
    ctx.fillStyle = "rgba(148,163,184,0.95)";
    ctx.fillText("你的声音估值", W / 2, 1190);
    const valG = ctx.createLinearGradient(W / 2 - 200, 1200, W / 2 + 200, 1280);
    valG.addColorStop(0, "#fde68a");
    valG.addColorStop(1, "#f59e0b");
    ctx.fillStyle = valG;
    ctx.font = `800 78px ${FONT}`;
    ctx.fillText(`¥ ${Number(data.valueYuan || 0).toLocaleString("en-US")}`, W / 2, 1268);

    // 击败率条
    const beat = Math.max(0, Math.min(100, Number(data.beatPercent) || 0));
    ctx.fillStyle = "rgba(255,255,255,0.1)";
    roundRectPath(ctx, 150, 1310, W - 300, 16, 8);
    ctx.fill();
    const barG = ctx.createLinearGradient(150, 0, W - 150, 0);
    barG.addColorStop(0, "#a78bfa");
    barG.addColorStop(1, "#22d3ee");
    ctx.fillStyle = barG;
    roundRectPath(ctx, 150, 1310, Math.max(30, (W - 300) * (beat / 100)), 16, 8);
    ctx.fill();

    ctx.font = `600 32px ${FONT}`;
    ctx.fillStyle = "#e2e8f0";
    ctx.fillText(`击败了全国 ${beat}% 的声音`, W / 2, 1374);

    // 底部
    ctx.textAlign = "center";
    ctx.font = `500 30px ${FONT}`;
    ctx.fillStyle = "#64748b";
    ctx.fillText("30 秒，鉴定你的声音灵魂 → " + (siteUrl || "AI 声鉴所"), W / 2, H - 30);

    return canvas;
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("卡片生成失败"))), "image/png", 0.95);
    });
  }

  return { DIMS, drawRadar, animateRadar, buildShareCard, canvasToBlob };
})();
