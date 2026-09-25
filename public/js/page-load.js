/* ============================================================================
   顶部加载进度条
   ----------------------------------------------------------------------------
   两条铁律（这就是本文件存在的全部理由）：
     1) 进度满 100%  ⇔  页面真的加载完（window.load 触发）—— 绝不提前走完
     2) load 一旦触发，进度条立即结束 —— 绝不在页面就绪后还继续移动

   进度从哪来（不猜、不匀速自爬）：
     分子 = 已完成的真实资源数（PerformanceObserver 上报，按 URL 去重）
     分母 = HTML 里声明的资源数（DOM 就绪时枚举，此时 HTML 已解析完，清单确定）
     DOM 就绪前分母未知，只按已完成数小幅推进（最多 15%）。
     另保留一个极慢的「蠕动」（0.8% / 秒）避免长时间静止，
     但它永远无法把进度推到 100% —— 收尾只能由 load 事件触发。

   元素从哪来：
     骨架写在 HTML 的 <body> 首个子节点，解析到即渲染（零延迟、从 0% 起）。
     本脚本在 <head> 同步执行时取不到它，所以只在能取到时接管，绝不主动创建
     —— 否则会出现两个进度条（后建的那个还会被挂到 <html> 下，被解析器搬走）。
     页面确实漏加骨架时，等 DOM 就绪后再补一个（那时 body 一定存在，安全）。
   ============================================================================ */
(function () {
    'use strict';

    var SAFETY_MS = 8000;   // 兜底：这么久仍未 load 就收尾（防某个请求永久挂起）
    var CREEP_PPS = 0.8;    // 停滞蠕动速度（百分点/秒），封顶 99%

    var bar = null;
    var shown = 0;          // 当前显示值
    var target = 0;         // 目标值
    var doneCount = 0;      // 已完成资源数
    var totalCount = 0;     // 声明资源数（DOM 就绪后确定）
    var seen = {};          // 资源 URL 去重
    var domReady = false;
    var ended = false;
    var startedAt = ms();

    function ms() {
        return (window.performance && performance.now) ? performance.now() : Date.now();
    }

    // ---------- 进度条元素 ----------
    function pickBar() {
        if (bar && bar.isConnected) return bar;
        bar = document.getElementById('page-loading-bar');
        return bar;
    }

    // 仅当页面确实漏加骨架时调用（DOM 就绪后 body 一定存在，此时创建是安全的）
    function ensureBar() {
        if (pickBar()) return bar;
        bar = document.createElement('div');
        bar.className = 'page-loading-bar';
        bar.id = 'page-loading-bar';
        bar.style.width = '0%';
        document.body.appendChild(bar);
        return bar;
    }

    // ---------- 进度计算 ----------
    function countDeclared() {
        var n = document.querySelectorAll('link[rel="stylesheet"]').length
              + document.querySelectorAll('script[src]').length
              + document.querySelectorAll('img[src]').length
              + document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]').length;
        return n > 0 ? n : 1;
    }

    function calcTarget() {
        if (ended) return 100;                       // 铁律 1：只有 load 之后才可能到 100
        var denom = totalCount > 0 ? totalCount : 8;
        var ratio = Math.min(1, doneCount / denom);
        var real = (domReady ? 15 : 0) + (domReady ? 84 : 15) * ratio;
        var creep = ((ms() - startedAt) / 1000) * CREEP_PPS;
        if (creep > real) real = creep;              // 蠕动保底，避免长时间完全静止
        return real > 99 ? 99 : real;                // 铁律 1：封顶 99%
    }

    // ---------- 逐帧推进（全局唯一写 width 的地方） ----------
    function tick() {
        if (!pickBar()) {
            if (ended) return;                       // 已收尾且元素不在，结束
            requestAnimationFrame(tick);
            return;
        }
        if (ended) {
            // 收尾：用 CSS transition 一次性补到 100%。
            // 不用 rAF 逐帧爬 —— 低帧率下那要十几帧、拖几百毫秒，
            // 表现就是用户说的「页面已经好了，进度条还在动」。
            bar.style.transition = 'width .15s ease-out, opacity .3s ease-out';
            bar.style.width = '100%';
            setTimeout(function () {
                bar.style.opacity = '0';
                setTimeout(function () {
                    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
                }, 300);
            }, 170);
            return;                                  // 收尾完成，不再排帧
        }
        target = calcTarget();
        var diff = target - shown;
        if (diff > 0.02) {
            shown += Math.min(diff * 0.2, 3);        // 只前进
            if (shown > target) shown = target;
            bar.style.width = shown.toFixed(1) + '%';
        }
        requestAnimationFrame(tick);
    }

    // ---------- 收尾：只置标志，补完到 100% 交给 tick ----------
    function end() {
        ended = true;
    }

    // ---------- 资源完成计数 ----------
    try {
        new PerformanceObserver(function (list) {
            var es = list.getEntries();
            for (var i = 0; i < es.length; i++) {
                var e = es[i];
                // 业务异步请求（接口取数）不算页面加载进度
                if (e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest') continue;
                if (seen[e.name]) continue;
                seen[e.name] = 1;
                doneCount++;
                // 动态插入的资源（JS 渲染出的图片等）会让分子超出原分母，分母跟着涨
                if (doneCount > totalCount) totalCount = doneCount;
            }
        }).observe({ type: 'resource', buffered: true });
    } catch (err) { /* 老浏览器：仅靠蠕动推进 */ }

    // ---------- 生命周期 ----------
    function onReady() {
        if (domReady) return;
        domReady = true;
        ensureBar();
        var declared = countDeclared();
        totalCount = declared > doneCount ? declared : doneCount;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onReady);
    } else {
        onReady();
    }

    // 铁律 2：这是唯一的正常收尾入口
    if (document.readyState === 'complete') {
        end();
    } else {
        window.addEventListener('load', end);
    }
    setTimeout(end, SAFETY_MS);                      // 兜底，绝不永久卡住

    requestAnimationFrame(tick);
})();
