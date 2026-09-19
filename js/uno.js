/* =================================================================
   UNO 多人在线卡牌游戏 - WebSocket 版
   使用 Cloudflare Durable Objects 管理游戏状态
   ================================================================= */

const COLORS = ['red','yellow','green','blue'];
const COLOR_NAMES = {red:'红色',yellow:'黄色',green:'绿色',blue:'蓝色'};
const COLOR_CSS = {red:'var(--uno-red)',yellow:'var(--uno-yellow)',green:'var(--uno-green)',blue:'var(--uno-blue)'};
const PLAYER_COLORS = ['#E74C3C','#3498DB','#2ECC71','#F1C40F'];

let ws = null;
let myId = '';
let myName = '';
let roomCode = '';
let isHost = false;
let isSpectator = false;
let players = [];
let myCards = [];
let gameState = null;
let pendingWildCard = null;
let myPlayerIndex = -1;
let reconnectTimer = null;
let reconnectAttempts = 0;
let reconnectMaxAttempts = 5;
let pingInterval = null;
let specViewIndex = 0; // 观战者当前视角玩家索引
let specAllCards = {}; // 观战者：所有玩家手牌 {playerIndex: [cards]}
let specSidebarOpen = true;
let loggedInUser = null; // 已登录用户名（null=未登录或未检查）

// ===================== 可配置项 =====================
// server        UNO 游戏服务器 WebSocket 地址（部署 worker/ 后改成自己的地址）
// authCheckUrl  登录校验接口。留空 = 免登录模式，填昵称即可创建房间；
//               若接入自己的账号系统，填入接口地址（需返回 { authenticated, user }）
// loginUrl      登录页地址，仅当 authCheckUrl 非空时生效
const UNO_CONFIG = {
  server: 'wss://ws.uno.mobaixingyao.dpdns.org/ws',
  authCheckUrl: '',
  loginUrl: '/login'
};

const UNO_SERVER = UNO_CONFIG.server;

function getWsUrl() {
  if (UNO_SERVER) return UNO_SERVER;
  const loc = window.location;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return proto + '//' + loc.host + '/ws';
}

function normalizeRoomCode(value) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g,'');
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function getCardClass(card) {
  if (card.color === 'wild') return 'card-wild';
  return 'card-' + card.color;
}

function getCardDisplay(card) {
  const v = card.value;
  if (v === 'skip') return {main:'\u29B8',label:'SKIP'};
  if (v === 'reverse') return {main:'\u21BB',label:'REV'};
  if (v === 'draw2') return {main:'+2',label:'+2'};
  if (v === 'wild') return {main:'W',label:'W'};
  if (v === 'wild4') return {main:'+4',label:'+4'};
  return {main:v,label:v};
}

function renderCardHTML(card,extraClass) {
  const cls = getCardClass(card);
  const disp = getCardDisplay(card);
  const isSpecial = ['skip','reverse','draw2','wild','wild4'].includes(card.value);
  return '<div class="card ' + cls + ' ' + (extraClass||'') + '">' +
    '<span class="card-value-small">' + disp.label + '</span>' +
    '<span class="' + (isSpecial ? 'card-icon' : 'card-value') + '">' + disp.main + '</span>' +
    '<span class="card-value-small-br">' + disp.label + '</span>' +
  '</div>';
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  document.querySelector('.page-back').style.display = (id === 'gameScreen') ? 'none' : 'flex';
  // 重置观战横幅
  const specBanner = document.getElementById('spectatorBanner');
  if (specBanner) specBanner.style.display = 'none';
}

function showStartScreen() {
  cleanup();
  showScreen('startScreen');
}

// 检查登录状态，返回用户名或 null
async function checkAuth() {
  // 未接入账号系统：不请求、不拦截，视为免登录
  if (!UNO_CONFIG.authCheckUrl) return null;
  try {
    const authResp = await fetch(UNO_CONFIG.authCheckUrl);
    const authData = await authResp.json();
    if (authData.authenticated && authData.user) {
      loggedInUser = authData.user;
    }
  } catch (e) {}
  return loggedInUser;
}

