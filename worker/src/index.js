function generateId() {
  return Math.random().toString(36).substring(2, 10);
}

const DISCONNECT_TIMEOUT = 30000; // 断线30秒后移除

export class UnoRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.players = [];
    this.gameState = null;
    this.hostId = null;
    this.roomCode = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 400 });
    }

    const playerId = url.searchParams.get('id') || generateId();
    const playerName = url.searchParams.get('name') || '玩家';
    const isSpectator = url.searchParams.get('spectator') === '1';
    this.roomCode = url.searchParams.get('room') || this.roomCode;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // 重连：已有同 id 的 session
    const existingSession = this.sessions.get(playerId);
    if (existingSession) {
      clearTimeout(existingSession.disconnectTimer);
      existingSession.ws = server;
      existingSession.disconnected = false;
      this.handleReconnect(server, playerId);
      return new Response(null, { status: 101, webSocket: client });
    }

    // 游戏进行中加入 -> 观战者
    const spectating = isSpectator || (this.gameState !== null);

    this.sessions.set(playerId, {
      ws: server, name: playerName, cards: [], calledUno: false,
      isSpectator: spectating, disconnected: false, disconnectTimer: null
    });

    if (!spectating) {
      if (this.players.length === 0) this.hostId = playerId;
      this.players.push({ id: playerId, name: playerName });
    }

    this.handleSession(server, playerId, spectating);
    return new Response(null, { status: 101, webSocket: client });
  }

  handleSession(ws, playerId, isSpectator) {
    ws.accept();
    const session = this.sessions.get(playerId);

    if (isSpectator) {
      this.send(ws, { type: 'assigned', id: playerId, isHost: false, isSpectator: true });
      this.broadcastToast(session.name + ' 加入观战', 'info');
      // 立即同步游戏状态给观战者
      if (this.gameState) {
        this.sendSpectatorState(ws);
      }
    } else {
      this.send(ws, { type: 'assigned', id: playerId, isHost: playerId === this.hostId, isSpectator: false });
      this.broadcastLobbyUpdate();
      if (this.gameState && session.cards.length > 0) {
        this.broadcastGameState();
      }
      if (session) this.broadcastToast(session.name + ' 加入了房间', 'success');
    }

    ws.addEventListener('message', (event) => {
      try { this.handleMessage(playerId, JSON.parse(event.data)); } catch (e) {}
    });
    ws.addEventListener('close', () => { this.handleDisconnect(playerId); });
    ws.addEventListener('error', () => { this.handleDisconnect(playerId); });
  }

  handleReconnect(ws, playerId) {
    ws.accept();
    const session = this.sessions.get(playerId);
    const isSpectator = session.isSpectator;

    this.send(ws, { type: 'assigned', id: playerId, isHost: playerId === this.hostId, isSpectator: isSpectator, isReconnect: true });
    this.broadcastToast(session.name + ' 重新连接', 'success');

    if (isSpectator) {
      if (this.gameState) this.sendSpectatorState(ws);
    } else {
      this.broadcastLobbyUpdate();
      if (this.gameState) {
        this.broadcastGameState();
      }
    }

    ws.addEventListener('message', (event) => {
      try { this.handleMessage(playerId, JSON.parse(event.data)); } catch (e) {}
    });
    ws.addEventListener('close', () => { this.handleDisconnect(playerId); });
    ws.addEventListener('error', () => { this.handleDisconnect(playerId); });
  }

  handleMessage(playerId, data) {
    if (data.type === 'ping') {
      this.send(this.sessions.get(playerId)?.ws, { type: 'pong' });
      return;
    }
    // 观战者不能操作
    const session = this.sessions.get(playerId);
    if (session && session.isSpectator) return;

    switch (data.type) {
      case 'startGame': if (playerId === this.hostId) this.startGame(); break;
      case 'playCard': this.handlePlayCard(playerId, data); break;
      case 'drawCard': this.handleDrawCard(playerId); break;
      case 'callUno': this.handleCallUno(playerId); break;
      case 'chooseColor': this.handleChooseColor(playerId, data.color); break;
    }
  }

  handleDisconnect(playerId) {
    const session = this.sessions.get(playerId);
    if (!session || session.disconnected) return;
    session.disconnected = true;

    // 观战者直接移除
    if (session.isSpectator) {
      this.sessions.delete(playerId);
      return;
    }

    // 游戏中玩家：保留30秒等待重连
    if (this.gameState) {
      this.broadcastToast(session.name + ' 断开连接，等待重连...', 'warning');
      session.disconnectTimer = setTimeout(() => {
        this.removePlayer(playerId);
      }, DISCONNECT_TIMEOUT);
      return;
    }

    // 大厅中断开，直接移除
    this.removePlayer(playerId);
  }

  removePlayer(playerId) {
    const session = this.sessions.get(playerId);
    if (!session) return;
    const name = session.name;
    clearTimeout(session.disconnectTimer);
    this.sessions.delete(playerId);

    // 记录移除前的索引，用于修正 currentPlayer
    const removedIndex = this.players.findIndex(p => p.id === playerId);
    this.players = this.players.filter(p => p.id !== playerId);
    if (this.players.length === 0) return;

    if (playerId === this.hostId) {
      if (this.gameState) {
        this.broadcast({ type: 'gameEnded', reason: '房主退出了游戏' });
        this.gameState = null;
      } else {
        this.hostId = this.players[0].id;
        const newHost = this.sessions.get(this.hostId);
        if (newHost) this.send(newHost.ws, { type: 'assigned', id: this.hostId, isHost: true });
      }
    }

    this.broadcastToast(name + ' 离开了房间', 'warning');
    this.broadcastLobbyUpdate();

    if (this.gameState) {
      // 修正 currentPlayer 索引
      this.fixCurrentPlayerIndex(removedIndex);
      // 如果移除的玩家正好是当前出牌者，推进回合
      if (removedIndex === this.gameState.currentPlayer ||
          this.gameState.currentPlayer >= this.players.length) {
        this.gameState.currentPlayer = this.gameState.currentPlayer % this.players.length;
        this.advanceTurn();
      }
      this.broadcastGameState();
      this.broadcastSpectatorState();
    }
  }

  fixCurrentPlayerIndex(removedIndex) {
    if (!this.gameState) return;
    if (removedIndex < this.gameState.currentPlayer) {
      // 被移除的玩家在当前玩家前面，索引需减1
      this.gameState.currentPlayer--;
    }
    // 确保索引不越界
    if (this.gameState.currentPlayer >= this.players.length) {
      this.gameState.currentPlayer = 0;
    }
    if (this.gameState.currentPlayer < 0) {
      this.gameState.currentPlayer = this.players.length - 1;
    }
  }

  broadcastLobbyUpdate() {
    const info = this.players.map(p => ({ name: p.name, isHost: p.id === this.hostId }));
    this.sessions.forEach((s, id) => {
      if (s.isSpectator) return;
      this.send(s.ws, { type: 'lobbyUpdate', players: info, yourIndex: this.players.findIndex(p => p.id === id), isHost: id === this.hostId });
    });
  }

  startGame() {
    if (this.players.length < 2) return;
    const COLORS = ['red','yellow','green','blue'], SP = ['skip','reverse','draw2'];
    let deck = [];
    for (const c of COLORS) { deck.push({color:c,value:'0'}); for(let n=1;n<=9;n++){deck.push({color:c,value:String(n)});deck.push({color:c,value:String(n)});} for(const s of SP){deck.push({color:c,value:s});deck.push({color:c,value:s});} }
    for(let i=0;i<4;i++){deck.push({color:'wild',value:'wild'});deck.push({color:'wild',value:'wild4'});}
    for(let i=deck.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[deck[i],deck[j]]=[deck[j],deck[i]];}
    for(let r=0;r<7;r++){this.players.forEach(p=>{this.sessions.get(p.id).cards.push(deck.pop());});}
    let first=deck.pop();
    while(first.color==='wild'){deck.unshift(first);for(let i=deck.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[deck[i],deck[j]]=[deck[j],deck[i]];}first=deck.pop();}
    this.gameState={currentPlayer:0,direction:1,currentColor:first.color,discardPile:[first],drawPile:deck,lastAction:null};
    this.applyFirstCardEffect(first);
    this.broadcast({type:'gameStarted'});
    this.broadcastGameState();
    this.broadcastSpectatorState();
  }

  applyFirstCardEffect(card) {
    if(card.value==='skip'){this.advanceTurn();this.gameState.lastAction=this.players[0].name+' 被跳过';}
    else if(card.value==='reverse'){this.gameState.direction*=-1;if(this.players.length===2)this.advanceTurn();this.gameState.lastAction='方向反转';}
    else if(card.value==='draw2'){this.drawCards(this.players[0].id,2);this.advanceTurn();this.gameState.lastAction=this.players[0].name+' 摸了2张牌';}
  }

  handlePlayCard(playerId, data) {
    if(!this.gameState)return;
    if(this.players[this.gameState.currentPlayer].id!==playerId)return;
    const s=this.sessions.get(playerId);if(!s)return;
    const ci=data.cardIndex;if(ci===undefined||ci<0||ci>=s.cards.length)return;
    const card=s.cards[ci];if(!this.canPlayCard(card))return;
    if(card.color==='wild'&&!data.chosenColor){this.send(s.ws,{type:'chooseColorRequest'});s.pendingWildCard={cardIndex:ci,card};return;}
    this.executePlayCard(playerId,ci,card,data.chosenColor);
  }

  executePlayCard(playerId, ci, card, chosenColor) {
    const s=this.sessions.get(playerId);s.cards.splice(ci,1);
    this.gameState.currentColor=card.color==='wild'?chosenColor:card.color;
    this.gameState.discardPile.push(card);
    this.gameState.lastAction=s.name+' 出了 '+this.describeCard(card);
    if(s.cards.length===0){this.broadcastGameState();this.broadcastSpectatorState();this.broadcast({type:'gameOver',winner:s.name,winnerId:playerId,rankings:this.getRankings(playerId)});this.broadcastSpectators({type:'gameOver',winner:s.name,winnerId:playerId,rankings:this.getRankings(playerId)});this.gameState=null;return;}
    if(s.cards.length===1&&!s.calledUno){this.drawCards(playerId,2);this.gameState.lastAction+=' (未喊UNO，罚摸2张)';}
    s.calledUno=false;this.applyCardEffect(card,s.name);this.advanceTurn();this.broadcastGameState();this.broadcastSpectatorState();
  }

  handleChooseColor(playerId, color) {
    const s=this.sessions.get(playerId);if(!s||!s.pendingWildCard)return;
    const{cardIndex:ci,card}=s.pendingWildCard;s.pendingWildCard=null;this.executePlayCard(playerId,ci,card,color);
  }

  applyCardEffect(card, pn) {
    const ni=this.getNextPlayerIndex();
    if(card.value==='skip'){this.advanceTurn();this.gameState.lastAction=this.players[this.gameState.currentPlayer].name+' 被跳过';}
    else if(card.value==='reverse'){this.gameState.direction*=-1;if(this.players.length===2)this.advanceTurn();this.gameState.lastAction='方向反转';}
    else if(card.value==='draw2'){const t=this.players[ni];this.drawCards(t.id,2);this.advanceTurn();this.gameState.lastAction=t.name+' 摸了2张牌并被跳过';}
    else if(card.value==='wild4'){const t=this.players[ni];this.drawCards(t.id,4);this.advanceTurn();this.gameState.lastAction=t.name+' 摸了4张牌并被跳过';}
  }

  handleDrawCard(playerId) {
    if(!this.gameState)return;if(this.players[this.gameState.currentPlayer].id!==playerId)return;
    this.drawCards(playerId,1);this.gameState.lastAction=this.sessions.get(playerId).name+' 摸了1张牌';this.advanceTurn();this.broadcastGameState();this.broadcastSpectatorState();
  }

  handleCallUno(playerId) {
    const s=this.sessions.get(playerId);if(!s)return;s.calledUno=true;this.broadcastToast(s.name+' 喊了 UNO!','warning');this.broadcastGameState();this.broadcastSpectatorState();
  }

  canPlayCard(card){const t=this.gameState.discardPile[this.gameState.discardPile.length-1];if(card.color==='wild')return true;if(card.color===this.gameState.currentColor)return true;if(card.value===t.value)return true;return false;}

  drawCards(playerId,count){const s=this.sessions.get(playerId);if(!s)return;for(let i=0;i<count;i++){if(this.gameState.drawPile.length===0)this.reshuffleDrawPile();if(this.gameState.drawPile.length>0)s.cards.push(this.gameState.drawPile.pop());}}

  reshuffleDrawPile(){if(this.gameState.discardPile.length<=1)return;const top=this.gameState.discardPile.pop();const cards=this.gameState.discardPile;for(let i=cards.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[cards[i],cards[j]]=[cards[j],cards[i]];}this.gameState.drawPile=cards;this.gameState.discardPile=[top];}

  advanceTurn(){if(!this.gameState||this.players.length===0)return;this.gameState.currentPlayer=this.getNextPlayerIndex();}
  getNextPlayerIndex(){const n=(this.gameState.currentPlayer+this.gameState.direction+this.players.length)%this.players.length;return n<0?n+this.players.length:n;}

  describeCard(card){const CN={red:'红色',yellow:'黄色',green:'绿色',blue:'蓝色'},VN={skip:'跳过',reverse:'反转',draw2:'+2',wild:'万能',wild4:'+4'};return(card.color==='wild'?'':CN[card.color]||'')+(VN[card.value]||card.value);}

  getRankings(winnerId){const r=this.players.map(p=>({name:this.sessions.get(p.id)?.name||p.name,cardsLeft:this.sessions.get(p.id)?.cards.length||0,isWinner:p.id===winnerId}));r.sort((a,b)=>a.cardsLeft-b.cardsLeft);return r;}

  broadcastGameState(){
    if(!this.gameState)return;
    this.sessions.forEach((s,id)=>{
      if(s.isSpectator) return;
      const pi=this.players.findIndex(p=>p.id===id);
      if(pi===-1)return;
      this.send(s.ws,{
        type:'gameStateUpdate',
        gameState:{currentPlayer:this.gameState.currentPlayer,direction:this.gameState.direction,currentColor:this.gameState.currentColor,discardPile:this.gameState.discardPile,drawPileCount:this.gameState.drawPile.length,lastAction:this.gameState.lastAction},
        yourCards:s.cards,
        playersInfo:this.players.map(p=>({name:p.name,cardCount:this.sessions.get(p.id)?.cards.length||0,calledUno:this.sessions.get(p.id)?.calledUno||false})),
        yourIndex:pi
      });
    });
  }

  sendSpectatorState(ws){
    if(!this.gameState)return;
    this.send(ws,{
      type:'spectatorStateUpdate',
      gameState:{currentPlayer:this.gameState.currentPlayer,direction:this.gameState.direction,currentColor:this.gameState.currentColor,discardPile:this.gameState.discardPile,drawPileCount:this.gameState.drawPile.length,lastAction:this.gameState.lastAction},
      playersInfo:this.players.map(p=>({name:p.name,cardCount:this.sessions.get(p.id)?.cards.length||0,calledUno:this.sessions.get(p.id)?.calledUno||false,cards:this.sessions.get(p.id)?.cards||[]}))
    });
  }

  broadcastSpectatorState(){
    this.sessions.forEach((s)=>{
      if(!s.isSpectator) return;
      this.sendSpectatorState(s.ws);
    });
  }

  broadcastSpectators(msg){
    const d=JSON.stringify(msg);
    this.sessions.forEach(s=>{
      if(s.isSpectator) try{s.ws.send(d);}catch(e){}
    });
  }

  broadcast(msg){const d=JSON.stringify(msg);this.sessions.forEach(s=>{if(!s.isSpectator)try{s.ws.send(d);}catch(e){}});}
  broadcastToast(message,toastType){this.broadcast({type:'toast',message,toastType});this.broadcastSpectators({type:'toast',message,toastType});}
  send(ws,msg){try{ws.send(JSON.stringify(msg));}catch(e){}}
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    // WebSocket 升级
    if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      const roomCode = url.searchParams.get('room');
      if (!roomCode || roomCode.length < 4) {
        return new Response('Missing or invalid room code', { status: 400 });
      }
      const id = env.UNO_ROOM.idFromName(roomCode);
      const roomObj = env.UNO_ROOM.get(id);
      return roomObj.fetch(request);
    }

    // 健康检查
    if (url.pathname === '/') {
      return new Response('UNO Game Server OK', { headers: { 'Access-Control-Allow-Origin': '*' } });
    }

    return new Response('Not Found', { status: 404 });
  }
};
