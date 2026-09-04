const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static('public'));

// 游戏状态
let gameState = {
  players: [],
  currentBid: null,
  turnIndex: 0,
  gameOver: false,
  maxPlayer: 4
};

// 生成骰子 —— 每人5颗
function createDice() {
  return Array.from({ length: 5 }, () => Math.floor(Math.random() * 6) + 1);
}

// 获取所有存活骰子
function getAllDice() {
  let arr = [];
  gameState.players.forEach(p => {
    if (p.alive) arr.push(...p.dice);
  })
  return arr;
}

// 校验报价是否成立，1百搭
function checkBid(bidCnt, bidFace) {
  const all = getAllDice();
  let total = 0;
  all.forEach(d => {
    if (d === 1 || d === bidFace) total++;
  })
  return total >= bidCnt;
}

// 报价是否合法
function isValidBid(oldCnt, oldFace, newCnt, newFace) {
  if (newCnt > oldCnt) return true;
  if (newCnt === oldCnt && newFace > oldFace) return true;
  return false;
}

// 找下一个存活玩家
function nextTurn() {
  do {
    gameState.turnIndex = (gameState.turnIndex + 1) % gameState.players.length;
  } while (!gameState.players[gameState.turnIndex].alive && !gameState.gameOver);
}

// 俄罗斯轮盘
function roulette(victimIdx) {
  const bulletPos = Math.floor(Math.random() * 6);
  const isShot = bulletPos === 0;
  if (isShot) {
    gameState.players[victimIdx].alive = false;
  }
  const alive = gameState.players.filter(p => p.alive);
  if (alive.length <= 1) {
    gameState.gameOver = true;
  }
  return { isShot, victimIdx };
}

io.on('connection', (socket) => {
  console.log("玩家连接", socket.id);

  socket.on('join', (name) => {
    if (gameState.players.length >= gameState.maxPlayer) {
      socket.emit('msg', "房间已满，最多4人");
      return;
    }
    const newPlayer = {
      id: socket.id,
      name: name,
      dice: createDice(),
      alive: true
    }
    gameState.players.push(newPlayer);
    io.emit('state', gameState);
    socket.emit('myDice', newPlayer.dice);
    io.emit('msg', `【${name}】加入游戏`);
  });

  socket.on('bid', (cnt, face) => {
    const idx = gameState.players.findIndex(p => p.id === socket.id);
    if (idx !== gameState.turnIndex) return;
    const old = gameState.currentBid;
    if (old && !isValidBid(old[0], old[1], cnt, face)) {
      socket.emit('msg', "报价不合法");
      return;
    }
    gameState.currentBid = [cnt, face];
    io.emit('msg', `玩家${gameState.players[idx].name}报价：${cnt}个${face}`);
    nextTurn();
    io.emit('state', gameState);
  });

  socket.on('doubt', () => {
    const idx = gameState.players.findIndex(p => p.id === socket.id);
    if (idx !== gameState.turnIndex) return;
    const [bc, bf] = gameState.currentBid;
    const allD = getAllDice();
    const ok = checkBid(bc, bf);
    let victim;
    if (ok) {
      victim = idx;
      io.emit('msg', `玩家${gameState.players[idx].name}质疑失败！触发轮盘`);
    } else {
      victim = (idx - 1 + gameState.players.length) % gameState.players.length;
      io.emit('msg', `抓到骗子！${gameState.players[victim].name}触发轮盘`);
    }
    const res = roulette(victim);
    if (res.isShot) {
      io.emit('msg', `💥中弹！${gameState.players[res.victimIdx].name}出局！`);
    } else {
      io.emit('msg', `✅空枪！${gameState.players[res.victimIdx].name}侥幸存活`);
    }
    if (gameState.gameOver) {
      const win = gameState.players.find(p => p.alive);
      io.emit('msg', `🎉游戏结束！${win.name}获胜！`);
    }
    gameState.currentBid = null;
    if (!gameState.gameOver) nextTurn();
    io.emit('state', gameState);
  });

  socket.on('disconnect', () => {
    const idx = gameState.players.findIndex(p => p.id === socket.id);
    if (idx > -1) {
      const name = gameState.players[idx].name;
      gameState.players.splice(idx, 1);
      io.emit('msg', `${name}离开房间`);
      io.emit('state', gameState);
    }
  })
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("server run on port", PORT);
});