async function showCreateScreen() {
  const user = await checkAuth();
  // 接入账号系统却没登录 -> 跳登录页；未接入账号系统 -> 直接用昵称创建
  if (!user && UNO_CONFIG.authCheckUrl) {
    showToast('创建房间需要登录，正在跳转登录页...', 'warning');
    setTimeout(function() {
      window.location.href = UNO_CONFIG.loginUrl + '?redirect=' + encodeURIComponent(location.pathname + '?action=create');
    }, 1500);
    return;
  }
  showScreen('createScreen');
  const nicknameInput = document.getElementById('createNickname');
  const nicknameHint = document.getElementById('createNicknameHint');
  if (user) {
    nicknameInput.value = user;
    nicknameInput.readOnly = true;
    nicknameInput.style.background = '';
    if (nicknameHint) nicknameHint.style.display = '';
  } else {
    nicknameInput.value = '';
    nicknameInput.readOnly = false;
    if (nicknameHint) nicknameHint.style.display = 'none';
  }
  nicknameInput.focus();
}

function showJoinScreen() {
  showScreen('joinScreen');
  const hint = document.getElementById('joinNicknameHint');
  if (loggedInUser) {
    document.getElementById('joinNickname').value = loggedInUser;
    if (hint) hint.style.display = '';
  } else {
    if (hint) hint.style.display = 'none';
  }
  document.getElementById('joinRoomCode').focus();
}

function showToast(msg,type) {
  type = type || 'info';
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(function(){if(toast.parentNode)toast.remove();},3200);
}

function updateConnectionStatus(status,text) {
  const el = document.getElementById('connectionStatus');
  const dotClass = status === 'connected' ? 'connected' : status === 'connecting' ? 'connecting' : 'disconnected';
  el.innerHTML = '<span class="status-dot ' + dotClass + '"></span><span>' + text + '</span>';
}

function connectWebSocket(code,name,reconnectId) {
  return new Promise(function(resolve,reject){
    let url = getWsUrl() + '?room=' + encodeURIComponent(code) + '&name=' + encodeURIComponent(name);
    if (reconnectId) url += '&id=' + encodeURIComponent(reconnectId);
    const socket = new WebSocket(url);

    const timeout = setTimeout(function(){
      if (socket.readyState !== WebSocket.OPEN) {
        socket.close();
        reject(new Error('连接超时'));
      }
    },15000);

    socket.onopen = function(){clearTimeout(timeout);resolve(socket);};
    socket.onerror = function(){clearTimeout(timeout);reject(new Error('连接失败'));},
    socket.onclose = function(){clearTimeout(timeout);reject(new Error('连接关闭'));};
  });
}

async function createRoom() {
  cleanup();
  myName = document.getElementById('createNickname').value.trim() || '玩家1';
  roomCode = generateRoomCode();
  updateConnectionStatus('connecting','正在创建房间...');

  try {
    ws = await connectWebSocket(roomCode,myName);
    setupWebSocket();
  } catch (e) {
    showToast('创建房间失败: ' + e.message,'error');
    updateConnectionStatus('disconnected','连接失败');
    showScreen('startScreen');
  }
}

async function joinRoom() {
  const code = normalizeRoomCode(document.getElementById('joinRoomCode').value);
  const name = document.getElementById('joinNickname').value.trim() || '玩家';

  if (code.length !== 6) {
    showToast('请输入6位房间代码','warning');
    return;
  }

  cleanup();
  roomCode = code;
  myName = name;
  updateConnectionStatus('connecting','正在连接...');

  showScreen('lobbyScreen');
  document.getElementById('lobbyRoomCode').textContent = roomCode;
  document.getElementById('lobbyPlayers').innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px"><span class="loading-spinner"></span>正在连接...</div>';

  try {
    ws = await connectWebSocket(roomCode,myName);
    setupWebSocket();
  } catch (e) {
    showToast('加入房间失败: ' + e.message,'error');
    updateConnectionStatus('disconnected','连接失败');
    showScreen('joinScreen');
    document.getElementById('joinRoomCode').value = roomCode;
    document.getElementById('joinNickname').value = myName;
  }
}

