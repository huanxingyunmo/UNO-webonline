// 主题预初始化：在渲染前根据 localStorage / 系统偏好设置暗色，避免闪烁
try{var m=localStorage.getItem('mobai-theme')||'system';if(m!=='system'&&m!=='light'&&m!=='dark')m='system';var d=m==='dark'||(m==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.setAttribute('data-theme',d?'dark':'light');}catch(e){document.documentElement.setAttribute('data-theme','light');}
