const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

// 游戏常量
const MAX_PLAYER = 4;
const CARD_TYPES = ["sun", "moon", "star"];
const CARD_NAME_MAP = { sun: "太阳", moon: "月亮", star: "星星", joker: "魔术师", devil: "恶魔" };

let gameState = {
  players: [],
  gameMode: null,   // "dice" 骰子 / "card" 卡牌 / null 未开局
  currentBid: null, // 骰子模式：[数量, 点数]
  turnIndex: 0,
  gameOver: false,
  targetCard: null, // 卡牌模式：本局目标牌
  lastPlay: null    // 卡牌模式：{ playerIdx, cards } 上家打出的牌
};

// ========== 工具函数 ==========

function createDice() {
  return Array.from({ length: 5 }, () => Math.floor(Math.random() * 6) + 1);
}

// 构造一副牌：太阳6 月亮6 星星6 + 魔术师2
function buildDeck() {
  const deck = [];
  for (let i = 0; i < 6; i++) deck.push("sun");
  for (let i = 0; i < 6; i++) deck.push("moon");
  for (let i = 0; i < 6; i++) deck.push("star");
  deck.push("joker");
  deck.push("joker");
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function generateCardHand() {
  return buildDeck().slice(0, 5);
}

function aliveCount() {
  return gameState.players.filter(p => p.alive).length;
}

function getAllDice() {
  const arr = [];
  gameState.players.forEach(p => { if (p.alive) arr.push(...p.dice); });
  return arr;
}

// 骰子报价校验，1 百搭
function checkDiceBid(bidCnt, bidFace) {
  const all = getAllDice();
  let total = 0;
  all.forEach(d => { if (d === 1 || d === bidFace) total++; });
  return total >= bidCnt;
}

// 报价递增校验
function isValidBid(oldCnt, oldFace, newCnt, newFace) {
  if (newCnt > oldCnt) return true;
  if (newCnt === oldCnt && newFace > oldFace) return true;
  return false;
}

// 卡牌出牌校验：恶魔单出合法；其余须为目标牌或魔术师
function checkCardPlay(playedCards, target) {
  const hasDevil = playedCards.includes("devil");
  if (hasDevil && playedCards.length !== 1) {
    return { valid: false, reason: "恶魔牌只能单独一张打出" };
  }
  if (hasDevil) return { valid: true, isDevil: true };
  for (const c of playedCards) {
    if (c !== target && c !== 'joker') {
      return { valid: false, reason: "手牌含有非目标牌，撒谎!" };
    }
  }
  return { valid: true, isDevil: false };
}

// 俄罗斯轮盘：6 弹仓 1 实弹
function roulette(victimIdx) {
  const bulletPos = Math.floor(Math.random() * 6);
  const isShot = bulletPos === 0;
  if (isShot) gameState.players[victimIdx].alive = false;
  if (aliveCount() <= 1) gameState.gameOver = true;
  return { isShot, victimIdx };
}

// 下一位存活玩家下标（从 fromIdx 之后找）
function nextAliveIdx(fromIdx) {
  const n = gameState.players.length;
  let idx = (fromIdx + 1) % n;
  for (let step = 0; step < n; step++) {
    if (gameState.players[idx].alive) return idx;
    idx = (idx + 1) % n;
  }
  return -1; // 全员阵亡
}

// 上一位存活玩家下标（质疑对象）
function prevAliveIdx(fromIdx) {
  const n = gameState.players.length;
  let idx = (fromIdx - 1 + n) % n;
  for (let step = 0; step < n; step++) {
    if (gameState.players[idx].alive) return idx;
    idx = (idx - 1 + n) % n;
  }
  return -1;
}

function nextTurn() {
  if (gameState.gameOver || aliveCount() <= 1) return;
  const nx = nextAliveIdx(gameState.turnIndex);
  if (nx >= 0) gameState.turnIndex = nx;
}

// 检查是否分出胜负，返回是否已结束
function checkGameOver() {
  if (aliveCount() <= 1) {
    gameState.gameOver = true;
    const win = gameState.players.find(p => p.alive);
    if (win) io.emit('msg', `🎉 游戏结束！${win.name}获胜！`);
    else io.emit('msg', '🎉 全员阵亡，本局平局');
    return true;
  }
  return false;
}

// 开启新一轮卡牌：随机目标牌 + 存活玩家重发 5 张
function startNewCardRound() {
  const t = CARD_TYPES[Math.floor(Math.random() * 3)];
  gameState.targetCard = t;
  gameState.lastPlay = null;
  gameState.currentBid = null;
  gameState.players.forEach(p => { if (p.alive) p.cards = generateCardHand(); });
  io.emit('newCardRound', { target: t });
  gameState.players.forEach(p => {
    if (p.alive) {
      const s = io.sockets.sockets.get(p.id);
      if (s) s.emit('myCards', p.cards);
    }
  });
}

// ========== Socket 事件 ==========

io.on('connection', (socket) => {
  console.log("玩家连接", socket.id);

  // 加入房间
  socket.on('join', (name) => {
    if (gameState.players.length >= MAX_PLAYER) {
      socket.emit('msg', "房间已满，最多4人");
      return;
    }
    const cleanName = String(name || '').trim().slice(0, 8) || '匿名';
    if (gameState.players.some(p => p.id === socket.id)) return;
    gameState.players.push({
      id: socket.id,
      name: cleanName,
      dice: [],
      cards: [],
      alive: true
    });
    io.emit('msg', `【${cleanName}】加入游戏`);
    io.emit('state', gameState);
  });

  // 开局选择模式（需 >=2 人）
  socket.on('startGame', (mode) => {
    if (mode !== 'dice' && mode !== 'card') return;
    if (gameState.players.length < 2) {
      socket.emit('msg', "至少2人才能开局");
      return;
    }
    if (gameState.gameMode) {
      socket.emit('msg', "本局已开始，等待本局结束");
      return;
    }
    gameState.gameMode = mode;
    gameState.turnIndex = 0;
    gameState.gameOver = false;
    gameState.currentBid = null;
    gameState.lastPlay = null;
    gameState.targetCard = null;

    if (mode === 'dice') {
      gameState.players.forEach(p => { if (p.alive) p.dice = createDice(); });
      gameState.players.forEach(p => {
        const s = io.sockets.sockets.get(p.id);
        if (s) s.emit('myDice', p.dice);
      });
      io.emit('msg', "🎲 骰子模式开始！每人5颗骰子");
    } else {
      startNewCardRound();
      io.emit('msg', "🃏 卡牌模式开始！太阳月亮星星恶魔");
    }
    io.emit('state', gameState);
  });

  // 骰子模式：报价
  socket.on('bid', (cnt, face) => {
    if (gameState.gameMode !== 'dice' || gameState.gameOver) return;
    const idx = gameState.players.findIndex(p => p.id === socket.id);
    if (idx < 0 || idx !== gameState.turnIndex) return;
    const p = gameState.players[idx];
    if (!p.alive) return;
    cnt = parseInt(cnt, 10);
    face = parseInt(face, 10);
    if (!(cnt >= 1 && cnt <= 30) || !(face >= 1 && face <= 6)) {
      socket.emit('msg', "报价不合法");
      return;
    }
    const old = gameState.currentBid;
    if (old && !isValidBid(old[0], old[1], cnt, face)) {
      socket.emit('msg', "报价不合法！必须大于上一轮");
      return;
    }
    gameState.currentBid = [cnt, face];
    io.emit('msg', `${p.name} 报价：${cnt} 个 ${face}`);
    nextTurn();
    io.emit('state', gameState);
  });

  // 骰子模式：质疑
  socket.on('doubt', () => {
    if (gameState.gameMode !== 'dice' || gameState.gameOver) return;
    const idx = gameState.players.findIndex(p => p.id === socket.id);
    if (idx < 0 || idx !== gameState.turnIndex) return;
    const p = gameState.players[idx];
    if (!p.alive) return;
    if (!gameState.currentBid) {
      socket.emit('msg', "还没有报价，无法质疑");
      return;
    }
    const [bc, bf] = gameState.currentBid;
    const ok = checkDiceBid(bc, bf);
    let victim;
    if (ok) {
      victim = idx;
      io.emit('msg', `${p.name} 质疑失败！触发轮盘`);
    } else {
      victim = prevAliveIdx(idx);
      if (victim < 0) { socket.emit('msg', "找不到上家"); return; }
      io.emit('msg', `抓到骗子！${gameState.players[victim].name}触发轮盘`);
    }
    const res = roulette(victim);
    if (res.isShot) io.emit('msg', `💥 中弹！${gameState.players[res.victimIdx].name}出局！`);
    else io.emit('msg', `✅ 空枪！${gameState.players[res.victimIdx].name}侥幸存活`);
    gameState.currentBid = null;
    checkGameOver();
    if (!gameState.gameOver) nextTurn();
    io.emit('state', gameState);
  });

  // 卡牌模式：出牌（带服务端校验 + 扣牌）
  socket.on('playCards', (cardList) => {
    if (gameState.gameMode !== 'card' || gameState.gameOver) return;
    const idx = gameState.players.findIndex(p => p.id === socket.id);
    if (idx < 0 || idx !== gameState.turnIndex) return;
    const p = gameState.players[idx];
    if (!p.alive) return;
    if (!Array.isArray(cardList) || cardList.length < 1 || cardList.length > 3) {
      socket.emit('msg', "每次出牌 1~3 张（恶魔只能单出）");
      return;
    }
    // 校验手牌持有并扣牌
    const hand = p.cards.slice();
    for (const c of cardList) {
      const pos = hand.indexOf(c);
      if (pos < 0) {
        socket.emit('msg', "你手里没有这张牌");
        return;
      }
      hand.splice(pos, 1);
    }
    p.cards = hand;
    gameState.lastPlay = { playerIdx: idx, cards: cardList.slice() };
    io.emit('msg', `${p.name} 暗着打出了 ${cardList.length} 张牌，请下家选择相信或质疑`);
    nextTurn();
    io.emit('state', gameState);
  });

  // 卡牌模式：质疑上家
  socket.on('doubtCard', () => {
    if (gameState.gameMode !== 'card' || gameState.gameOver) return;
    const idx = gameState.players.findIndex(p => p.id === socket.id);
    if (idx < 0 || idx !== gameState.turnIndex) return;
    const p = gameState.players[idx];
    if (!p.alive) return;
    const last = gameState.lastPlay;
    if (!last) { socket.emit('msg', "上家还没有出牌"); return; }
    const lastPlayerIdx = last.playerIdx;
    const played = last.cards;

    io.emit('revealCards', { playerIdx: lastPlayerIdx, cards: played });
    const checkRes = checkCardPlay(played, gameState.targetCard);
    if (checkRes.valid) {
      if (checkRes.isDevil) {
        // 恶魔牌：除出牌者外所有存活玩家扣扳机
        io.emit('msg', '🔥 恶魔牌生效！除出牌者外所有存活玩家触发轮盘！');
        gameState.players.forEach((pl, i) => {
          if (pl.alive && i !== lastPlayerIdx) {
            const r = roulette(i);
            if (r.isShot) io.emit('msg', `💥 ${pl.name} 中弹出局！`);
            else io.emit('msg', `✅ ${pl.name} 空枪存活`);
          }
        });
      } else {
        // 出牌属实，质疑者受罚
        io.emit('msg', `✅ 出牌属实，质疑失败！${p.name} 扣动扳机`);
        const res = roulette(idx);
        if (res.isShot) io.emit('msg', `💥 ${p.name} 中弹出局！`);
        else io.emit('msg', `✅ 空枪！${p.name} 侥幸存活`);
      }
    } else {
      // 出牌者撒谎
      io.emit('msg', `❌ 撒谎！${gameState.players[lastPlayerIdx].name} 触发轮盘`);
      const res = roulette(lastPlayerIdx);
      if (res.isShot) io.emit('msg', `💥 ${gameState.players[lastPlayerIdx].name} 中弹出局！`);
      else io.emit('msg', `✅ 空枪！${gameState.players[lastPlayerIdx].name} 侥幸存活`);
    }
    if (checkGameOver()) {
      io.emit('state', gameState);
      return;
    }
    // 重开新一轮
    startNewCardRound();
    io.emit('msg', '🃏 新一轮发牌，目标牌已更新');
    io.emit('state', gameState);
  });

  // 卡牌模式：相信上家（出牌权交给相信者，由他出牌）
  socket.on('trustCard', () => {
    if (gameState.gameMode !== 'card' || gameState.gameOver) return;
    const idx = gameState.players.findIndex(p => p.id === socket.id);
    if (idx < 0 || idx !== gameState.turnIndex) return;
    const p = gameState.players[idx];
    if (!p.alive) return;
    if (!gameState.lastPlay) return;
    gameState.lastPlay = null;
    io.emit('msg', `${p.name} 相信了上家的牌，请继续出牌`);
    io.emit('state', gameState);
  });

  // 玩家离开
  socket.on('disconnect', () => {
    const idx = gameState.players.findIndex(p => p.id === socket.id);
    if (idx < 0) return;
    const name = gameState.players[idx].name;
    const wasTurn = idx === gameState.turnIndex;
    const wasLastPlayer = gameState.lastPlay && gameState.lastPlay.playerIdx === idx;
    gameState.players.splice(idx, 1);
    io.emit('msg', `${name} 离开了房间`);
    io.emit('state', gameState);

    if (gameState.players.length === 0) {
      // 房间清空，重置
      gameState.gameMode = null;
      gameState.currentBid = null;
      gameState.gameOver = false;
      gameState.turnIndex = 0;
      gameState.targetCard = null;
      gameState.lastPlay = null;
      io.emit('state', gameState);
      return;
    }

    // 修正 turnIndex
    if (gameState.turnIndex > idx) gameState.turnIndex -= 1;
    if (gameState.lastPlay && gameState.lastPlay.playerIdx > idx) {
      gameState.lastPlay.playerIdx -= 1;
    }
    if (wasTurn || wasLastPlayer) {
      if (gameState.gameMode && aliveCount() <= 1 && !gameState.gameOver) {
        checkGameOver();
      } else if (!gameState.gameOver) {
        nextTurn();
      }
    }
    io.emit('state', gameState);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("server run on port", PORT);
});