function setupWebSocket() {
  if (pingInterval) clearInterval(pingInterval);
  pingInterval = setInterval(function(){
    sendToServer({type:'ping'});
  }, 25000);

  ws.onmessage = function(event){
    try { handleServerMessage(JSON.parse(event.data)); } catch(e){ console.error('Message parse error:',e); }
  };

  ws.onclose = function(){
    clearInterval(pingInterval);
    pingInterval = null;
    updateConnectionStatus('disconnected','连接已断开');
    if (document.getElementById('gameScreen').classList.contains('active') || isSpectator) {
      showToast('与服务器断开连接，正在尝试重连...','warning');
      attemptReconnect();
    }
  };

  ws.onerror = function(){
    updateConnectionStatus('disconnected','连接错误');
  };
}

function attemptReconnect() {
  if (!roomCode || !myId || reconnectAttempts >= reconnectMaxAttempts) {
    showToast('重连失败，请重新加入房间','error');
    cleanup();
    showScreen('startScreen');
    return;
  }
  reconnectAttempts++;
  const delay = Math.min(2000 * reconnectAttempts, 10000);
  updateConnectionStatus('connecting','正在重连 (' + reconnectAttempts + '/' + reconnectMaxAttempts + ')...');

  reconnectTimer = setTimeout(async function(){
    try {
      ws = await connectWebSocket(roomCode, myName, myId);
      reconnectAttempts = 0;
      setupWebSocket();
      updateConnectionStatus('connected','已重新连接 - 房间: ' + roomCode);
      showToast('重新连接成功','success');
    } catch (e) {
      attemptReconnect();
    }
  }, delay);
}

function handleServerMessage(data) {
  switch (data.type) {
    case 'assigned':
      myId = data.id;
      isHost = data.isHost;
      isSpectator = data.isSpectator || false;
      updateConnectionStatus('connected','已连接 - 房间: ' + roomCode + (isSpectator ? ' (观战)' : ''));
      document.getElementById('lobbyRoomCode').textContent = roomCode;
      if (data.isReconnect) {
        showToast('重连成功','success');
      }
      if (isSpectator) {
        showScreen('gameScreen');
      } else {
        showScreen('lobbyScreen');
      }
      break;
    case 'lobbyUpdate':
      myPlayerIndex = data.yourIndex !== undefined ? data.yourIndex : -1;
      isHost = data.isHost !== undefined ? data.isHost : isHost;
      players = data.players.map(function(p){
        return {name:p.name,cardCount:0,calledUno:false,isHost:p.isHost};
      });
      updateLobbyUI();
      break;
    case 'gameStarted':
      if (!isSpectator) showScreen('gameScreen');
      break;
    case 'gameStateUpdate':
      gameState = data.gameState;
      myCards = data.yourCards || myCards;
      if (data.playersInfo) {
        players = data.playersInfo.map(function(p){
          return {name:p.name,cardCount:p.cardCount,calledUno:p.calledUno};
        });
      }
      myPlayerIndex = data.yourIndex !== undefined ? data.yourIndex : myPlayerIndex;
      if (!isSpectator && document.getElementById('lobbyScreen').classList.contains('active')) {
        showScreen('gameScreen');
      }
      renderGame();
      break;
    case 'spectatorStateUpdate':
      gameState = data.gameState;
      if (data.playersInfo) {
        specAllCards = {};
        players = data.playersInfo.map(function(p,i){
          if (p.cards) specAllCards[i] = p.cards;
          return {name:p.name,cardCount:p.cardCount,calledUno:p.calledUno};
        });
      }
      myPlayerIndex = -1;
      myCards = [];
      // 确保 specViewIndex 有效
      if (specViewIndex >= players.length) specViewIndex = 0;
      renderGame();
      renderSpectatorSidebar();
      break;
    case 'chooseColorRequest':
      pendingWildCard = true;
      document.getElementById('colorModal').classList.add('active');
      break;
    case 'toast':
      showToast(data.message,data.toastType || 'info');
      break;
    case 'gameOver':
      showEndScreen(data);
      break;
    case 'gameEnded':
      showToast(data.reason,'error');
      cleanup();
      showScreen('startScreen');
      break;
    case 'lobbyClosed':
      showToast('房间已关闭','error');
      cleanup();
      showScreen('startScreen');
      break;
    case 'pong':
      break;
  }
}

