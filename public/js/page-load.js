/* =====================================================
   页面加载效果 —— 真实进度条 + 内容淡入
   在页面 <head> 中引入（进度条骨架已在 head 内联，见 index.html / creative.html）

   设计要点（针对「首次打开慢」「进度条直接跳到 60-70%」两个问题）：
   1) 进度由真实资源完成事件驱动，但**逐帧平滑推进**：
      buffered 的 PerformanceObserver 会把已经完成的资源一次性回放，
      直接 setWidth 会导致首帧就从起点跳到 70%+。
      因此所有权重变化只更新「目标值」，由唯一一个 rAF 驱动带缓动逼近，
      并限制「每秒最大推进速度」，保证任何时刻视觉进度都连续递增。
      注意：全局只能有一个函数写 bar.style.width，多路 rAF 并发写会互相
      覆盖导致跳变（曾出现单帧 +12%~26% 的跳变）。
   2) 骨架挂在 <body> 上（而非 documentElement），避免 HTML 解析器
      对 <html> 下非 head/body 子节点的移除重挂行为导致进度条重置。
   3) 揭幕时机取 max(首屏内容可用, 最短展示时长)，既不让用户干等，
      也不会出现「进度条一闪而过」的割裂感。
   4) 三重兜底：DOMContentLoaded / window.load / 5s 定时，
      任一触发即收尾，任何异常都不会让用户永远卡在加载态。
   ===================================================== */
