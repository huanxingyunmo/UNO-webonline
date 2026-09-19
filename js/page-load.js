/* =====================================================
   页面加载效果 - 顶部进度条 + 内容淡入动画
   在所有页面的 <head> 中引入此文件（script 标签放在最前面）
   ===================================================== */
(function () {
    // 创建进度条元素（放到 body 上，确保可见）
    var bar = document.createElement('div');
    bar.className = 'page-loading-bar';
    document.documentElement.appendChild(bar);

    // 预隐藏内容：在 head 中立即注入，防止 body 渲染后内容以 100% 闪现
    // 使用普通声明（非 !important），确保后续 CSS 动画能覆盖
    var preHideStyle = document.createElement('style');
    preHideStyle.id = 'page-prehide-style';
    preHideStyle.textContent =
        'body > :not(.beijing):not(.background):not(.dock-nav):not(.page-loading-bar):not(.articlelist):not(script):not(style):not(link){opacity:0;}';
    document.documentElement.appendChild(preHideStyle);

    // 开始加载动画
    requestAnimationFrame(function () {
        bar.classList.add('loading');
    });

    // 需要跳过的选择器（不添加淡入动画的元素）
    var skipSelectors = [
        '.beijing',
        '.background',
        '.dock-nav',
        '.page-loading-bar',
        '.articlelist',
        'script',
        'style',
        'link'
    ];

    function shouldSkip(el) {
        if (el.nodeType !== 1) return true; // 跳过非元素节点
        for (var i = 0; i < skipSelectors.length; i++) {
            if (el.matches && el.matches(skipSelectors[i])) return true;
        }
        return false;
    }

    // 给内容元素添加淡入类（所有元素同时开始、同时结束，无错开延迟）
    function applyFadeIn() {
        var children = document.body.children;

        for (var i = 0; i < children.length; i++) {
            if (shouldSkip(children[i])) continue;
            // 跳过当前已不可见的元素（如 SPA 中非 active 的 screen）
            var computed = window.getComputedStyle(children[i]);
            if (computed.display === 'none') continue;
            children[i].classList.add('page-fadein');
        }

        // 下一帧移除预隐藏样式（此时 CSS 动画已启动，backwards fill 已生效）
        // 同时安排动画结束后的清理
        requestAnimationFrame(function () {
            var preHide = document.getElementById('page-prehide-style');
            if (preHide) preHide.remove();

            // 动画结束后清除类名，恢复原始 CSS 控制
            setTimeout(function () {
                var els = document.querySelectorAll('.page-fadein');
                for (var k = 0; k < els.length; k++) {
                    els[k].classList.remove('page-fadein');
                }
            }, 750);
        });
    }

    // 页面加载完成
    function finish() {
        bar.classList.remove('loading');
        bar.classList.add('finishing');
        setTimeout(function () {
            bar.classList.remove('finishing');
            bar.classList.add('done');
            applyFadeIn();
            setTimeout(function () {
                bar.remove();
            }, 500);
        }, 300);
    }

    if (document.readyState === 'complete') {
        finish();
    } else {
        window.addEventListener('load', finish);
    }
})();