function sendToServer(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function updateLobbyUI() {
  const container = document.getElementById('lobbyPlayers');
  container.innerHTML = players.map(function(p,i){
    return '<div class="lobby-player">' +
      '<div class="lobby-player-avatar" style="background:' + PLAYER_COLORS[i % 4] + '">' + p.name[0] + '</div>' +
      '<div class="lobby-player-name">' + p.name + '</div>' +
      (p.isHost ? '<div class="lobby-player-tag">房主</div>' : '') +
    '</div>';
  }).join('');

  const startBtn = document.getElementById('startGameBtn');
  if (isHost) {
    startBtn.disabled = players.length < 2;
    startBtn.textContent = players.length < 2
      ? '开始游戏 (至少2人，当前' + players.length + '人)'
      : '开始游戏 (' + players.length + '人)';
    startBtn.style.display = '';
  } else {
    startBtn.style.display = 'none';
  }
}

function leaveLobby() {
  cleanup();
  showScreen('startScreen');
}

function leaveGame() {
  cleanup();
  showScreen('startScreen');
}

function startGame() {
  if (!isHost) return;
  sendToServer({type:'startGame'});
}

function playCard(cardIndex) {
  if (!gameState) return;
  const isMyTurn = gameState.currentPlayer === myPlayerIndex;
  if (!isMyTurn) return;

  const card = myCards[cardIndex];
  if (!card) return;

  if (card.color === 'wild') {
    pendingWildCard = {cardIndex:cardIndex,card:card};
    document.getElementById('colorModal').classList.add('active');
    return;
  }

  sendToServer({type:'playCard',cardIndex:cardIndex});
}

function drawCard() {
  if (!gameState) return;
  const isMyTurn = gameState.currentPlayer === myPlayerIndex;
  if (!isMyTurn) return;
  sendToServer({type:'drawCard'});
}

function callUno() {
  if (!gameState) return;
  sendToServer({type:'callUno'});
}

function chooseColor(color) {
  document.getElementById('colorModal').classList.remove('active');
  if (pendingWildCard && pendingWildCard.cardIndex !== undefined) {
    // 本地拦截的万能牌：发送 playCard + chosenColor
    sendToServer({type:'playCard',cardIndex:pendingWildCard.cardIndex,chosenColor:color});
  } else if (pendingWildCard) {
    // 服务端请求选色：发送 chooseColor
    sendToServer({type:'chooseColor',color:color});
  }
  pendingWildCard = null;
}

function canPlayCard(card) {
  if (!gameState) return false;
  const topCard = gameState.discardPile[gameState.discardPile.length - 1];
  if (card.color === 'wild' || card.value === 'wild4') return true;
  if (card.color === gameState.currentColor) return true;
  if (card.value === topCard.value) return true;
  return false;
}

function renderGame() {
  if (!gameState) return;

  // 观战者标识和侧边栏
  const specBanner = document.getElementById('spectatorBanner');
  const playerArea = document.getElementById('playerArea');
  const gameScreen = document.getElementById('gameScreen');
  const specToggle = document.getElementById('specViewToggle');

  if (isSpectator) {
    specBanner.style.display = 'flex';
    gameScreen.classList.add('spec-mode');
    if (!specSidebarOpen) gameScreen.classList.add('spec-sidebar-collapsed');
    specToggle.style.display = '';
    playerArea.style.display = '';
    renderSpectatorMainView();
  } else {
    specBanner.style.display = 'none';
    gameScreen.classList.remove('spec-mode');
    gameScreen.classList.remove('spec-sidebar-collapsed');
    specToggle.style.display = 'none';
    document.getElementById('spectatorSidebar').classList.remove('visible', 'collapsed');
    document.getElementById('specSidebarOpenBtn').classList.remove('visible');
    document.getElementById('specHandNav').style.display = 'none';
    playerArea.style.display = '';
    // 恢复 UNO 按钮
    const unoBtnEl = document.getElementById('unoBtn');
    if (unoBtnEl) unoBtnEl.style.display = '';
  }

  const dirEl = document.getElementById('directionIndicator');
  dirEl.className = 'direction-indicator' + (gameState.direction === -1 ? ' ccw' : '');

  const colorDot = document.getElementById('currentColorDot');
  colorDot.style.background = COLOR_CSS[gameState.currentColor] || '#888';

  const turnInfo = document.getElementById('turnInfo');
  const isMyTurn = !isSpectator && gameState.currentPlayer === myPlayerIndex;
  turnInfo.textContent = isSpectator ? '观战中 - ' + (players[gameState.currentPlayer] ? players[gameState.currentPlayer].name : '...') + ' 出牌' : (isMyTurn ? '轮到你了！' : '等待 ' + (players[gameState.currentPlayer] ? players[gameState.currentPlayer].name : '...') + ' 出牌');
  turnInfo.style.color = isMyTurn ? 'var(--success)' : 'var(--text-secondary)';

  document.getElementById('lastAction').textContent = gameState.lastAction || '';
  document.getElementById('drawPileCount').textContent = gameState.drawPileCount || 0;

  const discardEl = document.getElementById('discardPile');
  const topCard = gameState.discardPile[gameState.discardPile.length - 1];
  if (topCard) discardEl.innerHTML = renderCardHTML(topCard,'card-play-anim');

  renderOpponents();
  if (!isSpectator) renderPlayerHand();

  const unoBtn = document.getElementById('unoBtn');
  unoBtn.disabled = isSpectator || !(myCards.length <= 2 && isMyTurn);
}

function renderOpponents() {
  const area = document.getElementById('opponentsArea');
  const viewIndex = isSpectator ? specViewIndex : myPlayerIndex;
  let html = '';
  for (let i = 0; i < players.length; i++) {
    if (i === viewIndex) continue;
    const p = players[i];
    const isActive = gameState.currentPlayer === i;
    const cardCount = p.cardCount || 0;
    const maxShow = Math.min(cardCount,10);
    let cardsHtml = '';
    for (let j = 0; j < maxShow; j++) cardsHtml += '<div class="opponent-card-back"></div>';
    html += '<div class="opponent ' + (isActive ? 'active-turn' : '') + '">' +
      (p.calledUno && cardCount === 1 ? '<div class="opponent-uno-badge">UNO</div>' : '') +
      '<div class="opponent-cards">' + cardsHtml + '</div>' +
      '<div class="opponent-name" style="color:' + PLAYER_COLORS[i % 4] + '">' + p.name + '</div>' +
      '<div class="opponent-card-count">' + cardCount + ' 张</div>' +
    '</div>';
  }
  area.innerHTML = html;
}

function renderPlayerHand() {
  const handEl = document.getElementById('playerHand');
  const isMyTurn = gameState.currentPlayer === myPlayerIndex;

  let html = '';
  myCards.forEach(function(card,index){
    const playable = isMyTurn && canPlayCard(card);
    const cls = playable ? 'playable' : 'not-playable';
    html += '<div class="card-wrap" onclick="' + (playable ? 'playCard(' + index + ')' : '') + '">' +
      renderCardHTML(card,cls + ' card-draw-anim') +
    '</div>';
  });
  handEl.innerHTML = html;
}

/* ============ 观战者功能 ============ */

function collapseSpectatorSidebar() {
  const sidebar = document.getElementById('spectatorSidebar');
  const openBtn = document.getElementById('specSidebarOpenBtn');
  const gameScreen = document.getElementById('gameScreen');
  specSidebarOpen = false;
  if (!sidebar.classList.contains('visible')) sidebar.classList.add('visible');
  sidebar.classList.add('collapsed');
  openBtn.classList.add('visible');
  gameScreen.classList.add('spec-sidebar-collapsed');
}

function expandSpectatorSidebar() {
  const sidebar = document.getElementById('spectatorSidebar');
  const openBtn = document.getElementById('specSidebarOpenBtn');
  const gameScreen = document.getElementById('gameScreen');
  specSidebarOpen = true;
  if (!sidebar.classList.contains('visible')) sidebar.classList.add('visible');
  sidebar.classList.remove('collapsed');
  openBtn.classList.remove('visible');
  gameScreen.classList.remove('spec-sidebar-collapsed');
}

function toggleSpectatorSidebar() {
  if (specSidebarOpen) {
    collapseSpectatorSidebar();
  } else {
    expandSpectatorSidebar();
  }
}

function specNavPrev() {
  if (!isSpectator || players.length === 0) return;
  specViewIndex = (specViewIndex - 1 + players.length) % players.length;
  renderGame();
  renderSpectatorSidebar();
}

function specNavNext() {
  if (!isSpectator || players.length === 0) return;
  specViewIndex = (specViewIndex + 1) % players.length;
  renderGame();
  renderSpectatorSidebar();
}

function switchSpecView(index) {
  specViewIndex = index;
  renderGame();
  renderSpectatorSidebar();
}

function renderSpectatorSidebar() {
  if (!isSpectator || !gameState) return;
  const sidebar = document.getElementById('spectatorSidebar');
  const body = document.getElementById('spectatorSidebarBody');

  // 确保侧边栏可见
  if (!sidebar.classList.contains('visible')) sidebar.classList.add('visible');
  if (specSidebarOpen) {
    sidebar.classList.remove('collapsed');
  } else {
    sidebar.classList.add('collapsed');
  }

  let html = '';
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const isActive = gameState.currentPlayer === i;
    const isSelected = specViewIndex === i;
    const cards = specAllCards[i] || [];

    html += '<div class="spec-player-section">';
    html += '<div class="spec-player-header' + (isSelected ? ' selected' : '') + (isActive ? ' active-turn' : '') + '" onclick="switchSpecView(' + i + ')">';
    html += '<div class="spec-player-avatar" style="background:' + PLAYER_COLORS[i % 4] + '">' + p.name[0] + '</div>';
    html += '<div class="spec-player-name">' + p.name + '</div>';
    html += '<div class="spec-player-count">' + (p.cardCount || cards.length) + '张</div>';
    html += '<div class="spec-player-active-dot"></div>';
    html += '</div>';

    // 始终显示该玩家手牌
    html += '<div class="spec-player-cards">';
    cards.forEach(function(card) {
      html += renderCardHTML(card, '');
    });
    html += '</div>';

    html += '</div>';
  }
  body.innerHTML = html;
}

