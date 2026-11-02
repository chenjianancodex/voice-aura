/**
 * AI 声鉴所 · Cloudflare Worker API
 * POST /api/analyze  — 接收录音(WAV base64) + 本地声学特征 → 调用阿里云百炼 qwen3.8-omni-flash → 返回结构化鉴定报告
 * GET  /api/health   — 健康检查
 *
 * 密钥: DASHSCOPE_API_KEY 通过 `wrangler secret put` 配置，绝不写进代码/前端。
 * 隐私: 音频仅用于本次分析，不落盘、不记日志。
 */

const DASHSCOPE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const PERSONA_LIBRARY = `1. 深夜电台主理人🎙️：低频治愈，听你说话像泡温泉
2. 温润白瓷音🏺：干净温软，自带柔光滤镜
3. 醇厚威士忌🥃：低音炮，故事感拉满
4. 元气气泡水🫧：高音亮、节奏快，行走的充电宝
5. 清冽薄荷音🌿：少年感清冷，一听就降温三度
6. 蜜桃乌龙音🍑：甜而不腻，撒娇指数满格
7. 御姐丝绒音🖤：慵懒高级，气场两米八
8. 明月清风音🌙：端庄疏离，新闻主播的天选之嗓
9. 山谷回声音⛰️：空灵文艺，自带混响的嗓子
10. 沉静大提琴🎻：稳重大气，压得住任何场子
11. 猫系慵懒音😼：松弛随性，睡着都能把话说好听
12. 破晓晨光音🌅：温暖明亮，声音里的正能量发电机`;

/* ================= CORS ================= */
function corsHeaders(env, request) {
  const origin = request.headers.get("Origin") || "";
  if (!origin) return {}; // 同源请求无需 CORS
  const allow = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allow.includes(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
  }
  return null; // 未授权来源
}

function json(data, extraHeaders = {}, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

/* ================= 限流（每 isolate 尽力而为） ================= */
const rateMap = new Map();
function rateOK(ip, max = 6, windowMs = 60_000) {
  const now = Date.now();
  const item = rateMap.get(ip);
  if (!item || now - item.start > windowMs) {
    rateMap.set(ip, { start: now, count: 1 });
    return true;
  }
  item.count++;
  return item.count <= max;
}

/* ================= Prompt ================= */
function buildPrompt(f = {}, scriptTitle = "", durationSec = 0) {
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const f0 = num(f.f0Hz);
  const spread = num(f.f0Spread);
  const bright = Math.round(num(f.bright01, 0.5) * 10);
  const tempo = num(f.tempo);
  const silence = Math.round(num(f.silenceRatio, 0.3) * 100);
  const dyn = Math.round(num(f.dyn01, 0.5) * 10);
  const dur = num(durationSec);

  return `你是一位资深的声音美学鉴定师，正在为用户生成一份轻松、温暖、令人惊喜的「声音气质鉴定报告」。你会收到用户朗读的一段中文录音，以及浏览器本地测得的客观声学特征。

【客观声学特征（浏览器本地测量，作为你的重要参考）】
- 平均音高：${f0} Hz（参考：男声约85-180Hz，女声约165-255Hz）
- 音高波动：约 ±${spread} 半音
- 音色明亮度：${bright}/10（0=低沉温厚，10=清亮明快）
- 语速：约 ${tempo} 音节/秒（正常朗读约4-6）
- 停顿占比：${silence}%（停顿多=从容有呼吸感，停顿少=连贯流畅）
- 响度动态：${dyn}/10（0=平稳单一，10=抑扬顿挫）
- 有效时长：${dur} 秒
- 朗读文本：《${scriptTitle}》

【你的任务】
1. 认真听录音：转写出你实际听到的词句，感受音色质感、情绪温度与表达习惯。
2. 结合客观特征，从下方「声音人格库」中选出最匹配的一款作为主人格，再选一款气质互补的作为隐藏副人格。
3. 按五维给出分数。规则：所有维度分数必须在 72-98 之间；依据特征合理拉开差距（有亮点的维度可以 90+），但绝不低于 72；整体基调是欣赏与鼓励，绝不出现贬低、外貌评价或负面对比。
4. 文案要求：夸得具体、有画面感、不油腻；quote 必须包含你在录音中实际听到的词句，让用户确信"它真的在听我说话"；避免空话套话；不使用医疗式、诊断式表述。

【声音人格库（必须从中选择）】
${PERSONA_LIBRARY}

【可选的声音场景】播客主播 / 晚安电台 / 有声书旁白 / 纪录片配音 / 广告配音 / 游戏解说 / ASMR助眠 / 新闻播报 / 婚礼司仪 / 少儿故事 / 直播宠粉主播 / 语音包制作

【输出要求】只输出一个 JSON 对象，不要 markdown 代码块，不要任何多余文字。字段：
{
  "personaName": "人格名（从人格库选）",
  "personaEmoji": "对应 emoji",
  "personaTitle": "专属称号，句式参考「被天使吻过的喉咙 No.7321」，编号任取4位数字",
  "tagline": "25字以内的人设一句话",
  "scores": {"timbre": 音色魅力分, "infect": 感染力分, "rhythm": 节奏感分, "unique": 辨识度分, "warmth": 亲和力分},
  "quote": "45字以内，引用录音原话的彩虹屁，必须包含听到的词句",
  "diagnosis": {
    "timbre": "音色印象，60字以内，结合音高与明亮度描述质感",
    "highlight": "表达高光，60字以内，指出录音中最出彩的一处并说明为什么",
    "easter": "隐藏彩蛋，50字以内，一个令人开心的发现或潜力"
  },
  "scenes": ["场景1", "场景2", "场景3"],
  "manual": ["建议1", "建议2"],
  "hiddenPersona": {"name": "隐藏副人格名（从人格库选）", "note": "一句话说明何时会解锁这款声音"}
}`;
}

/* ================= 结果解析与归一化 ================= */
function extractJSON(text) {
  let s = String(text || "").trim();
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) s = m[1].trim();
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return JSON.parse(s);
}

