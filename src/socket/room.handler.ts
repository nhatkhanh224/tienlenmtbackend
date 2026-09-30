import { Server, Socket } from 'socket.io';
import { Card, Suit } from '../game-engine/card';
import { Validator, Combo, ComboType } from '../game-engine/validator';
import { BotAI } from '../game-engine/bot';
import { Deck } from '../game-engine/deck';
import { v4 as uuidv4 } from 'uuid';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export interface RoomPlayer {
  id: string;
  username: string;
  isBot: boolean;
  cards: Card[];
  hasPassed: boolean;
  rank?: number;
}

export interface RoomState {
  id: string;
  hostId: string;
  bet: number;
  status: 'WAITING' | 'PLAYING' | 'FINISHED';
  players: RoomPlayer[];
  centerCards: Card[];
  turnIndex: number;
  lastPlayedTurn: number;
  passedPlayers: number[];
  ranks: { [playerIdx: number]: number };
  playerMoveCounts?: { [playerIdx: number]: number };
  isFirstMove: boolean;
  isFirstGame: boolean;
  penaltyResults: any[];
}

export const rooms = new Map<string, RoomState>();

export function setupSocket(io: Server) {

  const getLobbyRoomsList = () => {
    return Array.from(rooms.values()).map(r => ({
      id: r.id,
      playersCount: r.players.length,
      status: r.status,
      bet: r.bet,
      hostName: r.players[0]?.username || 'Host'
    }));
  };

  const broadcastLobbyRooms = () => {
    io.emit('lobby:rooms', getLobbyRoomsList());
  };

  const handlePlayerLeaveRoom = (userId: string, targetRoomId?: string) => {
    if (!userId) return;

    for (const [roomId, room] of rooms.entries()) {
      if (targetRoomId && roomId !== targetRoomId) continue;

      const playerIdx = room.players.findIndex(p => p.id === userId);
      if (playerIdx === -1) continue;

      // Xóa người chơi rời phòng
      room.players.splice(playerIdx, 1);

      // Nếu người rời phòng là Chủ phòng -> Chuyển quyền chủ phòng cho người tiếp theo (người thứ 2)
      const wasHost = room.hostId === userId;
      if (wasHost && room.players.length > 0) {
        const nextHost = room.players.find(p => !p.isBot) || room.players[0];
        room.hostId = nextHost.id;
      }

      const remainingHumanCount = room.players.filter(p => !p.isBot).length;
      const totalRemaining = room.players.length;

      // Nếu không còn người chơi thật nào trong phòng -> Hủy bàn
      if (totalRemaining === 0 || remainingHumanCount === 0) {
        rooms.delete(roomId);
        io.to(roomId).emit('room:cancelled', {
          roomId,
          reason: 'Bàn đã bị hủy do tất cả người chơi đã rời phòng.'
        });
        broadcastLobbyRooms();
      } else {
        // Còn ít nhất 1 người chơi thật
        if (room.status === 'PLAYING') {
          if (totalRemaining < 2) {
            // Đang chơi mà còn dưới 2 người -> Hủy ván đấu, về màn hình chờ WAITING
            room.status = 'WAITING';
            room.turnIndex = -1;
            room.centerCards = [];
            room.passedPlayers = [];
            io.to(roomId).emit('room:cancelled', {
              roomId,
              reason: 'Ván đấu bị hủy do không đủ 2 người chơi.'
            });
          } else {
            // Cập nhật lại turnIndex nếu người rời là người đang tới lượt
            if (room.turnIndex >= room.players.length || room.turnIndex === playerIdx) {
              room.turnIndex = room.turnIndex % room.players.length;
            } else if (room.turnIndex > playerIdx) {
              room.turnIndex = room.turnIndex - 1;
            }

            // Cập nhật lại danh sách bỏ lượt
            room.passedPlayers = room.passedPlayers
              .filter(idx => idx !== playerIdx)
              .map(idx => idx > playerIdx ? idx - 1 : idx);

            if (room.lastPlayedTurn === playerIdx) {
              room.lastPlayedTurn = 0;
              room.centerCards = [];
            } else if (room.lastPlayedTurn > playerIdx) {
              room.lastPlayedTurn = room.lastPlayedTurn - 1;
            }

            io.to(roomId).emit('game:update', getPublicRoomState(room));
            checkAndRunBotTurn(roomId);
          }
        } else {
          // Trạng thái WAITING
          io.to(roomId).emit('room:update', getPublicRoomState(room));
        }
        broadcastLobbyRooms();
      }
    }
  };

  const calculateAndSettlePenalties = async (room: RoomState) => {
    const N = room.players.length;
    const bet = room.bet || 1000;
    const results: any[] = [];

    let winnerIdx = -1;
    for (const idxStr in room.ranks) {
      if (room.ranks[idxStr] === 1) winnerIdx = Number(idxStr);
    }

    if (winnerIdx === -1) winnerIdx = 0;

    // Check Tới Trắng (Điều 4): Người về Nhất đánh hết 13 lá bài mà không một ai trong 3 người còn lại chặn/đánh được bài lần nào
    let isToiTrang = true;
    for (let i = 0; i < N; i++) {
      if (i !== winnerIdx) {
        if (room.playerMoveCounts && (room.playerMoveCounts[i] || 0) > 0) {
          isToiTrang = false;
          break;
        }
      }
    }

    let totalWinnerCoins = 0;
    const playerPenalties: { [idx: number]: { coins: number; message: string } } = {};

    for (let i = 0; i < N; i++) {
      if (i === winnerIdx) continue;
      const player = room.players[i];
      const hand = player.cards || [];
      const count = hand.length;

      let baseMultiplier = 0;
      let baseMsg = '';

      // Điều 2 — Tiền cõng bài
      if (count >= 1 && count <= 9) {
        baseMultiplier = count;
        baseMsg = `${count} lá (${(count * bet).toLocaleString()} xu)`;
      } else if (count >= 10 && count <= 12) {
        baseMultiplier = count * 2;
        baseMsg = `${count} lá (X2 = ${(count * 2 * bet).toLocaleString()} xu)`;
      } else if (count >= 13) {
        baseMultiplier = 52; // 13 * 4 (thối trắng / cóng)
        baseMsg = `Thối trắng 13 lá (X4 = ${(52 * bet).toLocaleString()} xu)`;
      }

      let baseCoins = baseMultiplier * bet;
      let pigCoins = 0;
      let pigMsgList: string[] = [];

      // Điều 3 — Phạt đền heo
      const blackPigs = hand.filter(c => c.value === 15 && c.suit < 2);
      const redPigs = hand.filter(c => c.value === 15 && c.suit >= 2);

      if (blackPigs.length > 0) {
        const bpCoins = blackPigs.length * 2 * bet;
        pigCoins += bpCoins;
        pigMsgList.push(`${blackPigs.length} Heo Đen (+${bpCoins.toLocaleString()} xu)`);
      }
      if (redPigs.length > 0) {
        const rpCoins = redPigs.length * 4 * bet;
        pigCoins += rpCoins;
        pigMsgList.push(`${redPigs.length} Heo Đỏ (+${rpCoins.toLocaleString()} xu)`);
      }

      let subTotal = baseCoins + pigCoins;
      let finalCoins = subTotal;
      let fullMsg = baseMsg;

      if (pigMsgList.length > 0) {
        fullMsg += `, Phạt heo: ${pigMsgList.join(', ')}`;
      }

      // Điều 4 — Tới trắng
      if (isToiTrang) {
        finalCoins = subTotal * 2;
        fullMsg += ` 🐉 TỚI TRẮNG (Nhân đôi tiền đền = -${finalCoins.toLocaleString()} xu)!`;
      }

      playerPenalties[i] = { coins: finalCoins, message: fullMsg };
      totalWinnerCoins += finalCoins;
    }

    // Điều 1, 5 — Thanh toán cho Người về Nhất
    playerPenalties[winnerIdx] = {
      coins: -totalWinnerCoins,
      message: `🥇 VỀ NHẤT ${isToiTrang ? '(🐉 TỚI TRẮNG!)' : ''}! Thưởng +${totalWinnerCoins.toLocaleString()} xu`
    };

    // Thực hiện cộng/trừ xu thật vào CSDL Prisma DB (SQLite dev.db)
    for (let i = 0; i < N; i++) {
      const player = room.players[i];
      const pInfo = playerPenalties[i];
      const coinChange = i === winnerIdx ? totalWinnerCoins : -pInfo.coins;
      let newBalance: number | null = null;

      if (!player.isBot && player.id) {
        try {
          const dbUser = await prisma.user.findFirst({
            where: {
              OR: [
                { id: player.id },
                { username: player.username }
              ]
            },
            include: { wallet: true }
          });

          if (dbUser && dbUser.wallet) {
            const updatedWallet = await prisma.wallet.update({
              where: { id: dbUser.wallet.id },
              data: {
                balance: {
                  increment: BigInt(coinChange)
                }
              }
            });

            newBalance = Number(updatedWallet.balance);

            await prisma.walletTransaction.create({
              data: {
                walletId: dbUser.wallet.id,
                amount: BigInt(coinChange),
                reason: i === winnerIdx 
                  ? (isToiTrang ? 'MATCH_TOI_TRANG_WIN' : 'MATCH_WIN') 
                  : 'MATCH_LOSS'
              }
            });
          }
        } catch (dbErr) {
          console.error(`DB balance settlement error for ${player.username}:`, dbErr);
        }
      }

      results.push({
        player: i,
        username: player.username,
        isBot: player.isBot,
        coinChange: coinChange,
        newBalance: newBalance,
        message: pInfo.message
      });
    }

    return results;
  };

  const checkAndRunBotTurn = (roomId: string) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'PLAYING') return;

    const currentP = room.players[room.turnIndex];
    if (!currentP || !currentP.isBot || currentP.cards.length === 0) return;

    const targetTurn = room.turnIndex;

    setTimeout(async () => {
      const r = rooms.get(roomId);
      if (!r || r.status !== 'PLAYING' || r.turnIndex !== targetTurn) return;

      const bot = r.players[r.turnIndex];
      if (!bot || !bot.isBot || bot.cards.length === 0) return;

      const isNewRound = r.centerCards.length === 0;
      const centerCombo = isNewRound ? null : Validator.getCombo(r.centerCards);

      const playedCards = BotAI.getBestMove(bot.cards, centerCombo, isNewRound, r.isFirstMove);

      if (playedCards.length === 0) {
        processPass(r, r.turnIndex);
      } else {
        await processPlay(r, r.turnIndex, playedCards);
      }
    }, 1000);
  };

  const processPass = (room: RoomState, playerIdx: number) => {
    if (room.centerCards.length === 0) return;

    if (!room.passedPlayers.includes(playerIdx)) {
      room.passedPlayers.push(playerIdx);
    }

    const N = room.players.length;
    const activePlayersCount = N - Object.keys(room.ranks).length;
    const isRoundOver = room.passedPlayers.length >= activePlayersCount - 1;

    let nextTurn = (playerIdx + 1) % N;

    if (isRoundOver) {
      room.passedPlayers = [];
      room.centerCards = [];
      nextTurn = room.lastPlayedTurn;
      let skip = 0;
      while (room.ranks[nextTurn] !== undefined && skip < N) {
        nextTurn = (nextTurn + 1) % N;
        skip++;
      }
    } else {
      let skipCount = 0;
      while ((room.ranks[nextTurn] !== undefined || room.passedPlayers.includes(nextTurn)) && skipCount < N) {
        nextTurn = (nextTurn + 1) % N;
        skipCount++;
      }
    }

    room.turnIndex = nextTurn;

    io.to(room.id).emit('game:update', getPublicRoomState(room));
    checkAndRunBotTurn(room.id);
  };

  const processPlay = async (room: RoomState, playerIdx: number, playedCards: Card[]) => {
    const p = room.players[playerIdx];
    if (!p) return;

    if (room.isFirstMove) {
      room.isFirstMove = false;
    }

    if (!room.playerMoveCounts) {
      room.playerMoveCounts = {};
    }
    room.playerMoveCounts[playerIdx] = (room.playerMoveCounts[playerIdx] || 0) + 1;

    room.centerCards = playedCards;
    room.lastPlayedTurn = playerIdx;

    // Trừ bài
    const playedStrs = playedCards.map(c => `${c.value}-${c.suit}`);
    p.cards = p.cards.filter(c => !playedStrs.includes(`${c.value}-${c.suit}`));

    // Check hết bài -> xếp hạng
    if (p.cards.length === 0 && room.ranks[playerIdx] === undefined) {
      const rank = Object.keys(room.ranks).length + 1;
      room.ranks[playerIdx] = rank;
      p.rank = rank;
    }

    const N = room.players.length;

    // Check end game (khi N-1 người đã về đích)
    if (Object.keys(room.ranks).length >= N - 1) {
      const loser = Array.from({ length: N }, (_, i) => i).find(idx => room.ranks[idx] === undefined);
      if (loser !== undefined) {
        room.ranks[loser] = N;
        if (room.players[loser]) room.players[loser].rank = N;
      }
      room.status = 'FINISHED';
      room.turnIndex = -1;
      room.isFirstGame = false;
      
      // Tính tiền đền & trừ/cộng xu thật vào DB theo Luật Tiến Lên Miền Trung
      room.penaltyResults = await calculateAndSettlePenalties(room);

      io.to(room.id).emit('game:update', getPublicRoomState(room));
      broadcastLobbyRooms();
      return;
    }

    // Next turn
    const activePlayersCount = N - Object.keys(room.ranks).length;
    const isRoundOver = room.passedPlayers.length >= activePlayersCount - 1;

    let nextTurn = (playerIdx + 1) % N;
    if (isRoundOver) {
      room.passedPlayers = [];
      room.centerCards = [];
      nextTurn = playerIdx;
      let skip = 0;
      while (room.ranks[nextTurn] !== undefined && skip < N) {
        nextTurn = (nextTurn + 1) % N;
        skip++;
      }
    } else {
      let skipCount = 0;
      while ((room.ranks[nextTurn] !== undefined || room.passedPlayers.includes(nextTurn)) && skipCount < N) {
        nextTurn = (nextTurn + 1) % N;
        skipCount++;
      }
    }

    room.turnIndex = nextTurn;

    io.to(room.id).emit('game:update', getPublicRoomState(room));
    checkAndRunBotTurn(room.id);
  };

  const getPublicRoomState = (room: RoomState) => {
    return {
      id: room.id,
      hostId: room.hostId,
      status: room.status,
      bet: room.bet,
      turnIndex: room.turnIndex,
      lastPlayedTurn: room.lastPlayedTurn,
      centerCards: room.centerCards,
      passedPlayers: room.passedPlayers,
      ranks: room.ranks,
      isFirstMove: room.isFirstMove,
      penaltyResults: room.penaltyResults || [],
      players: room.players.map(p => ({
        id: p.id,
        username: p.username,
        isBot: p.isBot,
        cardCount: p.cards.length,
        rank: p.rank,
        cards: p.cards
      }))
    };
  };

  io.on('connection', (socket: Socket) => {

    socket.on('auth', (data: { userId: string; username: string }) => {
      (socket as any).userId = data.userId;
      (socket as any).username = data.username;

      socket.emit('lobby:rooms', getLobbyRoomsList());
    });

    socket.on('lobby:get_rooms', () => {
      socket.emit('lobby:rooms', getLobbyRoomsList());
    });

    socket.on('room:create', async (data: { bet?: number }) => {
      const roomId = Math.floor(100000 + Math.random() * 900000).toString();
      const userId = (socket as any).userId || uuidv4().slice(0, 8);
      const username = (socket as any).username || 'Player';
      const reqBet = data?.bet || 1000;

      // Kiểm tra số dư tài khoản trước khi tạo bàn
      try {
        const userDb = await prisma.user.findFirst({
          where: { OR: [{ id: userId }, { username }] },
          include: { wallet: true }
        });
        const balance = userDb?.wallet ? Number(userDb.wallet.balance) : 0;
        if (balance < reqBet) {
          return socket.emit('error', `Số dư không đủ! Bạn hiện có ${balance.toLocaleString()} Xu (Cần ít nhất ${reqBet.toLocaleString()} Xu để tạo bàn).`);
        }
      } catch (err) {
        console.error('Check wallet error on room create:', err);
      }

      const newRoom: RoomState = {
        id: roomId,
        hostId: userId,
        bet: reqBet,
        status: 'WAITING',
        players: [{ id: userId, username, isBot: false, cards: [], hasPassed: false }],
        centerCards: [],
        turnIndex: -1,
        lastPlayedTurn: 0,
        passedPlayers: [],
        ranks: {},
        playerMoveCounts: {},
        isFirstMove: true,
        isFirstGame: true,
        penaltyResults: []
      };

      rooms.set(roomId, newRoom);
      socket.join(roomId);

      socket.emit('room:created', { roomId });
      broadcastLobbyRooms();
      io.to(roomId).emit('room:update', getPublicRoomState(newRoom));
    });

    socket.on('room:join', async (data: { roomId: string }) => {
      const room = rooms.get(data?.roomId);
      if (!room) return socket.emit('error', 'Phòng không tồn tại!');
      if (room.players.length >= 4) return socket.emit('error', 'Phòng đã đầy!');
      if (room.status !== 'WAITING') return socket.emit('error', 'Phòng đang chơi!');

      const userId = (socket as any).userId || uuidv4().slice(0, 8);
      const username = (socket as any).username || 'Guest';

      if (!room.players.some(p => p.id === userId)) {
        // Kiểm tra số dư tài khoản người chơi gia nhập
        try {
          const userDb = await prisma.user.findFirst({
            where: { OR: [{ id: userId }, { username }] },
            include: { wallet: true }
          });
          const balance = userDb?.wallet ? Number(userDb.wallet.balance) : 0;
          if (balance < room.bet) {
            return socket.emit('error', `Số dư không đủ! Cần ít nhất ${room.bet.toLocaleString()} Xu để vào bàn (Bạn có ${balance.toLocaleString()} Xu).`);
          }
        } catch (err) {
          console.error('Check wallet error on room join:', err);
        }

        room.players.push({ id: userId, username, isBot: false, cards: [], hasPassed: false });
      }

      socket.join(data.roomId);
      io.to(data.roomId).emit('room:update', getPublicRoomState(room));
      broadcastLobbyRooms();
    });

    socket.on('room:leave', (data: { roomId: string }) => {
      const userId = (socket as any).userId;
      if (userId) {
        handlePlayerLeaveRoom(userId, data?.roomId);
      }
    });

    socket.on('room:add_bot', (data: { roomId: string }) => {
      const room = rooms.get(data?.roomId);
      if (!room) return;
      if (room.players.length >= 4) return socket.emit('error', 'Phòng đã đầy!');

      const botNum = room.players.filter(p => p.isBot).length + 1;
      room.players.push({
        id: `bot_${uuidv4().slice(0, 6)}`,
        username: `Bot ${botNum}`,
        isBot: true,
        cards: [],
        hasPassed: false
      });

      io.to(data.roomId).emit('room:update', getPublicRoomState(room));
      broadcastLobbyRooms();
    });

    socket.on('room:start', async (data: { roomId: string }) => {
      const room = rooms.get(data?.roomId);
      if (!room) return;

      const N = room.players.length;
      if (N < 2) {
        return socket.emit('error', 'Cần ít nhất 2 người chơi (hoặc thêm Bot) để bắt đầu!');
      }

      // Kiểm tra tất cả người chơi thật xem có ai thiếu xu không
      for (const p of room.players) {
        if (!p.isBot) {
          try {
            const userDb = await prisma.user.findFirst({
              where: { OR: [{ id: p.id }, { username: p.username }] },
              include: { wallet: true }
            });
            const balance = userDb?.wallet ? Number(userDb.wallet.balance) : 0;
            if (balance < room.bet) {
              return socket.emit('error', `Người chơi ${p.username} không đủ ${room.bet.toLocaleString()} Xu để bắt đầu ván cược!`);
            }
          } catch (err) {
            console.error('Check wallet error on start:', err);
          }
        }
      }

      const deck = new Deck();
      deck.initialize();
      deck.shuffle();

      room.players.forEach((p, idx) => {
        p.cards = Validator.sortCards(deck.cards.slice(idx * 13, (idx + 1) * 13));
        p.hasPassed = false;
        p.rank = undefined;
      });

      room.status = 'PLAYING';
      room.ranks = {};
      room.passedPlayers = [];
      room.centerCards = [];
      room.lastPlayedTurn = 0;
      room.penaltyResults = [];
      room.playerMoveCounts = { 0: 0, 1: 0, 2: 0, 3: 0 };

      let startingPlayer = 0;
      if (room.isFirstGame) {
        let found3Spades = false;
        for (let i = 0; i < N; i++) {
          if (room.players[i].cards.some(c => c.value === 3 && c.suit === 0)) {
            startingPlayer = i;
            found3Spades = true;
            break;
          }
        }
        if (found3Spades) {
          room.isFirstMove = true;
        } else {
          room.isFirstMove = false;
          let minCard = room.players[0].cards[0];
          startingPlayer = 0;
          for (let i = 1; i < N; i++) {
            if (minCard.isGreaterThan(room.players[i].cards[0])) {
              minCard = room.players[i].cards[0];
              startingPlayer = i;
            }
          }
        }
      } else {
        room.isFirstMove = false;
        const prevWinner = room.players.findIndex(p => p.rank === 1);
        startingPlayer = prevWinner !== -1 ? prevWinner : 0;
      }

      room.turnIndex = startingPlayer;

      io.to(data.roomId).emit('game:started', getPublicRoomState(room));
      broadcastLobbyRooms();

      checkAndRunBotTurn(data.roomId);
    });

    socket.on('game:play', async (data: { roomId: string; cards: { value: number; suit: number }[] }) => {
      try {
        const room = rooms.get(data?.roomId);
        if (!room || room.status !== 'PLAYING') return;

        const userId = (socket as any).userId;
        const playerIdx = room.players.findIndex(p => p.id === userId);

        if (playerIdx === -1 || playerIdx !== room.turnIndex) {
          return socket.emit('error', 'Chưa tới lượt của bạn!');
        }

        if (!data.cards || !Array.isArray(data.cards) || data.cards.length === 0) {
          return socket.emit('error', 'Vui lòng chọn lá bài cần đánh!');
        }

        const playedCards = data.cards.map(c => new Card(Number(c.value), Number(c.suit)));
        const combo = Validator.getCombo(playedCards);

        if (combo.type === ComboType.INVALID) {
          return socket.emit('error', 'Bộ bài không hợp lệ theo luật Tiến Lên!');
        }

        if (room.centerCards.length > 0) {
          const centerCombo = Validator.getCombo(room.centerCards);
          if (!Validator.canPlay(combo, centerCombo)) {
            return socket.emit('error', 'Không thể chặt bài trên bàn!');
          }
        }

        if (room.isFirstMove) {
          const playerHas3Spades = room.players[playerIdx].cards.some(c => c.value === 3 && c.suit === 0);
          if (playerHas3Spades) {
            const playedHas3Spades = playedCards.some(c => c.value === 3 && c.suit === 0);
            if (!playedHas3Spades) {
              return socket.emit('error', 'Ván đầu tiên BẮT BUỘC phải đánh ra bài chứa lá 3 Bích!');
            }
          }
        }

        await processPlay(room, playerIdx, playedCards);
      } catch (err: any) {
        console.error('game:play error:', err);
        socket.emit('error', err.message || 'Lỗi khi đánh bài');
      }
    });

    socket.on('game:pass', (data: { roomId: string }) => {
      try {
        const room = rooms.get(data?.roomId);
        if (!room || room.status !== 'PLAYING') return;

        const userId = (socket as any).userId;
        const playerIdx = room.players.findIndex(p => p.id === userId);

        if (playerIdx === -1 || playerIdx !== room.turnIndex) {
          return socket.emit('error', 'Chưa tới lượt của bạn!');
        }

        processPass(room, playerIdx);
      } catch (err: any) {
        console.error('game:pass error:', err);
        socket.emit('error', err.message || 'Lỗi khi bỏ lượt');
      }
    });

    socket.on('disconnect', () => {
      const userId = (socket as any).userId;
      if (userId) {
        handlePlayerLeaveRoom(userId);
      } else {
        broadcastLobbyRooms();
      }
    });
  });
}
