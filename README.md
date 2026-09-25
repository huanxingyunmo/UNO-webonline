# UnoLive · UNO-webonline

打开浏览器就能玩的在线多人 UNO。无需下载 App、无需注册，一个链接召唤 4–10 位好友。

从个人站点「幻星韵墨的小站」中独立出来的项目：**前端纯静态** + **Cloudflare Worker 游戏服务端**。

## 目录结构

```
├── index.html          游戏主页面（创建/加入房间、开局、观战）
├── creative.html       产品介绍落地页
├── css/
│   ├── uno.css         游戏页样式
│   ├── uno-creative.css 落地页样式
│   ├── common.css      公共基础样式（重置、字体、背景层）
│   ├── theme-light.css 亮色主题变量
│   ├── theme-dark.css  暗色主题变量
│   └── page-load.css   加载进度条
├── js/
│   ├── uno.js          游戏 WebSocket 客户端（配置块在文件顶部）
│   ├── theme.js        三态主题切换（system / light / dark）
│   ├── theme-preinit.js 主题预初始化，防止刷新闪白
│   └── page-load.js    加载进度条
├── assets/
│   ├── favicon.jpg
│   └── fonts/main-font.ttf  站点主字体（Kosugi Maru，约 21MB）
└── worker/             游戏服务端（Cloudflare Worker + Durable Objects）
    ├── wrangler.toml
    └── src/index.js
```

## 服务端部署

每个房间对应一个 Durable Object 实例，房间状态存在其中；玩家断线 30 秒后才移除，期间可原样重连。

```bash
cd worker
npm i -D wrangler
npx wrangler deploy
```

部署成功后 wrangler 会给出类似 `https://uno-game.<你的账号>.workers.dev` 的地址，把它填回前端：

```js
// js/uno.js 顶部
const UNO_CONFIG = {
  server: 'wss://<你的域名>/ws',   // 注意是 wss://，且路径为 /ws
  ...
};
```

服务端只有两个路由：`/ws`（WebSocket 升级，必带 `room` 参数）和 `/`（健康检查，返回 `UNO Game Server OK`）。已允许任意来源 CORS。

## 前端配置

`js/uno.js` 顶部的 `UNO_CONFIG`：

| 字段 | 说明 |
|---|---|
| `server` | 游戏服务器 WebSocket 地址。留空则自动回落到同源 `/ws` |
| `authCheckUrl` | 登录校验接口。**留空 = 免登录模式**，填个昵称就能建房间；填入接口地址（需返回 `{ authenticated, user }`）则启用登录锁定昵称 |
| `loginUrl` | 登录页地址，仅当 `authCheckUrl` 非空时生效 |

默认即免登录模式，适合独立部署。

## 本地预览

```bash
# 任选其一，然后访问 http://localhost:8000
python -m http.server 8000
npx serve .
```

默认连的是已部署的线上游戏服务器，本地起静态服务即可直接开局，不必先部署 worker。

## 部署前端

仓库根目录即输出目录，无构建步骤：

- **Cloudflare Pages**：构建留空 / 输出目录 `/`
- **GitHub Pages**：Deploy from branch → 分支根目录

改动 `js/*.js` 或 `css/*.css` 后记得递增 HTML 里对应的 `?v=N` 版本号。

## 玩法

创建房间 → 复制房间链接发给好友 → 2 人以上开局。支持 +2 / +4 / 反转 / 跳过 / 变色 / 喊 UNO，房间满员或旁观时自动进入**观战模式**，可切换视角查看任意玩家手牌。

## 说明

- 字体文件较大主要是为了保留原站排版，若不需要可从 `css/common.css` 去掉 `@font-face` 与 `assets/fonts/`。
- `assets/favicon.jpg` 为站点头像，可自行替换。