function str(v, d = "") {
  return typeof v === "string" && v.trim() ? v.trim() : d;
}

/* 模型偶尔会把 emoji 拼进名称字段（如"深夜电台主理人🎙️"），剥离掉 */
function stripEmoji(s) {
  return String(s)
    .replace(
      /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}]/gu,
      ""
    )
    .trim();
}

function clampScore(v) {
  return Math.max(72, Math.min(98, Math.round(Number(v) || 80)));
}

function normalizeResult(r) {
  const scores = {
    timbre: clampScore(r?.scores?.timbre),
    infect: clampScore(r?.scores?.infect),
    rhythm: clampScore(r?.scores?.rhythm),
    unique: clampScore(r?.scores?.unique),
    warmth: clampScore(r?.scores?.warmth),
  };
  const overall = Math.round(
    scores.timbre * 0.3 + scores.infect * 0.25 + scores.rhythm * 0.15 + scores.unique * 0.15 + scores.warmth * 0.15
  );
  const p = Math.max(0, (overall - 70) / 28);
  const valueYuan = Math.max(600, Math.min(26600, Math.round((600 + Math.pow(p, 2.1) * 26000) / 100) * 100));
  const beatPercent = Math.min(99.9, Math.max(30, Math.round((30 + p * 69.9) * 10) / 10));

  const arr = (v, d, n) =>
    (Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : []).slice(0, n).length
      ? (Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : []).slice(0, n)
      : d;

  return {
    personaName: str(stripEmoji(r?.personaName), "神秘混响体"),
    personaEmoji: str(r?.personaEmoji, "🎧"),
    personaTitle: str(stripEmoji(r?.personaTitle), "被天使吻过的喉咙"),
    tagline: str(r?.tagline, "你的声音，值得被更多人听见"),
    scores,
    overall,
    valueYuan,
    beatPercent,
    quote: str(r?.quote),
    diagnosis: {
      timbre: str(r?.diagnosis?.timbre),
      highlight: str(r?.diagnosis?.highlight),
      easter: str(r?.diagnosis?.easter),
    },
    scenes: arr(r?.scenes, ["播客主播", "晚安电台", "有声书旁白"], 3),
    manual: arr(r?.manual, ["朗读前先深呼吸，让气息更稳", "放慢 10% 语速，魅力值会悄悄上涨"], 3),
    hiddenPersona: {
      name: str(stripEmoji(r?.hiddenPersona?.name), "月光和声"),
      note: str(r?.hiddenPersona?.note, "换一种语速，你会解锁另一种好听"),
    },
  };
}

/* ================= DashScope 调用 ================= */
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function callDashscope(env, { audioBase64, format, features, scriptTitle, durationSec }) {
  const model = env.MODEL || "qwen3.8-omni-flash";
  const messages = [
    {
      role: "user",
      content: [
        // 注意：data 必须带 data URI 前缀，否则 DashScope 会当作 URL 解析报 400
        {
          type: "input_audio",
          input_audio: { data: `data:audio/${format || "wav"};base64,${audioBase64}`, format: format || "wav" },
        },
        { type: "text", text: buildPrompt(features, scriptTitle, durationSec) },
      ],
    },
  ];

  const makeBody = (withThinking) => {
    const body = { model, messages, temperature: 0.9 };
    if (withThinking) body.enable_thinking = false; // 控制时延，直接出结果
    return JSON.stringify(body);
  };

  const call = (bodyText) =>
    fetch(DASHSCOPE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.DASHSCOPE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: bodyText,
    });

  let res = await call(makeBody(true));
  if (res.status === 400) {
    const t = await res.text();
    if (/enable_thinking|unknown|invalid.*param/i.test(t)) {
      res = await call(makeBody(false)); // 某些版本不接受该字段，去掉重试
    } else {
      throw httpError(400, t.slice(0, 400));
    }
  }
  if (!res.ok) {
    const t = await res.text();
    throw httpError(res.status, t.slice(0, 500));
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  const raw = typeof content === "string" ? content : JSON.stringify(content);
  const parsed = extractJSON(raw);
  return normalizeResult(parsed);
}