function renderSpectatorMainView() {
  if (!isSpectator || !gameState) return;
  // 显示视角切换导航
  const navEl = document.getElementById('specHandNav');
  navEl.style.display = 'flex';
  const navLabel = document.getElementById('specNavLabel');
  const pName = players[specViewIndex] ? players[specViewIndex].name : '';
  navLabel.textContent = pName + ' 的视角';

  // 以 specViewIndex 视角渲染手牌区域
  const handEl = document.getElementById('playerHand');
  const cards = specAllCards[specViewIndex] || [];
  const isMyTurn = gameState.currentPlayer === specViewIndex;

  // 更新观战横幅
  const specBanner = document.getElementById('spectatorBanner');
  specBanner.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>' +
    '<span>观战 - ' + pName + '</span>';

  let html = '';
  cards.forEach(function(card, index) {
    const playable = isMyTurn && canPlayCard(card);
    const cls = playable ? 'playable' : 'not-playable';
    html += '<div class="card-wrap">' +
      renderCardHTML(card, cls + ' card-draw-anim') +
    '</div>';
  });
  handEl.innerHTML = html;

  // 隐藏 UNO 按钮（观战者不能操作）
  const unoBtn = document.getElementById('unoBtn');
  unoBtn.style.display = 'none';
}

function showEndScreen(data) {
  document.getElementById('endTitle').textContent = '游戏结束';
  document.getElementById('endWinner').textContent = (data.winner || '未知') + ' 获胜！';
  document.getElementById('endWinner').style.cssText = '';

  const scoresEl = document.getElementById('endScores');
  const rankings = data.rankings || data.scores || [];
  scoresEl.innerHTML = rankings.map(function(s,i){
    const rank = s.rank || (i + 1);
    const isWinner = s.isWinner || rank === 1;
    const isMe = myName && s.name === myName;
    const cardsLeft = s.cardsLeft !== undefined ? s.cardsLeft : s.cardCount || 0;
    const avatarColor = PLAYER_COLORS[i % 4];
    return '<div class="end-score-item">' +
      '<span class="end-rank" style="color:' + (isWinner ? 'var(--warning)' : 'var(--text-secondary)') + '">#' + rank + '</span>' +
      '<div style="width:32px;height:32px;border-radius:50%;background:' + avatarColor + ';display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:13px;flex-shrink:0">' + (s.name ? s.name[0] : '?') + '</div>' +
      '<span class="end-score-name">' + s.name + '</span>' +
      (isMe ? '<span class="end-score-me">我</span>' : '') +
      '<span class="end-score-cards">' + cardsLeft + ' 张</span>' +
    '</div>';
  }).join('');

  showScreen('endScreen');
}

