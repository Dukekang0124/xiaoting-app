// 墨小溟 · 原生语音识别（v1.1.2 真机修复）
//
// 【为什么要有这一层】
// APK 里网页跑在 WebView（https://localhost）上。Web 的 `MediaRecorder` + `decodeAudioData`
// 在 Android 各厂商 WebView 上支持很不统一：有的录出来是 0 字节，有的 webm/opus 解不出来；
// 即便录成功了，还要有一个**可达的 ASR 服务端**才能转成文字（而服务端需要百度密钥）。
// 于是真机上就出现了「按住说 → 一句没听清」这个阻断性问题。
//
// 【怎么解决】在原生容器里改用**设备自带的语音识别**（Android SpeechRecognizer）：
//   · 不需要服务端、不需要密钥，录音 + 转写都在设备上完成；
//   · 插件自己声明并申请 RECORD_AUDIO，授权流程是原生弹窗，比 WebView 的 getUserMedia 稳；
//   · 拿不到（设备没装识别服务 / 用户拒权）→ 交回 asr.js 的降级链（云端 ASR → 打字）。
//
// 【设计纪律】这一层**永不抛错**：任何异常都转成 `{ok:false, code}`，由 app.js 决定怎么说人话。

import { isNativeApp } from './config.js';

const PLUGIN = 'SpeechRecognition';   // @capacitor-community/speech-recognition 注册名

function plugin() {
  try {
    const C = typeof window !== 'undefined' ? window.Capacitor : null;
    if (!C || !C.Plugins) return null;
    const p = C.Plugins[PLUGIN];
    return p && typeof p.available === 'function' ? p : null;
  } catch (e) { return null; }
}

/** 原生容器 + 插件都到位 ⇒ 可尝试设备识别。Web 上恒 false（不要影响浏览器链路）。 */
export function nativeSpeechPresent() {
  return isNativeApp() && !!plugin();
}

/** 设备是否真的有可用的语音识别服务（有些 ROM 精简掉了 / 装不上 Google 服务） */
export async function nativeSpeechAvailable() {
  const p = plugin();
  if (!p) return false;
  try {
    const r = await p.available();
    return !!(r && r.available);
  } catch (e) { return false; }
}

/** 麦克风授权：'granted' | 'denied' | 'unknown'（Web 环境恒 unknown，不打扰浏览器链路） */
export async function nativeSpeechPermission() {
  const p = plugin();
  if (!p || typeof p.requestPermissions !== 'function') return 'unknown';
  try {
    const r = await p.requestPermissions();
    const s = r && r.speechRecognition;
    return s === 'granted' ? 'granted' : (s ? 'denied' : 'unknown');
  } catch (e) { return 'unknown'; }
}

/**
 * 听一句：按下时调用 start，松手时由调用方 `stop()` 收尾。
 * @returns {{done: Promise<{ok:boolean,text?:string,code?:string}>, stop: Function}}
 *  code: no_plugin / unavailable / permission_denied / listen_error / empty / timeout
 */
export function nativeListen({ lang = 'zh-CN', onPartial, timeoutMs = 20000 } = {}) {
  let stopFn = () => {};
  const done = new Promise((resolve) => {
    startNative(resolve, (fn) => { stopFn = fn; }, { lang, onPartial, timeoutMs });
  });
  return { done, stop: () => stopFn() };
}

async function startNative(resolve, setStop, { lang, onPartial, timeoutMs }) {
    const p = plugin();
    if (!p) return resolve({ ok: false, code: 'no_plugin' });

    let settled = false;
    const done = (r) => { if (settled) return; settled = true; cleanup(); resolve(r); };
    let partialHandle = null;
    let stateHandle = null;
    let timer = null;
    let best = '';

    const cleanup = async () => {
      if (timer) { clearTimeout(timer); timer = null; }
      try { if (partialHandle && partialHandle.remove) await partialHandle.remove(); } catch (e) { /* ignore */ }
      try { if (stateHandle && stateHandle.remove) await stateHandle.remove(); } catch (e) { /* ignore */ }
      try { if (p.stop) await p.stop(); } catch (e) { /* ignore */ }
    };

    try {
      const avail = await p.available();
      if (!(avail && avail.available)) return done({ ok: false, code: 'unavailable' });

      const perm = typeof p.requestPermissions === 'function' ? await p.requestPermissions().catch(() => null) : null;
      if (perm && perm.speechRecognition && perm.speechRecognition !== 'granted') {
        return done({ ok: false, code: 'permission_denied' });
      }

      if (p.addListener) {
        partialHandle = await p.addListener('partialResults', (data) => {
          const m = data && data.matches;
          if (m && m.length && m[0]) {
            best = String(m[0]);
            try { onPartial && onPartial(best); } catch (e) { /* ignore */ }
          }
        }).catch(() => null);
        stateHandle = await p.addListener('listeningState', (data) => {
          // 设备主动结束（静音超时 / 识别服务收尾）→ 立刻结算，不让用户干等
          if (data && data.status === 'stopped') {
            setTimeout(() => done(best ? { ok: true, text: best, engine: 'native' } : { ok: false, code: 'empty' }), 250);
          }
        }).catch(() => null);
      }

      const started = await p.start({
        language: lang,
        maxResults: 1,
        partialResults: true,
        popup: false,            // 不要系统的黑色识别弹窗，保持墨小溟自己的界面
      });
      const first = started && started.matches && started.matches[0];
      if (first) best = String(first);

      timer = setTimeout(() => done(best ? { ok: true, text: best, engine: 'native' } : { ok: false, code: 'timeout' }), timeoutMs);

      // 松手时由调用方调它收尾（不调也会在 listeningState=stopped 或超时后自动结算）
      setStop(() => done(best ? { ok: true, text: best, engine: 'native' } : { ok: false, code: 'empty' }));
    } catch (e) {
      return done({ ok: false, code: 'listen_error', detail: String((e && e.message) || e) });
    }
}