function friendlyError(msg) {
  if (/401|InvalidApiKey|Unauthorized/i.test(msg)) return "API Key 无效或未生效，请到百炼控制台检查";
  if (/403|AccessDenied|Forbidden/i.test(msg)) return "无访问权限，可能尚未开通模型服务";
  if (/429|Throttl|RateLimited|Arrearage| quota /i.test(msg)) return "调用频率或额度受限，请稍后再试";
  if (/Arrearage|Balance/i.test(msg)) return "账户余额或免费额度不足";
  if (/ModelNotFound/i.test(msg)) return "模型不存在或未开通，请检查 MODEL 配置";
  if (/JSON/i.test(msg)) return "AI 返回格式异常，请重试一次";
  return "AI 分析服务暂时不可用，请稍后重试";
}

/* ================= 演示模式结果（未配置 Key 时） ================= */
function mockResult(features = {}) {
  const f0 = Number(features.f0Hz) || 160;
  const key = f0 < 115 ? "low" : f0 < 150 ? "deep" : f0 < 185 ? "mid" : "bright";
  const lib = {
    low: ["醇厚威士忌", "🥃"],
    deep: ["深夜电台主理人", "🎙️"],
    mid: ["温润白瓷音", "🏺"],
    bright: ["元气气泡水", "🫧"],
  };
  const hid = {
    low: ["猫系慵懒音", "笑起来的时候，你会解锁松弛的慵懒款"],
    deep: ["沉静大提琴", "认真陈述一件事时，你的声音稳得能压场"],
    mid: ["蜜桃乌龙音", "和喜欢的人说话时，甜度会悄悄上线"],
    bright: ["清冽薄荷音", "慢下来的独白时刻，藏着少年感的清冷"],
  };
  const scores = {
    timbre: 80 + (Math.round(f0) % 9),
    infect: 76 + (Math.round((features.dyn01 ?? 0.5) * 20) % 15),
    rhythm: 77 + (Math.round((features.tempo ?? 4) * 3) % 14),
    unique: 79 + (Math.round(f0) % 17),
    warmth: 78 + (Math.round((features.bright01 ?? 0.5) * 18) % 16),
  };
  return normalizeResult({
    personaName: lib[key][0],
    personaEmoji: lib[key][1],
    personaTitle: "被天使吻过的喉咙 No.2048",
    tagline: "演示模式 · 配置 DASHSCOPE_API_KEY 后获得真实鉴定",
    scores,
    quote: "演示结果：配置好 API Key 后，AI 会引用你录音里的原句来夸你。",
    diagnosis: {
      timbre: `演示模式：检测到平均音高 ${Math.round(f0)}Hz。`,
      highlight: "演示模式：配置 Key 后这里会是真实的表达高光分析。",
      easter: "演示模式：配置 Key 后这里会是你的隐藏彩蛋。",
    },
    scenes: ["播客主播", "晚安电台", "纪录片配音"],
    manual: ["这只是一个演示结果", "去 secrets/dashscope-api-key.txt 配置 Key 后体验完整版"],
    hiddenPersona: { name: hid[key][0], note: hid[key][1] },
  });
}

/* ================= 主入口 ================= */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(env, request);
    if (cors === null) return json({ ok: false, error: "Origin 不被允许" }, {}, 403);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (url.pathname === "/api/health") {
      return json(
        { ok: true, model: env.MODEL || "qwen3.8-omni-flash", mock: !env.DASHSCOPE_API_KEY },
        cors
      );
    }

    if (url.pathname === "/api/analyze" && request.method === "POST") {
      const ip = request.headers.get("CF-Connecting-IP") || "anon";
      if (!rateOK(ip)) return json({ ok: false, error: "请求太频繁，请稍后再试" }, cors, 429);

      let payload;
      try {
        payload = await request.json();
      } catch (e) {
        return json({ ok: false, error: "请求格式错误" }, cors, 400);
      }

      const { audioBase64, format, features, scriptTitle, durationSec } = payload || {};
      if (typeof audioBase64 !== "string" || audioBase64.length < 200) {
        return json({ ok: false, error: "缺少有效音频数据" }, cors, 400);
      }
      if (audioBase64.length > 8_000_000) {
        return json({ ok: false, error: "音频过大，请控制在 30 秒内" }, cors, 413);
      }

      // 未配置 Key → 演示模式
      if (!env.DASHSCOPE_API_KEY) {
        return json({ ok: true, mock: true, result: mockResult(features) }, cors);
      }

      try {
        const result = await callDashscope(env, { audioBase64, format, features, scriptTitle, durationSec });
        return json({ ok: true, result }, cors);
      } catch (e) {
        const status = Number(e?.status) || 500;
        return json(
          { ok: false, error: friendlyError(String(e?.message || e)), detail: String(e?.message || e).slice(0, 300) },
          cors,
          status >= 400 && status < 600 ? status : 500
        );
      }
    }

    // 其余路径交给静态资源（无 ASSETS 绑定时 404）
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not Found", { status: 404 });
  },
};