function playAgain() {
  sendToServer({type:'startGame'});
  showScreen('lobbyScreen');
}

function backToStart() {
  cleanup();
  showScreen('startScreen');
}

function cleanup() {
  if (ws) { try { ws.close(); } catch(e){} ws = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
  isHost = false;
  isSpectator = false;
  gameState = null;
  players = [];
  myCards = [];
  myPlayerIndex = -1;
  pendingWildCard = null;
  myId = '';
  roomCode = '';
  reconnectAttempts = 0;
  specViewIndex = 0;
  specAllCards = {};
  specSidebarOpen = true;
  // 隐藏观战者 UI
  document.getElementById('spectatorSidebar').classList.remove('visible', 'collapsed');
  document.getElementById('specSidebarOpenBtn').classList.remove('visible');
  document.getElementById('specViewToggle').classList.remove('active');
  document.getElementById('specViewToggle').style.display = 'none';
  document.getElementById('gameScreen').classList.remove('spec-mode');
  document.getElementById('gameScreen').classList.remove('spec-sidebar-collapsed');
  document.getElementById('specHandNav').style.display = 'none';
  const unoBtn = document.getElementById('unoBtn');
  if (unoBtn) unoBtn.style.display = '';
  updateConnectionStatus('disconnected','未连接');
}

function copyRoomLink() {
  if (!roomCode) return;
  const url = location.origin + location.pathname + '?room=' + encodeURIComponent(roomCode);
  navigator.clipboard.writeText(url).then(function(){
    const btn = document.getElementById('copyLinkText');
    const old = btn.textContent;
    btn.textContent = '已复制！';
    setTimeout(function(){ btn.textContent = old; }, 1500);
  }).catch(function(){
    showToast('复制失败，请手动复制房间代码','error');
  });
}

function getUrlParam(name) {
  return new URLSearchParams(location.search).get(name);
}

document.addEventListener('DOMContentLoaded', async function(){
  document.getElementById('joinRoomCode').addEventListener('keydown',function(e){
    if (e.key === 'Enter') document.getElementById('joinNickname').focus();
  });
  document.getElementById('joinNickname').addEventListener('keydown',function(e){
    if (e.key === 'Enter') joinRoom();
  });
  document.getElementById('createNickname').addEventListener('keydown',function(e){
    if (e.key === 'Enter') createRoom();
  });

  // 检查登录状态（预填用户名依赖此结果）
  await checkAuth();

  // 更新开始界面提示
  const startHint = document.getElementById('startHint');
  if (startHint) {
    startHint.textContent = loggedInUser
      ? '已登录：' + loggedInUser
      : (UNO_CONFIG.authCheckUrl ? '创建房间需要登录，加入房间无需登录' : '免登录 · 填个昵称即可创建房间');
  }

  // 登录后跳转回来时自动展开创建房间界面
  const urlAction = getUrlParam('action');
  if (urlAction === 'create') {
    showCreateScreen();
    return;
  }

  // 通过链接分享的房间代码，自动填入并跳转加入界面
  const urlRoom = getUrlParam('room');
  if (urlRoom && /^[A-Z0-9]{6}$/i.test(urlRoom)) {
    document.getElementById('joinRoomCode').value = urlRoom.toUpperCase();
    showJoinScreen();
  }
});