(function () {
    var docEl = document.documentElement;

    // ---------- 接管 HTML 里的进度条骨架 ----------
    // 重要：本脚本在 <head> 中同步执行，此时 <body> 里的骨架还没被解析到，
    // getElementById 一定返回 null。所以这里**绝不能**创建兜底元素——
    // 那会产生第二个进度条（HTML 里那个永远是 0%，成为静止的死元素），
    // 而且新元素会被挂到 <html> 下，正是要避免的位置。
    // 改为延迟接管：骨架一出现在 DOM 里就接过来用。
    var bar = null;

    function ensureStyle() {
        if (document.getElementById('page-loading-style')) return;
        var style = document.createElement('style');
        style.id = 'page-loading-style';
        style.textContent =
            '.page-loading-bar{position:fixed;top:0;left:0;width:0;height:3px;' +
            'background:linear-gradient(90deg,#3a65c2,#6b8fd8,#3a65c2);background-size:200% 100%;' +
            'z-index:2147483647;pointer-events:none;' +
            'box-shadow:0 0 8px rgba(58,101,194,.5);' +
            'transition:opacity .35s ease-out}';
        (document.head || docEl).appendChild(style);
    }

    // 接管骨架；仅当 HTML 里确实没有时才创建兜底元素（一律挂 body）
    function resolveBar() {
        if (bar && bar.isConnected) return bar;
        var found = document.getElementById('page-loading-bar');
        if (!found) return null;   // 骨架尚未解析到，等下一帧再试
        bar = found;
        if (document.body && bar.parentNode !== document.body) {
            document.body.appendChild(bar);   // 移回 body，脱离解析器管辖
        }
        ensureStyle();
        return bar;
    }

    resolveBar();

    // ---------- 进度模型 ----------
    var START = 0;        // 严格从 0% 开始，不做任何起点偏移
    var CAP = 92;         // 资源未完成时的上限，留出「最后一段」
    var MIN_SHOW = 700;   // 进度条最短展示时长(ms)，避免一闪而过
    var EPS = 0.05;       // 缓动停止阈值

    var doneWeight = 0;   // 已完成资源权重（真实）
    // 预估总权重：故意取大一些。buffered 回放会把「脚本执行前已完成的资源」
    // 一次性加进来，若 guessTotal 偏小，目标值会在第一帧就冲到 CAP，
    // rAF 即便限速也会表现为一次明显的起跳。取大值让进度均匀铺开。
    var guessTotal = 130;
    var shown = START;    // 当前视觉进度
    var target = START;   // 目标进度
    var fontCounted = false;
    var finished = false;
    var t0 = (typeof window.__loadStart === 'number') ? window.__loadStart : (window.performance && performance.now ? performance.now() : Date.now());

    function now() {
        return (window.performance && performance.now) ? performance.now() : Date.now();
    }

    function resourceProgress() {
        var ratio = Math.min(1, doneWeight / guessTotal);
        return START + (CAP - START) * ratio;
    }

    // 时间维度保底：随时间缓慢推进（最多到 CAP），保证「有资源没触发事件」时也在走。
    // easeOut 曲线，起步段刻意压得很慢：头几帧停在 0% 附近，
    // 让进度条真的是「从最左端长出来」，而不是一上来就有一截。
    function timeProgress() {
        var elapsed = now() - t0;
        var p = Math.min(1, elapsed / 5000);
        var eased = 1 - Math.pow(1 - p, 2.2);   // easeOutQuad-ish
        return START + (CAP - START) * eased * 0.85;
    }

    function updateTarget() {
        target = Math.max(resourceProgress(), timeProgress());
        if (target > CAP) target = CAP;
    }

    // ---------- 单一 rAF 驱动：平滑逼近 + 收尾补完 ----------
    // 关键：只有这一个函数写 bar.style.width，避免多路 rAF 并发写导致跳变。
    // 每帧按时间差计算步长（而非「每帧固定步长」），
    // 这样即使 rAF 被浏览器节流/合并（帧间隔变大），视觉推进速度也保持一致。
    var rafId = null;
    var lastTs = 0;
    var MAX_RATE = 45;   // 每秒最多推进的百分点，限制整体推进速度
    var MAX_STEP = 2;    // 单帧最多推进的百分点，帧率抖动时也绝不跳变

    function tick(ts) {
        var dt = lastTs ? Math.min(120, ts - lastTs) : 16;   // 帧间隔(ms)，上限 120
        lastTs = ts;

        if (finished) target = 100;   // 收尾时统一把目标推到 100

        // 进度模型照常推进（与骨架是否已出现无关，避免丢掉早期进度）
        var diff = target - shown;
        if (diff > EPS) {
            // 三重取小：指数逼近 / 每秒速率上限 / 单帧位移上限。
            // 单帧上限是必需的：headless 与后台标签页下 rAF 帧间隔会突然拉到 100ms+，
            // 只按 dt 算步长会让单帧位移放大到 5%+，肉眼就是一次跳变。
            var step = Math.min(diff * 0.16, (MAX_RATE * dt) / 1000, MAX_STEP);
            if (step < 0.02) step = Math.min(diff, 0.02);
            shown += step;
            if (shown > target) shown = target;
        }

        // 骨架刚被解析出来时接管（head 执行阶段必然取不到）
        if (!bar) resolveBar();
        if (bar) bar.style.width = shown.toFixed(2) + '%';

        if (!finished) {
            rafId = requestAnimationFrame(tick);
        } else if (!bar) {
            rafId = null;   // 没有骨架可收尾（极罕见），直接结束，避免空转
            try { applyFadeIn(); } catch (e) {}
            return;
        } else if (shown >= 100 - EPS) {
            rafId = null;
            bar.style.width = '100%';
            // 先注册移除流程，再做可选的淡入增强：
            // 万一 applyFadeIn 抛异常，也绝不能把进度条永久留在页面上。
            setTimeout(function () {
                bar.style.opacity = '0';
                setTimeout(function () {
                    if (bar.parentNode) bar.parentNode.removeChild(bar);
                }, 360);
            }, 120);
            try { applyFadeIn(); } catch (e) {}
            return;
        } else {
            rafId = requestAnimationFrame(tick);
        }
    }

    if (window.requestAnimationFrame) {
        rafId = requestAnimationFrame(tick);
    } else {
        setInterval(function () { tick(performance.now ? performance.now() : Date.now()); }, 16);
    }

    // 兜底爬升器：即使没有任何资源事件，也让 target 持续上升
    var crawler = setInterval(function () {
        if (finished) { clearInterval(crawler); return; }
        updateTarget();
    }, 120);

    // ---------- 真实资源完成事件 ----------
    var WEIGHT = { font: 26, script: 11, css: 11, img: 4, other: 3 };

    function classify(name, initiatorType) {
        if (/\.(woff2?|ttf|otf)(\?|$)/i.test(name)) return 'font';
        if (/\.js(\?|$)/i.test(name) || initiatorType === 'script') return 'script';
        if (/\.css(\?|$)/i.test(name) || initiatorType === 'link') return 'css';
        if (/\.(png|jpe?g|gif|webp|svg|avif|ico)(\?|$)/i.test(name) || initiatorType === 'img') return 'img';
        return 'other';
    }

    try {
        var po = new PerformanceObserver(function (list) {
            var entries = list.getEntries();
            for (var i = 0; i < entries.length; i++) {
                var e = entries[i];
                if (e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest') continue; // 业务异步请求不计入
                var kind = classify(e.name, e.initiatorType);
                if (kind === 'font') {
                    if (fontCounted) continue;
                    fontCounted = true;
                }
                doneWeight += WEIGHT[kind] || WEIGHT.other;
                if (doneWeight > guessTotal * 0.8) guessTotal += 30;
            }
            updateTarget();   // 只更新目标值，由 rAF 平滑逼近
        });
        po.observe({ type: 'resource', buffered: true });
    } catch (err) {
        /* 极老环境：仅依赖 timeProgress 兜底 */
    }

    // ---------- 内容淡入（可选增强，失败不影响可见性） ----------
    var skipSel = ['.beijing', '.background', '.dock-nav', '.page-loading-bar', '.articlelist', 'script', 'style', 'link'];
    function applyFadeIn() {
        if (!document.body) return;
        var children = document.body.children;
        var added = [];
        for (var i = 0; i < children.length; i++) {
            var el = children[i];
            if (el.nodeType !== 1 || el === bar) continue;
            var skipIt = false;
            for (var j = 0; j < skipSel.length; j++) {
                if (el.matches && el.matches(skipSel[j])) { skipIt = true; break; }
            }
            if (skipIt) continue;
            if (window.getComputedStyle(el).display === 'none') continue;
            el.classList.add('page-fadein');
            added.push(el);
        }
        setTimeout(function () {
            for (var k = 0; k < added.length; k++) added[k].classList.remove('page-fadein');
        }, 700);
    }

    // ---------- 收尾 ----------
    function finish() {
        if (finished) return;
        var elapsed = now() - t0;
        // 保证进度条有最短展示时长，避免「一闪而过」
        if (elapsed < MIN_SHOW) {
            setTimeout(finish, MIN_SHOW - elapsed + 20);
            return;
        }
        // 只置标志位 + 清掉爬升器；宽度由唯一的 rAF 驱动平滑补完到 100%
        finished = true;
        clearInterval(crawler);
        target = 100;
    }

    // DOM 就绪即可收尾（不等 window.load：字体等重资源可能慢，避免卡加载）
    function scheduleFinish() { setTimeout(finish, 60); }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        scheduleFinish();
    } else {
        document.addEventListener('DOMContentLoaded', scheduleFinish);
    }

    window.addEventListener('load', finish);   // 资源全好则提前收尾
    setTimeout(finish, 5000);                  // 硬兜底，绝不卡死
})();
