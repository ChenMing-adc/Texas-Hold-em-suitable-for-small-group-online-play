const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const Hand = require('pokersolver').Hand;
const fs = require('fs'); 

app.use(express.static(__dirname));

// ==========================================
// 0. 本地数据库管理
// ==========================================
const USERS_FILE = 'users.json';
function loadUsers() {
    try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } 
    catch (err) { return {}; }
}
function saveUsers(data) { fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2)); }

// ==========================================
// 1. 核心状态与座位
// ==========================================
let seats = [null, null, null, null, null, null]; 
const avatars = ['🐶', '🐱', '🦊', '🐻', '🐼', '🦁']; 
let communityCards = []; 
let pot = 0; 
let gameState = 'waiting'; 
let playerOrder = []; 
let currentTurnIndex = 0;
let handCount = 0; 
let dealerIndex = -1; let sbIndex = -1; let bbIndex = -1; 
let currentHighestBet = 0; 

// ==========================================
// 2. 扑克牌生成与判定
// ==========================================
const suits = ['♠️', '♥️', '♣️', '♦️'];
const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
let currentDeck = [];

function createAndShuffleDeck() {
    let deck = [];
    for (let s of suits) for (let r of ranks) deck.push({ suit: s, rank: r });
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}
function translateCard(card) {
    let r = card.rank === '10' ? 'T' : card.rank;
    let s = {'♠️':'s', '♥️':'h', '♣️':'c', '♦️':'d'}[card.suit];
    return r + s;
}

// ==========================================
// 3. 游戏阶段与下注引擎
// ==========================================
function resetRoundBets() {
    currentHighestBet = 0;
    seats.forEach(p => { if (p && p.status === 'playing') { p.roundBet = 0; p.acted = false; } });
}

function nextStage() {
    if (gameState === 'waiting') {
        gameState = 'pre-flop';
        currentDeck = createAndShuffleDeck();
        communityCards = []; pot = 0; handCount++; 

        let readyPlayers = seats.map((s, i) => s && s.isReady ? i : -1).filter(i => i !== -1);
        let shift = handCount % readyPlayers.length;
        playerOrder = readyPlayers.slice(shift).concat(readyPlayers.slice(0, shift));

        sbIndex = playerOrder[0]; bbIndex = playerOrder[1]; dealerIndex = playerOrder[playerOrder.length - 1]; 
        resetRoundBets(); 

        seats.forEach(p => { 
            if (p && p.isReady) { p.holeCards = [currentDeck.pop(), currentDeck.pop()]; p.status = 'playing'; p.isReady = false; p.isWinner = false; p.hasRevealed = false; }
        });

        let sbPlayer = seats[sbIndex]; let bbPlayer = seats[bbIndex];
        let sbAmount = Math.min(10, sbPlayer.chips);
        sbPlayer.chips -= sbAmount; pot += sbAmount; sbPlayer.roundBet = sbAmount;
        let bbAmount = Math.min(20, bbPlayer.chips);
        bbPlayer.chips -= bbAmount; pot += bbAmount; bbPlayer.roundBet = bbAmount;
        currentHighestBet = 20;

        io.emit('chatMessage', { user: '📢 裁判', text: `第 ${handCount} 局！【${sbPlayer.username}】小盲 10，【${bbPlayer.username}】大盲 20。` });
        currentTurnIndex = playerOrder.length === 2 ? 0 : 2; 
    } 
    else if (gameState === 'pre-flop') { gameState = 'flop'; resetRoundBets(); currentDeck.pop(); communityCards.push(currentDeck.pop(), currentDeck.pop(), currentDeck.pop()); io.emit('chatMessage', { user: '📢 裁判', text: '进入翻牌圈 (Flop)！' }); } 
    else if (gameState === 'flop') { gameState = 'turn'; resetRoundBets(); currentDeck.pop(); communityCards.push(currentDeck.pop()); io.emit('chatMessage', { user: '📢 裁判', text: '进入转牌圈 (Turn)！' }); } 
    else if (gameState === 'turn') { gameState = 'river'; resetRoundBets(); currentDeck.pop(); communityCards.push(currentDeck.pop()); io.emit('chatMessage', { user: '📢 裁判', text: '进入河牌圈 (River)！' }); } 
    else if (gameState === 'river') { gameState = 'showdown'; }
    
    // 👉 防奔溃修改：增加 null 判断，跳过掉线的空位
    if (gameState !== 'pre-flop' && gameState !== 'showdown' && gameState !== 'waiting') {
        currentTurnIndex = 0;
        let loopCount = 0;
        while(loopCount < playerOrder.length && 
             (!seats[playerOrder[currentTurnIndex]] || 
              seats[playerOrder[currentTurnIndex]].status !== 'playing' || 
              seats[playerOrder[currentTurnIndex]].chips === 0)) {
            currentTurnIndex = (currentTurnIndex + 1) % playerOrder.length; 
            loopCount++;
        }
        if (loopCount >= playerOrder.length) { setTimeout(nextStage, 1000); return; }
    }
    broadcastTable();
}

