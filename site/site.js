/* 墨小溟官网 · 渐进增强脚本
 * 设计原则：即使本脚本不运行，所有内容也已可见（无依赖的默认可见）。
 * 仅做「锦上添花」：移动端菜单收起、复制按钮、年份、滚动渐显（带兜底）。 */
(function () {
  'use strict';

  /* —— 1. 年份 —— */
  try {
    var y = document.getElementById('year');
    if (y) y.textContent = String(new Date().getFullYear());
  } catch (e) {}

  /* —— 2. 移动端菜单：点击链接后收起 —— */
  try {
    var toggle = document.getElementById('navtoggle');
    if (toggle) {
      var menu = document.querySelector('.nav__menu');
      if (menu) {
        menu.addEventListener('click', function (e) {
          var t = e.target;
          if (t && t.closest && t.closest('a')) toggle.checked = false;
        });
      }
    }
  } catch (e) {}

  /* —— 3. 复制按钮 —— */
  try {
    var copyBtns = document.querySelectorAll('.copy-btn[data-copy]');
    copyBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var text = btn.getAttribute('data-copy') || '';
        var done = function () {
          var old = btn.textContent;
          btn.textContent = '已复制';
          btn.classList.add('copied');
          setTimeout(function () {
            btn.textContent = old;
            btn.classList.remove('copied');
          }, 1600);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text, done); });
        } else {
          fallbackCopy(text, done);
        }
      });
    });
    function fallbackCopy(text, done) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        done();
      } catch (e) {}
    }
  } catch (e) {}

  /* —— 4. 滚动渐显（带兜底：绝不把内容永久藏起来） —— */
  try {
    var revealEls = document.querySelectorAll('.reveal');
    var revealed = false;
    function revealAll() {
      if (revealed) return;
      revealed = true;
      revealEls.forEach(function (el) { el.classList.add('is-visible'); });
    }
    if (!('IntersectionObserver' in window) || !revealEls.length) {
      revealAll();
    } else {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) {
            en.target.classList.add('is-visible');
            io.unobserve(en.target);
          }
        });
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
      revealEls.forEach(function (el) { io.observe(el); });
      // 兜底：1.6s 后无论如何全部显示，避免任何异常导致内容空白
      setTimeout(revealAll, 1600);
      // 页面隐藏标签页再回来也可能错过首屏，load 后再补一次
      window.addEventListener('load', function () {
        setTimeout(function () {
          revealEls.forEach(function (el) {
            var r = el.getBoundingClientRect();
            if (r.top < (window.innerHeight || 800)) el.classList.add('is-visible');
          });
        }, 50);
      });
    }
  } catch (e) {
    // 任何意外都直接显示全部
    try {
      document.querySelectorAll('.reveal').forEach(function (el) { el.classList.add('is-visible'); });
    } catch (e2) {}
  }
})();
