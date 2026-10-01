/**
 * 版本清单 → 可被 <script src> 直接加载的 JS 赋值脚本。
 *
 * 🔴 为什么要多这一份（v1.6.2，真机截图实证）：
 *    APK 里网页跑在 Capacitor 的 `https://localhost` 上，取清单只能走绝对基址
 *    `https://xiaoting.app.workbuddy.host/version.json` —— **跨域**。
 *    实测线上网关对 `/version.json` 的响应（带 Origin 头复测）：
 *      HTTP/1.1 200 + Content-Type: application/json，**没有 Access-Control-Allow-Origin**
 *    ⇒ 浏览器把这次 fetch 判为 CORS 失败 ⇒ 更新检测快速失败 ⇒ 落硬编码兜底 ⇒
 *      `latest === LATEST_VERSION === APP_VERSION` ⇒ `hasNew=false` ⇒ **弹窗一次都不会弹**。
 *    （用户看到的那句「暂时没连上更新服务，按本地记录你已是最新 v1.4.6」就是这条链路的产物。）
 *
 *    `<script src>` 是**经典脚本标签，不受 CORS 读限制**（外链脚本从诞生起就允许跨源执行），
 *    所以只要把清单再发成一份 `window.__VERSION_MANIFEST__ = {...}` 的 JS，
 *    跨域读清单这条路就通了 —— 不需要服务端配 ACAO，也不需要换托管平台。
 *
 * 🔴 只输出「更新弹窗真正用到的字段」：
 *    `history` 体量是正文的十倍量级，而它只给「更新日志页」用；那条路仍走 /version.json
 *    （并行候选 + 版本号相同时优先站点通道），所以这里不带 history，别为了省事塞全量。
 *
 * 🔴 唯一真相源仍是 server/version.json：build-web.mjs 与 server.cjs **共用本文件**生成，
 *    不许任何一处自己拼一份，否则改了 version.json 而脚本清单没跟上，
 *    就是「更新弹窗读到的版本号比线上旧」——又是一次静默失效。
 */
function buildManifestJs(manifestObj) {
  const src = manifestObj && typeof manifestObj === 'object' ? manifestObj : {};
  const slim = {
    latest_version: String(src.latest_version || ''),
    force_update: !!src.force_update,
    download_url: String(src.download_url || ''),
    web_url: String(src.web_url || ''),
    apk: src.apk && typeof src.apk === 'object' ? src.apk : {},
    release_notes: Array.isArray(src.release_notes) ? src.release_notes : [],
  };
  return [
    '/* 自动生成：由 scripts/version-manifest-js.cjs 依据 server/version.json 生成，请勿手改 */',
    'window.__VERSION_MANIFEST__ = ' + JSON.stringify(slim, null, 2) + ';',
    '',
  ].join('\n');
}

module.exports = { buildManifestJs };