// 👉 修改点 1：替换 evaluateWinner 函数，加入破产判定
function evaluateWinner() {
    let activePlayers = playerOrder.filter(idx => seats[idx] && seats[idx].status === 'playing');
    if (activePlayers.length === 1) {
        let winner = seats[activePlayers[0]]; 
        io.emit('chatMessage', { user: '🏆 战报', text: `其他人都弃牌了，【${winner.username}】赢走 ${pot} 筹码！` });
        io.emit('settlePot', { winners: [activePlayers[0]], splitPot: pot });
        setTimeout(() => {
            winner.chips += pot; winner.isWinner = true;
            pot = 0; gameState = 'waiting'; 
            
            // 核心新增：结算时，清算破产玩家，打入观战席
            seats.forEach(p => { if (p && p.chips <= 0) p.status = 'spectator'; });
            broadcastTable();
        }, 2500);
        return;
    }

    let hands = []; let board = communityCards.map(translateCard);
    seats.forEach(p => { if(p) p.isWinner = false; });
    activePlayers.forEach(seatIdx => {
        let p = seats[seatIdx];
        if (p.holeCards.length === 2) {
            let solvedHand = Hand.solve(p.holeCards.map(translateCard).concat(board));
            solvedHand.seatIdx = seatIdx; solvedHand.playerName = p.username; hands.push(solvedHand);
        }
    });

    if(hands.length > 0) {
        let winners = Hand.winners(hands); let splitPot = Math.floor(pot / winners.length);
        io.emit('chatMessage', { user: '🏆 战报', text: `胜者: ${winners.map(w=>w.playerName).join(', ')} (${winners[0].descr})` });
        io.emit('settlePot', { winners: winners.map(w => w.seatIdx), splitPot: splitPot });
        
        setTimeout(() => {
            winners.forEach(w => { seats[w.seatIdx].chips += splitPot; seats[w.seatIdx].isWinner = true; });
            pot = 0; gameState = 'waiting'; 
            
            // 核心新增：结算时，清算破产玩家，打入观战席
            seats.forEach(p => { if (p && p.chips <= 0) p.status = 'spectator'; });
            broadcastTable();
        }, 2500);
    }
}

function broadcastTable() {
    io.sockets.sockets.forEach((socket) => {
        let safeSeats = seats.map((p, i) => {
            if (!p) return null;
            let showRealCards = (p.hasRevealed) || (p.id === socket.id);
            let role = '';
            if (gameState !== 'waiting' && gameState !== 'showdown') {
                if (i === dealerIndex) role = '庄'; else if (i === sbIndex) role = '小盲'; else if (i === bbIndex) role = '大盲';
            }
            return {
                id: p.id, username: p.username, avatar: p.avatar, chips: p.chips,
                status: p.status, isReady: p.isReady, isWinner: p.isWinner, role: role, roundBet: p.roundBet || 0,
                hasRevealed: p.hasRevealed, 
                holeCards: showRealCards ? p.holeCards : (p.holeCards.length > 0 ? ['hidden', 'hidden'] : [])
            };
        });

        socket.emit('updateTable', {
            gameState: gameState, communityCards: communityCards, pot: pot, currentHighestBet: currentHighestBet, seats: safeSeats,
            currentTurnSeatIdx: gameState !== 'waiting' && gameState !== 'showdown' ? playerOrder[currentTurnIndex] : null
        });
    });
}

