// 墨小溟 · 语音物理特征提取（v0.8.0 模块二）
//
// 目标：在录音结束、送主分析之前，从「音频 + 文本」里提炼语音物理特征，
//      作为 user_voice_features 附加进主分析 Prompt，让模型结合物理特征更准地判断情绪。
// 同时提供实时音量探针（AnalyserNode 非侵入式 tap），供录音阶段墨小溟实时响应。
//
// 设计约束：所有浏览器 API 都在函数内惰性获取，模块顶层不碰 window / AudioContext，
//       保证本模块可在非浏览器环境被 import（自测、服务端均无副作用）。

/* ==================== 语气词 ==================== */

// 常见"思维混乱 / 疲惫 / 犹豫"信号词；按长度降序排列，长词优先匹配，避免"那个"误吞"就是一个"
const FILLERS = [
  '我也不知道', '就是那个', '怎么说呢', '这个', '那个', '嗯', '啊', '唉', '噢', '诶',
];

/** 语气词计数（来自转写文本）—— 多次出现累加 */
export function countFillers(transcript = '') {
  const t = String(transcript || '');
  const hits = [];
  for (const w of FILLERS) {
    let idx = 0;
    while ((idx = t.indexOf(w, idx)) !== -1) { hits.push(w); idx += w.length; }
  }
  return { count: hits.length, words: hits };
}

/** 语速：字数 / 秒（空格不计入） */
export function speechRate(transcript = '', durationMs = 0) {
  const chars = String(transcript || '').replace(/\s/g, '').length;
  const sec = Math.max(0.1, (durationMs || 0) / 1000);
  return Math.round((chars / sec) * 10) / 10;
}

/* ==================== 音频：音量峰值 + 静音停顿 ==================== */

/**
 * 从音频 blob 提取：音量峰值(0-1 归一) 与 >2s 的静音停顿次数。
 * 实现：解码 → 取单声道 → 分帧(50ms)算 RMS → 阈值判定静音帧 → 合并连续静音段 → 数 >2s 的段。
 * @returns {Promise<{volume_peak:number, pause_count:number, duration_ms:number}>}
 */
export async function analyzeAudio(blob) {
  const Ctx = (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) || null;
  const Off = (typeof window !== 'undefined' && (window.OfflineAudioContext || window.webkitOfflineAudioContext)) || null;
  if (!Ctx || !Off || !blob) return { volume_peak: 0, pause_count: 0, duration_ms: 0 };
  let ctx;
  try { ctx = new Ctx(); } catch (e) { return { volume_peak: 0, pause_count: 0, duration_ms: 0 }; }
  try {
    const buf = await blob.arrayBuffer();
    const audio = await new Promise((resolve, reject) => {
      try {
        const p = ctx.decodeAudioData(buf, resolve, reject);
        if (p && typeof p.then === 'function') p.then(resolve, reject);
      } catch (e) { reject(e); }
    });
    const data = audio.getChannelData(0);
    const sr = audio.sampleRate;
    const duration_ms = Math.round(audio.duration * 1000);

    // 峰值
    let peak = 0;
    for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > peak) peak = a; }

    // 分帧(50ms)算 RMS
    const frame = Math.max(1, Math.round(sr * 0.05));
    const rmsList = [];
    for (let i = 0; i < data.length; i += frame) {
      let s = 0, n = 0;
      for (let j = i; j < Math.min(i + frame, data.length); j++) { s += data[j] * data[j]; n++; }
      rmsList.push(Math.sqrt(s / Math.max(1, n)));
    }

    // 静音阈值：峰值的 12%（避免底噪误判），且绝对下限 0.008
    const silenceTh = Math.max(0.008, peak * 0.12);
    const frameMs = 50;
    let pause_count = 0, curSilent = 0, inSilent = false;
    for (const rms of rmsList) {
      if (rms < silenceTh) { curSilent += frameMs; inSilent = true; }
      else { if (inSilent && curSilent >= 2000) pause_count++; curSilent = 0; inSilent = false; }
    }
    if (inSilent && curSilent >= 2000) pause_count++;

    return { volume_peak: Math.round(peak * 1000) / 1000, pause_count, duration_ms };
  } catch (e) {
    return { volume_peak: 0, pause_count: 0, duration_ms: 0 };
  } finally {
    try { ctx.close(); } catch (e) { /* ignore */ }
  }
}

/**
 * 组装完整 user_voice_features（送进主分析 Prompt）。
 * 即使音频分析失败也返回结构完整的对象（volume_peak=0），不阻塞主流程。
 */
