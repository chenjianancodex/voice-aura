/**
 * audio.js — 录音、本地声学特征提取、WAV 编码（全部在浏览器本地完成）
 * 暴露: window.VoiceAudio.Recorder / prepareForUpload
 */
window.VoiceAudio = (() => {
  "use strict";

  const TARGET_RATE = 16000;     // 上传用重采样率
  const MAX_UPLOAD_SEC = 30;     // 上传音频最长秒数

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const r2 = (v) => Math.round(v * 100) / 100;

  /* ---------------- 媒体格式选择 ---------------- */
  function pickMime() {
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
      "audio/ogg;codecs=opus",
      "",
    ];
    if (!window.MediaRecorder) return "";
    for (const m of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(m)) return m;
      } catch (e) { /* ignore */ }
    }
    return "";
  }

  /* ---------------- 录音器 ---------------- */
  class Recorder {
    /**
     * 开始录音
     * @param {(level:number, freqData:Uint8Array)=>void} onLevel 每帧回调（level 0~1）
     */
    async start(onLevel) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("当前浏览器不支持录音（需要 HTTPS 或 localhost 环境）");
      }
      // 关闭降噪/增益，保留真实音色
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });

      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.75;
      src.connect(this.analyser);
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);

      this.mime = pickMime();
      this.rec = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime } : undefined);
      this.chunks = [];
      this.rec.ondataavailable = (e) => {
        if (e.data && e.data.size) this.chunks.push(e.data);
      };
      this.rec.start(250);
      this.stopped = false;

      const loop = () => {
        if (this.stopped) return;
        this.analyser.getByteFrequencyData(this.freqData);
        let sum = 0;
        for (let i = 0; i < this.freqData.length; i++) sum += this.freqData[i] * this.freqData[i];
        if (onLevel) onLevel(Math.sqrt(sum / this.freqData.length) / 255, this.freqData);
        this._raf = requestAnimationFrame(loop);
      };
      loop();
    }

    /** 停止并返回 Blob */
    async stop() {
      if (!this.rec) return new Blob();
      this.stopped = true;
      if (this._raf) cancelAnimationFrame(this._raf);
      const done = new Promise((res) => { this.rec.onstop = res; });
      if (this.rec.state !== "inactive") this.rec.stop();
      await done;
      const blob = new Blob(this.chunks, { type: this.rec.mimeType || this.mime || "audio/webm" });
      this.cleanup();
      return blob;
    }

    cleanup() {
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      if (this.ctx && this.ctx.state !== "closed") this.ctx.close().catch(() => {});
      this.stream = this.ctx = this.rec = null;
    }
  }

  /* ---------------- DSP 工具 ---------------- */
  function toMono(buf) {
    const n = buf.length;
    const out = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) out[i] += d[i] / buf.numberOfChannels;
    }
    return out;
  }

  function resampleLinear(data, fromRate, toRate) {
    if (Math.abs(fromRate - toRate) < 1) return data;
    const ratio = fromRate / toRate;
    const outLen = Math.floor(data.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const p = i * ratio;
      const i0 = Math.floor(p);
      const i1 = Math.min(i0 + 1, data.length - 1);
      const f = p - i0;
      out[i] = data[i0] * (1 - f) + data[i1] * f;
    }
    return out;
  }

  function encodeWav(samples, rate) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buf);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); ws(8, "WAVE");
    ws(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    ws(36, "data"); v.setUint32(40, samples.length * 2, true);
    let o = 44;
    for (let i = 0; i < samples.length; i++, o += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buf], { type: "audio/wav" });
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        const s = String(fr.result || "");
        resolve(s.includes(",") ? s.slice(s.indexOf(",") + 1) : s);
      };
      fr.onerror = () => reject(new Error("音频编码失败"));
      fr.readAsDataURL(blob);
    });
  }

  /* ---------------- 特征提取 ---------------- */
  function median(sorted) {
    const n = sorted.length;
    if (!n) return 0;
    return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  }
  function std(arr) {
    const n = arr.length;
    if (n < 2) return 0;
    const m = arr.reduce((a, b) => a + b, 0) / n;
    return Math.sqrt(arr.reduce((a, b) => a + (b - m) * (b - m), 0) / (n - 1));
  }

  /** 一帧的自相关基频检测（8kHz 信号） */
  function autocorrF0(x, start, len, rate) {
    const minLag = Math.floor(rate / 400); // 400Hz
    const maxLag = Math.floor(rate / 60);  // 60Hz
    let e0 = 0;
    for (let i = 0; i < len; i++) e0 += x[start + i] * x[start + i];
    if (e0 < 1e-5) return null;
    let best = 0, bestLag = -1;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i + lag < len; i++) sum += x[start + i] * x[start + i + lag];
      const norm = sum / e0;
      if (norm > best) { best = norm; bestLag = lag; }
    }
    if (bestLag < 0 || best < 0.35) return null;
    return rate / bestLag;
  }

  /**
   * 提取客观声学特征
   * @returns {{durationSec:number, f0Hz:number, f0Spread:number, bright01:number,
   *            tempo:number, silenceRatio:number, dyn01:number, levelDb:number}}
   */
  function extractFeatures(samples, rate) {
    const durationSec = samples.length / rate;
    const frameLen = Math.max(256, Math.round(0.032 * rate));
    const hop = Math.floor(frameLen / 2);

    // 分帧 RMS
    const frames = [];
    for (let s = 0; s + frameLen <= samples.length; s += hop) {
      let sum = 0;
      for (let i = s; i < s + frameLen; i++) sum += samples[i] * samples[i];
      frames.push({ s, rms: Math.sqrt(sum / frameLen) });
    }
    if (!frames.length) {
      return { durationSec: r2(durationSec), f0Hz: 0, f0Spread: 0, bright01: 0.5, tempo: 0, silenceRatio: 1, dyn01: 0, levelDb: -60 };
    }

    const maxRms = Math.max(...frames.map((f) => f.rms));
    const thr = Math.max(0.012, maxRms * 0.12);
    const speech = frames.filter((f) => f.rms > thr);
    const silenceRatio = clamp01(1 - speech.length / frames.length);

    // 明亮度: 语音帧平均过零率
    let zcrSum = 0, zcrN = 0;
    for (const f of speech) {
      let z = 0;
      for (let i = f.s + 1; i < f.s + frameLen; i++) {
        if ((samples[i] >= 0) !== (samples[i - 1] >= 0)) z++;
      }
      zcrSum += z / frameLen;
      zcrN++;
    }
    const zcr = zcrN ? zcrSum / zcrN : 0;
    const bright01 = r2(clamp01((zcr - 0.02) / 0.13));

    // 音高: 8kHz 下采样 + 逐帧自相关
    const sr8 = 8000;
    const x8 = resampleLinear(samples, rate, sr8);
    const pLen = 512;
    const f0s = [];
    for (let s = 0; s + pLen <= x8.length; s += pLen) {
      let e = 0;
      for (let i = s; i < s + pLen; i++) e += x8[i] * x8[i];
      if (Math.sqrt(e / pLen) < 0.02) continue;
      const f0 = autocorrF0(x8, s, pLen, sr8);
      if (f0 && f0 >= 60 && f0 <= 400) f0s.push(f0);
    }
    f0s.sort((a, b) => a - b);
    const f0Hz = f0s.length ? median(f0s) : 0;
    let f0Spread = 0;
    if (f0s.length > 4 && f0Hz > 0) {
      const st = f0s.map((v) => 12 * Math.log2(Math.max(50, v) / f0Hz));
      f0Spread = Math.round(std(st) * 10) / 10;
    }

    // 语速: 平滑能量包络峰值计数
    const env = frames.map((f, i) => {
      const a = frames[Math.max(0, i - 1)].rms;
      const b = frames[Math.min(frames.length - 1, i + 1)].rms;
      return (a + f.rms * 2 + b) / 4;
    });
    const meanSpeech = speech.length
      ? speech.reduce((a, f) => a + f.rms, 0) / speech.length
      : 0;
    const minGap = Math.ceil(0.12 / (hop / rate)); // 峰值最小间隔 120ms
    let peaks = 0, lastPeak = -1e9;
    for (let i = 1; i < env.length - 1; i++) {
      if (env[i] > env[i - 1] && env[i] >= env[i + 1] && env[i] > meanSpeech * 0.45 && i - lastPeak >= minGap) {
        peaks++;
        lastPeak = i;
      }
    }
    const tempo = Math.round(Math.max(0, Math.min(9, peaks / Math.max(1, durationSec))) * 10) / 10;

    // 响度动态: 语音段 RMS p90/p10
    const rs = speech.map((f) => f.rms).sort((a, b) => a - b);
    const p10 = rs.length ? rs[Math.floor(rs.length * 0.1)] : 0;
    const p90 = rs.length ? rs[Math.floor(rs.length * 0.9)] : 0;
    const dynDb = p10 > 1e-5 ? 20 * Math.log10(p90 / p10) : 0;
    const dyn01 = r2(clamp01(dynDb / 30));

    const meanLevel = speech.length
      ? speech.reduce((a, f) => a + f.rms, 0) / speech.length
      : 0;
    const levelDb = Math.max(-60, Math.min(0, 20 * Math.log10(Math.max(1e-5, meanLevel))));

    return {
      durationSec: r2(durationSec),
      f0Hz: Math.round(f0Hz),
      f0Spread,
      bright01,
      tempo,
      silenceRatio: r2(silenceRatio),
      dyn01,
      levelDb: Math.round(levelDb),
    };
  }

  /* ---------------- 上传准备 ---------------- */
  /**
   * 录音 Blob → { wavBase64, format, durationSec, features }
   */
  async function prepareForUpload(blob) {
    const arr = await blob.arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    let buf;
    try {
      buf = await ctx.decodeAudioData(arr);
    } finally {
      ctx.close().catch(() => {});
    }
    const mono = toMono(buf);
    const rate = buf.sampleRate;

    // 截断到最长 30s
    const maxN = Math.min(mono.length, Math.floor(MAX_UPLOAD_SEC * rate));
    const trimmed = mono.subarray(0, maxN);

    const features = extractFeatures(trimmed, rate);
    const down = resampleLinear(trimmed, rate, TARGET_RATE);
    const wav = encodeWav(down, TARGET_RATE);
    const wavBase64 = await blobToBase64(wav);

    return {
      wavBase64,
      format: "wav",
      durationSec: features.durationSec,
      features,
    };
  }

  return { Recorder, prepareForUpload };
})();