// ==========================================
// 4. 联机通讯
// ==========================================
io.on('connection', (socket) => {
    
    socket.on('login', (loginData) => {
        let users = loadUsers(); const username = loginData.username; const password = loginData.password;
        if (!users[username] || users[username] !== password) return socket.emit('loginError', '账号不存在或密码错误！');
        if (seats.find(s => s !== null && s.username === username)) return socket.emit('loginError', '该账号已经在线！');
        let emptySeatIdx = seats.findIndex(s => s === null);
        if (emptySeatIdx === -1) return socket.emit('loginError', '房间已满！');
        
        seats[emptySeatIdx] = { id: socket.id, username: username, avatar: avatars[emptySeatIdx%6], chips: 1000, status: 'waiting', isReady: false, isWinner: false, hasRevealed: false, holeCards: [], roundBet: 0, acted: false };
        socket.seatIdx = emptySeatIdx; socket.username = username; 
        socket.emit('loginSuccess', emptySeatIdx); broadcastTable();
    });

    socket.on('changePassword', (data) => {
        let users = loadUsers();
        if (users[socket.username] === data.oldPassword) { users[socket.username] = data.newPassword; saveUsers(users); socket.emit('passwordChanged', '密码修改成功！'); } 
        else { socket.emit('passwordChangeFailed', '原密码错误！'); }
    });

    socket.on('chatMessage', (msg) => { if (socket.seatIdx !== undefined) io.emit('chatBubble', { seatIdx: socket.seatIdx, text: msg }); });

// 👉 修改点 2：替换 ready 事件，禁止观战者准备，并且计算活跃玩家时不带观战者
    socket.on('ready', () => {
        if (gameState !== 'waiting' && gameState !== 'showdown') return;
        let p = seats[socket.seatIdx];
        if (!p) return;
        
        // 没钱的人不准点准备
        if (p.chips <= 0) {
            p.status = 'spectator';
            p.isReady = false;
            return;
        }

        p.isReady = true;
        // 只有非观战玩家才算作 activePlayers
        let activePlayers = seats.filter(s => s !== null && s.status !== 'spectator');
        
        if (activePlayers.length >= 2 && activePlayers.every(player => player.isReady)) { 
            gameState = 'waiting'; nextStage(); 
        } else {
            broadcastTable();
        }
    });

    socket.on('revealCards', () => {
        if (gameState !== 'showdown') return;
        let p = seats[socket.seatIdx];
        if (p && p.status === 'playing' && !p.hasRevealed) {
            p.hasRevealed = true;
            io.emit('chatBubble', { seatIdx: socket.seatIdx, text: '亮牌！🃏' });
            let activePlayers = playerOrder.filter(idx => seats[idx] && seats[idx].status === 'playing');
            let allRevealed = activePlayers.every(idx => seats[idx].hasRevealed);
            if (allRevealed) evaluateWinner(); 
            else broadcastTable();
        }
    });

    socket.on('playerAction', (action) => {
        let p = seats[socket.seatIdx];
        // 👉 防穿透修改：严格校验当前玩家是否真在局内
        if (!p || p.status !== 'playing') return;
        if (gameState === 'waiting' || gameState === 'showdown' || socket.seatIdx !== playerOrder[currentTurnIndex]) return;

        if (action.type === 'fold') { p.status = 'folded'; p.acted = true; io.emit('chatBubble', { seatIdx: socket.seatIdx, text: '弃牌 🏳️' }); } 
        else if (action.type === 'check') { if (p.roundBet === currentHighestBet) { p.acted = true; io.emit('chatBubble', { seatIdx: socket.seatIdx, text: '过牌 ✊' }); } } 
        else if (action.type === 'call') { let callAmount = currentHighestBet - p.roundBet; if (p.chips >= callAmount) { p.chips -= callAmount; pot += callAmount; p.roundBet += callAmount; p.acted = true; io.emit('chatBubble', { seatIdx: socket.seatIdx, text: `跟注 ${callAmount} 💵` }); } } 
        else if (action.type === 'raise') {
            let raiseAmount = action.amount; let callAmount = currentHighestBet - p.roundBet; let totalCost = callAmount + raiseAmount;
            if (p.chips >= totalCost) { p.chips -= totalCost; pot += totalCost; p.roundBet += totalCost; p.acted = true; currentHighestBet = p.roundBet; seats.forEach(other => { if (other && other.id !== p.id && other.status === 'playing' && other.chips > 0) other.acted = false; }); io.emit('chatBubble', { seatIdx: socket.seatIdx, text: `加注 ${raiseAmount} 🔥` }); }
        }
        else if (action.type === 'all-in') {
            let allInAmount = p.chips; p.chips = 0; pot += allInAmount; p.roundBet += allInAmount; p.acted = true;
            if (p.roundBet > currentHighestBet) { currentHighestBet = p.roundBet; seats.forEach(other => { if (other && other.id !== p.id && other.status === 'playing' && other.chips > 0) other.acted = false; }); }
            io.emit('chatBubble', { seatIdx: socket.seatIdx, text: `梭哈 All-In! 🌋` });
        }

        let playingPlayers = playerOrder.map(idx => seats[idx]).filter(s => s && s.status === 'playing');
        if (playingPlayers.length <= 1) { 
            gameState = 'showdown'; evaluateWinner(); return; 
        }
        
        let allActed = playingPlayers.every(s => s.acted === true || s.chips === 0);
        if (allActed) { nextStage(); } 
        else { 
            let loopCount = 0;
            do { currentTurnIndex = (currentTurnIndex + 1) % playerOrder.length; loopCount++; } 
            while (loopCount < playerOrder.length && (!seats[playerOrder[currentTurnIndex]] || seats[playerOrder[currentTurnIndex]].status !== 'playing' || seats[playerOrder[currentTurnIndex]].acted === true || seats[playerOrder[currentTurnIndex]].chips === 0)); 
            if (loopCount >= playerOrder.length) nextStage(); else broadcastTable(); 
        }
    });

    // 👉 掉线保护：掉线时自动将轮次平滑移交给下一位
    socket.on('disconnect', () => { 
        if (socket.seatIdx !== undefined) { 
            let wasMyTurn = (gameState !== 'waiting' && gameState !== 'showdown' && playerOrder[currentTurnIndex] === socket.seatIdx);
            seats[socket.seatIdx] = null; 
            
            if (gameState !== 'waiting' && gameState !== 'showdown') {
                let playingPlayers = playerOrder.map(idx => seats[idx]).filter(s => s && s.status === 'playing');
                if (playingPlayers.length <= 1) {
                    gameState = 'showdown'; evaluateWinner(); return;
                }
                if (wasMyTurn) {
                    let allActed = playingPlayers.every(s => s.acted === true || s.chips === 0);
                    if (allActed) { nextStage(); } 
                    else {
                        let loopCount = 0;
                        do { currentTurnIndex = (currentTurnIndex + 1) % playerOrder.length; loopCount++; } 
                        while (loopCount < playerOrder.length && (!seats[playerOrder[currentTurnIndex]] || seats[playerOrder[currentTurnIndex]].status !== 'playing' || seats[playerOrder[currentTurnIndex]].acted === true || seats[playerOrder[currentTurnIndex]].chips === 0)); 
                        if (loopCount >= playerOrder.length) nextStage(); else broadcastTable(); 
                    }
                    return; 
                }
            }
            broadcastTable(); 
        } 
    });
});

http.listen(3000, () => { console.log('🚀 巅峰德州引擎启动！'); });