export async function extractVoiceFeatures(blob, transcript = '', durationMs = 0) {
  const audio = await analyzeAudio(blob);
  const dur = durationMs || audio.duration_ms;
  return {
    speech_rate_chars_per_sec: speechRate(transcript, dur),
    pause_count_over_2s: audio.pause_count,
    volume_peak: audio.volume_peak,
    duration_ms: dur,
    filler_count: countFillers(transcript).count,
    transcript_chars: String(transcript || '').replace(/\s/g, '').length,
  };
}

/* ==================== 实时语音物理特征探针（v1.2.0 升级） ==================== */

/**
 * 从录音 MediaStream 上挂一个**只读** AnalyserNode（不连 destination ⇒ 不影响录音链路，不调用任何模型 ⇒ 零隐私外泄）。
 * 每帧输出四项实时特征，全部用于驱动墨小溟实时动画：
 *   volume  音量 RMS 归一(0..1)        → 身体发光强度 + 呼吸急促感
 *   pitch   基频 Hz（0=静音）          → 触角抖动频率/幅度（尖锐快抖、低沉缓弱）
 *   rate    语速(0..1)                 → 身体微动
 *   tension 张力(0..1)=音量*0.55+语速*0.45 → 录音中"克制"的提前紧绷/收缩信号
 * @returns {{getLevel,getPitch,getRate,getTension,getVoicing,stop}}
 */
export function createVolumeProbe(stream) {
  const Ctx = (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) || null;
  if (!Ctx || !stream) return nullProbe();
  let ctx, analyser, freqData, timeData, src, raf = 0;
  let level = 0, pitch = 0, rate = 0, tension = 0, voicing = 0;
  let lastVoiced = false, onsets = [], lastT = 0;
  try {
    ctx = new Ctx();
    src = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.7;
    src.connect(analyser); // 只读
    freqData = new Uint8Array(analyser.frequencyBinCount);
    timeData = new Uint8Array(analyser.fftSize);
    const tick = () => {
      // ① 音量（时域 RMS）
      analyser.getByteTimeDomainData(timeData);
      let sum = 0;
      for (let i = 0; i < timeData.length; i++) { const v = (timeData[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / timeData.length);
      level = Math.min(1, rms * 3);
      // ② 基频（频域峰值，向下回溯到首个显著能量 bin ≈ 基频；比逐样本自相关便宜得多）
      analyser.getByteFrequencyData(freqData);
      const nyquist = ctx.sampleRate / 2;
      const binHz = nyquist / freqData.length;
      let maxV = 0, maxI = 0;
      for (let i = 1; i < freqData.length; i++) { if (freqData[i] > maxV) { maxV = freqData[i]; maxI = i; } }
      if (maxV < 24) { pitch = 0; } // 太安静 / 纯噪声
      else {
        let lo = maxI;
        while (lo > 1 && freqData[lo - 1] > maxV * 0.32) lo--; // 回退到基频，避开谐波峰
        const f = lo * binHz;
        pitch = (f < 60 || f > 1000) ? 0 : f;
      }
      // ③ 语速（voicing onset 计数 / 3s，归一；>4 次/s ≈ 1）
      const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
      const isVoiced = level > 0.05;
      if (isVoiced && !lastVoiced) onsets.push(now);
      lastVoiced = isVoiced;
      while (onsets.length && now - onsets[0] > 3000) onsets.shift();
      rate = Math.min(1, (onsets.length / 3) / 4);
      voicing = isVoiced ? 1 : 0;
      // ④ 张力：音量 + 语速（录音中"克制"提前切态用）
      tension = Math.min(1, level * 0.55 + rate * 0.45);
      raf = (typeof requestAnimationFrame !== 'undefined') ? requestAnimationFrame(tick) : 0;
    };
    raf = (typeof requestAnimationFrame !== 'undefined') ? requestAnimationFrame(tick) : 0;
  } catch (e) { return nullProbe(); }
  return {
    getLevel: () => level, getPitch: () => pitch, getRate: () => rate,
    getTension: () => tension, getVoicing: () => voicing,
    stop: () => {
      if (raf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(raf);
      try { src && src.disconnect(); } catch (e) { /* ignore */ }
      try { ctx && ctx.close(); } catch (e) { /* ignore */ }
    },
  };
}

/** 探针不可用 / 无 stream 时的空实现（接口一致，调用方无需判空） */
function nullProbe() {
  return { getLevel: () => 0, getPitch: () => 0, getRate: () => 0, getTension: () => 0, getVoicing: () => 0, stop: () => {} };
}
