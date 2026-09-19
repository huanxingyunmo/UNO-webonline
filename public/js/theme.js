/* =====================================================
   全站主题切换公共模块
   三态：system（跟随系统，默认）/ light / dark
   通过 document.documentElement 的 data-theme 属性控制
   localStorage key = 'mobai-theme'
   ===================================================== */
(function () {
  'use strict';

  // localStorage 存储键
  var STORAGE_KEY = 'mobai-theme';

  // 暗色模式开关：开启后支持 light / dark / system 三态
  var DARK_MODE_ENABLED = true;

  // 读取本地存储的主题模式（system / light / dark），无效值回退为 system
  function getStoredMode() {
    try {
      var m = localStorage.getItem(STORAGE_KEY);
      if (m === 'auto') m = 'system';
      return m === 'system' || m === 'light' || m === 'dark' ? m : 'system';
    } catch (e) {
      return 'system';
    }
  }

  // 判断系统当前是否偏好暗色
  function systemPrefersDark() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  // 获取实际应用的主题（light 或 dark）；system 模式下根据系统偏好决定
  function getAppliedTheme() {
    if (!DARK_MODE_ENABLED) return 'light';
    var mode = getStoredMode();
    if (mode === 'system') return systemPrefersDark() ? 'dark' : 'light';
    return mode;
  }

  // 应用主题：给 <html> 设置 data-theme 属性（light 或 dark）
  // system 模式同样写入实际应用值，保证 CSS 变量立即生效，避免 FOUC
  function applyTheme() {
    var applied = getAppliedTheme();
    document.documentElement.setAttribute('data-theme', applied);
    // 派发主题变化事件，供设置面板等组件监听并更新选中态
    window.dispatchEvent(new CustomEvent('mobai-theme-change', {
      detail: { mode: getStoredMode(), applied: applied }
    }));
  }

  // 获取当前用户选择的模式（system / light / dark）
  function getMode() {
    return getStoredMode();
  }

  // 设置主题模式：写 localStorage + 应用 + 派发事件
  function setMode(mode) {
    if (mode !== 'system' && mode !== 'light' && mode !== 'dark') return;
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch (e) { /* 忽略隐私模式写入失败 */ }
    applyTheme();
  }

  // 监听系统主题变化：仅当用户选择"跟随系统"时响应，重新应用主题
  var darkMedia = window.matchMedia('(prefers-color-scheme: dark)');
  if (darkMedia.addEventListener) {
    darkMedia.addEventListener('change', function () {
      if (getStoredMode() === 'system') applyTheme();
    });
  } else if (darkMedia.addListener) {
    // 兼容旧版 Safari
    darkMedia.addListener(function () {
      if (getStoredMode() === 'system') applyTheme();
    });
  }

  // 暴露全局接口
  window.MobaiTheme = {
    getMode: getMode,
    setMode: setMode,
    getAppliedTheme: getAppliedTheme,
    applyTheme: applyTheme,
    darkModeEnabled: function () { return DARK_MODE_ENABLED; }
  };

  // 脚本加载时立即应用一次（若 head 内联脚本已提前设置，此处为幂等覆盖）
  applyTheme();
})();
