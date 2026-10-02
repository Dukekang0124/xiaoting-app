/**
 * 轻提醒「当前环境不支持」到底是谁的问题？（2026-10-02）
 *
 * 康哥在装好的 APK 手机上看设置页提示「当前环境不支持轻提醒（需安装 App 后使用）」。
 * 但 APK 里 assets/capacitor.plugins.json 明明注册了 @capacitor/local-notifications，
 * Android 侧插件是真的装了。所以要分清两种可能：
 *   A) 环境真不支持（纯浏览器打开网页）→ 降级提示是对的
 *   B) 环境支持、但前端取不到插件 → 降级提示是假阴性（真 bug）
 *
 * 判据：注入 Capacitor 原生环境（isNativePlatform()=true + 注册 LocalNotifications 插件），
 * 看 isSupported() 会不会转 true。同一判据跑「修复前 / 修复后」两版。
 */
const { chromium } = require('playwright');
const BASE = (process.env.BASE || 'http://127.0.0.1:4173').replace(/\/$/, '');

// 模拟原生环境：Capacitor 壳注入 window.Capacitor，已注册插件挂在 window.Capacitor.Plugins
const NATIVE_INIT = () => {
  if (window.__CapFaked) return;
  window.__CapFaked = true;
  const stub = {
    checkPermissions: async () => ({ display: 'granted' }),
    requestPermissions: async () => ({ display: 'granted' }),
    schedule: async () => ({ ok: true }),
    cancel: async () => ({ ok: true }),
    getPending: async () => ({ notifications: [] }),
  };
  window.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    Plugins: { LocalNotifications: stub },
  };
};

(async () => {
  const b = await chromium.launch({ channel: 'chrome' });

  async function probe(label, { native, noPlugin }) {
    const ctx = await b.newContext({ viewport: { width: 420, height: 880 } });
    await ctx.addInitScript(() => { try { localStorage.setItem('xiaoting:monthly:done_' + new Date().toISOString().slice(0, 7), String(Date.now())); } catch (e) {} });
    if (native) await ctx.addInitScript(noPlugin
      ? () => { window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {} }; }
      : NATIVE_INIT);
    const page = await ctx.newPage();
    // 轻提醒开关在 #/me（我的）页，不在 #/settings —— 之前 goto 错页所以 UI 断言恒 undefined
    await page.goto(BASE + '/#/me', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#meNotify', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(900);

    const r = await page.evaluate(async () => {
      const out = {};
      try { out.isNativeApp = (await import('/js/config.js')).isNativeApp(); } catch (e) { out.isNativeApp = 'err:' + e.message; }
      try {
        const n = await import('/js/notify.js');
        out.supported = await n.isSupported();
        out.preferredHour = n.preferredHour([
          { createdAt: '2026-10-01T06:10:00' }, { createdAt: '2026-10-02T06:20:00' }, { createdAt: '2026-10-03T06:05:00' },
        ]);
      } catch (e) { out.supported = 'err:' + e.message; }
      // 裸说明符在本环境能否解析（与 WebView 同类错误）
      try { await import('@capacitor/local-notifications'); out.bareImport = 'ok'; }
      catch (e) { out.bareImport = String((e && e.message) || e).slice(0, 140); }
      // UI 上的开关状态
      const nt = document.getElementById('meNotify');
      if (nt) {
        out.uiDisabled = !!nt.disabled;
        const box = nt.closest('.mblock');
        const desc = box && box.querySelector('.mblock__n');
        out.uiDesc = desc ? desc.textContent.trim().slice(0, 60) : '';
      }
      return out;
    });
    console.log(`\n----- ${label} -----`);
    console.log('  isNativeApp()        =', r.isNativeApp);
    console.log('  isSupported()        =', r.supported);
    console.log('  preferredHour(3×早6) =', r.preferredHour);
    console.log('  裸 import 结果       =', r.bareImport);
    console.log('  开关 disabled        =', r.uiDisabled, '| 说明文案 =', r.uiDesc);
    await ctx.close();
    return r;
  }

  const a = await probe('场景A 纯浏览器（对照：降级提示应当是对的）', { native: false });
  const bb = await probe('场景B 模拟 APK 原生环境（已注册 LocalNotifications）', { native: true });
  const c = await probe('场景C 模拟「装了 App 但插件没挂上」（UI 不能再说「需安装 App」）', { native: true, noPlugin: true });

  console.log('\n########## 判定 ##########');
  const okA = a.supported === false && a.uiDisabled === true && /需安装 App/.test(a.uiDesc || '');
  const okB = bb.supported === true && bb.uiDisabled === false;
  const okC = c.supported === false && /插件没能装载/.test(c.uiDesc || '');
  console.log(`  场景A（浏览器不支持）→ ${okA ? '✅ 如实禁用并说明「需安装 App」（降级正确）' : '❌ 浏览器端降级不正常'}`);
  console.log(`  场景B（原生 1.6.16）→ ${okB ? '✅ 开关可用，轻提醒能挂上' : '❌ 环境支持却仍报不支持 —— 降级是假阴性（真 bug）'}`);
  console.log(`  场景C（原生但插件缺失）→ ${okC ? '✅ 文案改成「插件没能装载」，不再自相矛盾' : '❌ 原生环境缺插件时文案仍误导'}`);
  const ok = okA && okB && okC;
  console.log(`  结论：${ok ? '三种环境都说对的话 ✅' : '仍有问题，继续修'}`);

  await b.close();
  process.exit(ok ? 0 : 1);
})();
