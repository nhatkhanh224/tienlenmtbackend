import { Server, Socket } from 'socket.io';
import { Card, Suit } from '../game-engine/card';
import { Validator, Combo, ComboType } from '../game-engine/validator';
import { BotAI } from '../game-engine/bot';
import { Deck } from '../game-engine/deck';
import { v4 as uuidv4 } from 'uuid';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';

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
  isDealing: boolean;
  dealingEndsAt: number | null;
  isSettling: boolean;
  penaltyResults: any[];
}

export const rooms = new Map<string, RoomState>();
const disconnectTimers = new Map<string, NodeJS.Timeout>();

type RoomAck = (response: { ok: boolean; roomId?: string; error?: string }) => void;
type SocketUser = { id: string; username: string };

const DEFAULT_BET = 1000;
const DEAL_CARD_INTERVAL_MS = 64;
const DEAL_FINISH_BUFFER_MS = 420;
const getDealDurationMs = (playerCount: number) => (
  Math.min(4, Math.max(2, playerCount)) * 13 * DEAL_CARD_INTERVAL_MS + DEAL_FINISH_BUFFER_MS
);

const clearDisconnectTimer = (userId: string) => {
  const timer = disconnectTimers.get(userId);
  if (!timer) return;
  clearTimeout(timer);
  disconnectTimers.delete(userId);
};

const getAvailableRank = (room: RoomState, preferWorst = false) => {
  const usedRanks = new Set(Object.values(room.ranks));
  if (preferWorst) {
    for (let rank = room.players.length; rank >= 1; rank--) {
      if (!usedRanks.has(rank)) return rank;
    }
  } else {
    for (let rank = 1; rank <= room.players.length; rank++) {
      if (!usedRanks.has(rank)) return rank;
    }
  }
  return room.players.length;
};

const assignRank = (room: RoomState, playerIdx: number, preferWorst = false) => {
  if (room.ranks[playerIdx] !== undefined) return room.ranks[playerIdx];
  const rank = getAvailableRank(room, preferWorst);
  room.ranks[playerIdx] = rank;
  if (room.players[playerIdx]) room.players[playerIdx].rank = rank;
  return rank;
};

const getSocketUser = (socket: Socket): SocketUser | null => {
  const user = (socket.data as { user?: SocketUser }).user;
  return user?.id && user?.username ? user : null;
};

const rejectRequest = (socket: Socket, ack: RoomAck | undefined, message: string) => {
  if (ack) ack({ ok: false, error: message });
  else socket.emit('error', message);
};

export function setupSocket(io: Server) {

  const getWalletBalance = async (userId: string) => {
    // Older accounts may predate the wallet feature. Upsert makes their state
    // consistent with newly registered accounts instead of reporting a fake 0.
    const wallet = await prisma.wallet.upsert({
      where: { userId },
      update: {},
      create: { userId, balance: 10000 }
    });
    return Number(wallet.balance);
  };

  const getLobbyRoomsList = () => {
    return Array.from(rooms.values()).map(r => ({
      id: r.id,
      playersCount: r.players.length,
      status: r.status,
      bet: r.bet,
      hostName: r.players.find(p => p.id === r.hostId)?.username || 'Host'
    }));
  };

  const broadcastLobbyRooms = () => {
    io.emit('lobby:rooms', getLobbyRoomsList());
  };

  const leaveSocketGameRooms = (socket: Socket) => {
    for (const joinedRoomId of socket.rooms) {
      if (joinedRoomId !== socket.id) socket.leave(joinedRoomId);
    }
  };

  const handlePlayerLeaveRoom = (userId: string, targetRoomId?: string) => {
    if (!userId) return;

    for (const [roomId, room] of rooms.entries()) {
      if (targetRoomId && roomId !== targetRoomId) continue;

      const playerIdx = room.players.findIndex(p => p.id === userId);
      if (playerIdx === -1) continue;

      // Xóa người chơi rời phòng
      const previousMoveCounts = room.playerMoveCounts || {};
      room.players.splice(playerIdx, 1);

      // Các trạng thái lượt/xếp hạng dùng index ghế, nên phải đánh lại index sau
      // khi một người rời phòng để người còn lại không bị lệch lượt hoặc hạng.
      room.ranks = Object.fromEntries(
        Object.entries(room.ranks)
          .filter(([idx]) => Number(idx) !== playerIdx)
          .map(([idx, rank]) => [Number(idx) > playerIdx ? Number(idx) - 1 : Number(idx), rank])
      );
      room.playerMoveCounts = Object.fromEntries(
        Object.entries(previousMoveCounts)
          .filter(([idx]) => Number(idx) !== playerIdx)
          .map(([idx, count]) => [Number(idx) > playerIdx ? Number(idx) - 1 : Number(idx), count])
      );

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
            room.isDealing = false;
            room.dealingEndsAt = null;
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

            emitRoomState(room, 'game:update');
            checkAndRunBotTurn(roomId);
          }
        } else {
          // Trạng thái WAITING
          emitRoomState(room, 'room:update');
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
          const wallet = await prisma.wallet.upsert({
            where: { userId: player.id },
            update: {},
            create: { userId: player.id, balance: 10000 }
          });

          if (wallet) {
            const updatedWallet = await prisma.wallet.update({
              where: { id: wallet.id },
              data: {
                balance: {
                  increment: BigInt(coinChange)
                }
              }
            });

            newBalance = Number(updatedWallet.balance);

            await prisma.walletTransaction.create({
              data: {
                walletId: wallet.id,
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
    if (!room || room.status !== 'PLAYING' || room.isDealing) return;

    const currentP = room.players[room.turnIndex];
    if (!currentP || !currentP.isBot || currentP.cards.length === 0) return;

    const targetTurn = room.turnIndex;

    setTimeout(async () => {
      const r = rooms.get(roomId);
      if (!r || r.status !== 'PLAYING' || r.isDealing || r.turnIndex !== targetTurn) return;

      const bot = r.players[r.turnIndex];
      if (!bot || !bot.isBot || bot.cards.length === 0) return;

      const isNewRound = r.centerCards.length === 0;
      const centerCombo = isNewRound ? null : Validator.getCombo(r.centerCards);

      const playedCards = BotAI.getBestMove(bot.cards, centerCombo, isNewRound, r.isFirstMove);

      if (playedCards.length === 0) {
        processPass(r, r.turnIndex);
      } else {
        const result = await processPlay(r, r.turnIndex, playedCards);
        if (!result.ok) {
          console.warn(`Bot ${bot.username} bỏ nước đánh không hợp lệ: ${result.error}`);
          if (r.centerCards.length > 0) processPass(r, r.turnIndex);
        }
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

    emitRoomState(room, 'game:update');
    checkAndRunBotTurn(room.id);
  };

  const processPlay = async (room: RoomState, playerIdx: number, playedCards: Card[]) => {
    if (room.isDealing) {
      return { ok: false as const, error: 'Đang chia bài, chưa thể đánh!' };
    }

    const p = room.players[playerIdx];
    if (!p) return { ok: false as const, error: 'Người chơi không tồn tại!' };

    if (Validator.wouldFinishWithPig(p.cards, playedCards)) {
      return { ok: false as const, error: 'Không được đánh Heo (2) để về cuối!' };
    }

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
      assignRank(room, playerIdx);
    } else if (p.cards.length === 1 && p.cards[0].value === 15 && room.ranks[playerIdx] === undefined) {
      // Chỉ còn đúng một lá Heo thì không còn nước đi hợp lệ để về. Xếp người
      // chơi vào hạng thấp nhất còn trống và giữ lá Heo để tính tiền thối.
      assignRank(room, playerIdx, true);
    }

    const N = room.players.length;

    // Check end game (khi N-1 người đã về đích)
    if (Object.keys(room.ranks).length >= N - 1) {
      const remainingPlayer = Array.from({ length: N }, (_, i) => i).find(idx => room.ranks[idx] === undefined);
      if (remainingPlayer !== undefined) {
        assignRank(room, remainingPlayer);
      }
      room.status = 'FINISHED';
      room.turnIndex = -1;
      room.isDealing = false;
      room.dealingEndsAt = null;
      room.isFirstGame = false;
      room.isSettling = true;
      room.penaltyResults = [];

      // Khóa giao diện ngay; không chờ các truy vấn ví/DB hoàn tất.
      emitRoomState(room, 'game:update');
      broadcastLobbyRooms();

      // Tính tiền đền & trừ/cộng xu thật vào DB theo Luật Tiến Lên Miền Trung
      try {
        room.penaltyResults = await calculateAndSettlePenalties(room);
      } catch (error) {
        console.error('Settle game error:', error);
        room.penaltyResults = [];
      } finally {
        room.isSettling = false;
      }

      emitRoomState(room, 'game:update');
      return { ok: true as const };
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

    emitRoomState(room, 'game:update');
    checkAndRunBotTurn(room.id);
    return { ok: true as const };
  };

  const getPublicRoomState = (room: RoomState, viewerId?: string) => {
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
      isDealing: room.isDealing,
      dealingEndsAt: room.dealingEndsAt,
      isSettling: room.isSettling,
      penaltyResults: room.penaltyResults || [],
      players: room.players.map(p => ({
        id: p.id,
        username: p.username,
        isBot: p.isBot,
        rank: p.rank,
        // A client only receives its own hand. Opponent hands must never be
        // included in a broadcast payload.
        cards: p.id === viewerId ? p.cards : []
      }))
    };
  };

  const emitRoomState = (room: RoomState, event: 'room:update' | 'game:started' | 'game:update') => {
    const socketIds = io.sockets.adapter.rooms.get(room.id);
    if (!socketIds) return;

    for (const socketId of socketIds) {
      const targetSocket = io.sockets.sockets.get(socketId);
      if (!targetSocket) continue;
      const viewer = getSocketUser(targetSocket);
      targetSocket.emit(event, getPublicRoomState(room, viewer?.id));
    }
  };

  io.on('connection', (socket: Socket) => {

    socket.on('auth', (data: { token?: string }, ack?: (response: { ok: boolean; userId?: string; username?: string; error?: string }) => void) => {
      try {
        if (!data?.token) throw new Error('Missing token');
        const payload = jwt.verify(data.token, config.jwtSecret) as { id?: string; username?: string };
        if (!payload.id || !payload.username) throw new Error('Invalid token payload');

        const previousUser = getSocketUser(socket);
        if (previousUser && previousUser.id !== payload.id) {
          handlePlayerLeaveRoom(previousUser.id);
          leaveSocketGameRooms(socket);
        }
        socket.data.user = { id: payload.id, username: payload.username } satisfies SocketUser;
        ack?.({ ok: true, userId: payload.id, username: payload.username });
        socket.emit('lobby:rooms', getLobbyRoomsList());
      } catch {
        delete socket.data.user;
        ack?.({ ok: false, error: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.' });
      }
    });

    socket.on('lobby:get_rooms', () => {
      socket.emit('lobby:rooms', getLobbyRoomsList());
    });

    socket.on('room:create', async (data: { bet?: number }, ack?: RoomAck) => {
      const user = getSocketUser(socket);
      if (!user) return rejectRequest(socket, ack, 'Bạn cần đăng nhập lại trước khi tạo bàn.');

      const reqBet = data?.bet ?? DEFAULT_BET;
      if (!Number.isSafeInteger(reqBet) || reqBet <= 0) {
        return rejectRequest(socket, ack, 'Mức cược không hợp lệ.');
      }

      try {
        const balance = await getWalletBalance(user.id);
        if (balance < reqBet) {
          return rejectRequest(socket, ack, `Số dư không đủ! Bạn hiện có ${balance.toLocaleString()} Xu (Cần ít nhất ${reqBet.toLocaleString()} Xu để tạo bàn).`);
        }
      } catch (err) {
        console.error('Check wallet error on room create:', err);
        return rejectRequest(socket, ack, 'Không thể kiểm tra số dư. Vui lòng thử lại sau.');
      }

      // A user can only occupy one active room at a time.
      handlePlayerLeaveRoom(user.id);
      leaveSocketGameRooms(socket);

      let roomId: string;
      do {
        roomId = Math.floor(100000 + Math.random() * 900000).toString();
      } while (rooms.has(roomId));

      const newRoom: RoomState = {
        id: roomId,
        hostId: user.id,
        bet: reqBet,
        status: 'WAITING',
        players: [{ id: user.id, username: user.username, isBot: false, cards: [], hasPassed: false }],
        centerCards: [],
        turnIndex: -1,
        lastPlayedTurn: 0,
        passedPlayers: [],
        ranks: {},
        playerMoveCounts: {},
        isFirstMove: true,
        isFirstGame: true,
        isDealing: false,
        dealingEndsAt: null,
        isSettling: false,
        penaltyResults: []
      };

      rooms.set(roomId, newRoom);
      socket.join(roomId);
      clearDisconnectTimer(user.id);

      ack?.({ ok: true, roomId });
      broadcastLobbyRooms();
      emitRoomState(newRoom, 'room:update');
    });

    socket.on('room:join', async (data: { roomId: string }, ack?: RoomAck) => {
      const user = getSocketUser(socket);
      if (!user) return rejectRequest(socket, ack, 'Bạn cần đăng nhập lại trước khi vào bàn.');

      const room = rooms.get(data?.roomId);
      if (!room) return rejectRequest(socket, ack, 'Phòng không tồn tại!');

      const existingPlayer = room.players.some(p => p.id === user.id);
      if (existingPlayer) {
        socket.join(room.id);
        clearDisconnectTimer(user.id);
        ack?.({ ok: true, roomId: room.id });
        emitRoomState(room, room.status === 'WAITING' ? 'room:update' : 'game:update');
        return;
      }

      if (room.players.length >= 4) return rejectRequest(socket, ack, 'Phòng đã đầy!');
      if (room.status !== 'WAITING') return rejectRequest(socket, ack, 'Phòng đang chơi!');

      try {
        const balance = await getWalletBalance(user.id);
        if (balance < room.bet) {
          return rejectRequest(socket, ack, `Số dư không đủ! Cần ít nhất ${room.bet.toLocaleString()} Xu để vào bàn (Bạn có ${balance.toLocaleString()} Xu).`);
        }
      } catch (err) {
        console.error('Check wallet error on room join:', err);
        return rejectRequest(socket, ack, 'Không thể kiểm tra số dư. Vui lòng thử lại sau.');
      }

      handlePlayerLeaveRoom(user.id);
      leaveSocketGameRooms(socket);
      room.players.push({ id: user.id, username: user.username, isBot: false, cards: [], hasPassed: false });

      socket.join(data.roomId);
      clearDisconnectTimer(user.id);
      ack?.({ ok: true, roomId: room.id });
      emitRoomState(room, 'room:update');
      broadcastLobbyRooms();
    });

    socket.on('room:leave', (data: { roomId: string }, ack?: RoomAck) => {
      const user = getSocketUser(socket);
      if (!user) return rejectRequest(socket, ack, 'Bạn cần đăng nhập lại!');

      clearDisconnectTimer(user.id);
      socket.leave(data?.roomId);
      handlePlayerLeaveRoom(user.id, data?.roomId);
      ack?.({ ok: true, roomId: data?.roomId });
    });

    socket.on('room:add_bot', (data: { roomId: string }, ack?: RoomAck) => {
      const room = rooms.get(data?.roomId);
      if (!room) return rejectRequest(socket, ack, 'Phòng không tồn tại!');
      const user = getSocketUser(socket);
      if (!user || room.hostId !== user.id) return rejectRequest(socket, ack, 'Chỉ chủ phòng mới được thêm Bot!');
      if (room.status !== 'WAITING') return rejectRequest(socket, ack, 'Không thể thêm Bot khi ván đang diễn ra!');
      if (room.players.length >= 4) return rejectRequest(socket, ack, 'Phòng đã đầy!');

      const botNum = room.players.filter(p => p.isBot).length + 1;
      room.players.push({
        id: `bot_${uuidv4().slice(0, 6)}`,
        username: `Bot ${botNum}`,
        isBot: true,
        cards: [],
        hasPassed: false
      });

      emitRoomState(room, 'room:update');
      broadcastLobbyRooms();
      ack?.({ ok: true, roomId: room.id });
    });

    socket.on('room:start', async (data: { roomId: string }, ack?: RoomAck) => {
      const room = rooms.get(data?.roomId);
      if (!room) return rejectRequest(socket, ack, 'Phòng không tồn tại!');
      const user = getSocketUser(socket);
      if (!user || room.hostId !== user.id) return rejectRequest(socket, ack, 'Chỉ chủ phòng mới được bắt đầu ván!');
      if (room.status !== 'WAITING' && room.status !== 'FINISHED') return rejectRequest(socket, ack, 'Ván đấu đã bắt đầu!');
      if (room.isSettling) return rejectRequest(socket, ack, 'Ván cũ đang được tổng kết. Vui lòng chờ trong giây lát!');

      const N = room.players.length;
      if (N < 2) {
        return rejectRequest(socket, ack, 'Cần ít nhất 2 người chơi (hoặc thêm Bot) để bắt đầu!');
      }

      // Kiểm tra tất cả người chơi thật xem có ai thiếu xu không
      for (const p of room.players) {
        if (!p.isBot) {
          try {
            const balance = await getWalletBalance(p.id);
            if (balance < room.bet) {
              return rejectRequest(socket, ack, `Người chơi ${p.username} không đủ ${room.bet.toLocaleString()} Xu để bắt đầu ván cược!`);
            }
          } catch (err) {
            console.error('Check wallet error on start:', err);
            return rejectRequest(socket, ack, 'Không thể kiểm tra số dư người chơi. Vui lòng thử lại sau.');
          }
        }
      }

      const previousWinner = room.players.findIndex(p => p.rank === 1);

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
      room.isSettling = false;
      room.isDealing = true;
      const dealDurationMs = getDealDurationMs(N);
      const dealingEndsAt = Date.now() + dealDurationMs;
      room.dealingEndsAt = dealingEndsAt;
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
        startingPlayer = previousWinner !== -1 ? previousWinner : 0;
      }

      room.turnIndex = startingPlayer;

      emitRoomState(room, 'game:started');
      broadcastLobbyRooms();
      ack?.({ ok: true, roomId: room.id });

      // The server owns this lock: neither a player nor a bot may move before
      // every card in the dealing animation has reached a seat.
      setTimeout(() => {
        const currentRoom = rooms.get(data.roomId);
        if (
          !currentRoom
          || currentRoom.status !== 'PLAYING'
          || !currentRoom.isDealing
          || currentRoom.dealingEndsAt !== dealingEndsAt
        ) return;

        currentRoom.isDealing = false;
        currentRoom.dealingEndsAt = null;
        emitRoomState(currentRoom, 'game:update');
        checkAndRunBotTurn(currentRoom.id);
      }, dealDurationMs);
    });

    socket.on('game:play', async (data: { roomId: string; cards: { value: number; suit: number }[] }) => {
      try {
        const room = rooms.get(data?.roomId);
        if (!room) return socket.emit('error', 'Phòng không tồn tại!');
        if (room.status !== 'PLAYING') return socket.emit('error', 'Ván bài đã kết thúc!');
        if (room.isDealing) return socket.emit('error', 'Đang chia bài, chưa thể đánh!');

        const user = getSocketUser(socket);
        if (!user) return socket.emit('error', 'Bạn cần đăng nhập lại!');
        const playerIdx = room.players.findIndex(p => p.id === user.id);

        if (playerIdx === -1 || playerIdx !== room.turnIndex) {
          return socket.emit('error', 'Chưa tới lượt của bạn!');
        }
        if (room.ranks[playerIdx] !== undefined) {
          return socket.emit('error', 'Bạn đã được xếp hạng và không thể đánh tiếp!');
        }

        if (!data.cards || !Array.isArray(data.cards) || data.cards.length === 0) {
          return socket.emit('error', 'Vui lòng chọn lá bài cần đánh!');
        }

        const normalizedCards = data.cards.map(c => ({ value: Number(c.value), suit: Number(c.suit) }));
        if (normalizedCards.some(c => !Number.isInteger(c.value) || c.value < 3 || c.value > 15 || !Number.isInteger(c.suit) || c.suit < 0 || c.suit > 3)) {
          return socket.emit('error', 'Dữ liệu lá bài không hợp lệ!');
        }

        const requestedKeys = normalizedCards.map(c => `${c.value}-${c.suit}`);
        const handKeys = new Set(room.players[playerIdx].cards.map(c => `${c.value}-${c.suit}`));
        if (new Set(requestedKeys).size !== requestedKeys.length || requestedKeys.some(key => !handKeys.has(key))) {
          return socket.emit('error', 'Bạn không sở hữu một hoặc nhiều lá bài đã chọn!');
        }

        const playedCards = normalizedCards.map(c => new Card(c.value, c.suit));
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

        const result = await processPlay(room, playerIdx, playedCards);
        if (!result.ok) socket.emit('error', result.error);
      } catch (err: any) {
        console.error('game:play error:', err);
        socket.emit('error', err.message || 'Lỗi khi đánh bài');
      }
    });

    socket.on('game:pass', (data: { roomId: string }) => {
      try {
        const room = rooms.get(data?.roomId);
        if (!room) return socket.emit('error', 'Phòng không tồn tại!');
        if (room.status !== 'PLAYING') return socket.emit('error', 'Ván bài đã kết thúc!');
        if (room.isDealing) return socket.emit('error', 'Đang chia bài, chưa thể bỏ lượt!');

        const user = getSocketUser(socket);
        if (!user) return socket.emit('error', 'Bạn cần đăng nhập lại!');
        const playerIdx = room.players.findIndex(p => p.id === user.id);

        if (playerIdx === -1 || playerIdx !== room.turnIndex) {
          return socket.emit('error', 'Chưa tới lượt của bạn!');
        }
        if (room.ranks[playerIdx] !== undefined) {
          return socket.emit('error', 'Bạn đã được xếp hạng và không thể bỏ lượt!');
        }

        processPass(room, playerIdx);
      } catch (err: any) {
        console.error('game:pass error:', err);
        socket.emit('error', err.message || 'Lỗi khi bỏ lượt');
      }
    });

    socket.on('disconnect', () => {
      const user = getSocketUser(socket);
      if (user) {
        clearDisconnectTimer(user.id);

        const joinedRoomIds = Array.from(rooms.values())
          .filter(room => room.players.some(player => player.id === user.id))
          .map(room => room.id);
        if (joinedRoomIds.length === 0) {
          broadcastLobbyRooms();
          return;
        }

        const delayedRoomIds: string[] = [];
        for (const roomId of joinedRoomIds) {
          const room = rooms.get(roomId);
          if (!room) continue;

          const hasAnotherConnectionInRoom = Array.from(io.sockets.sockets.values())
            .some(otherSocket => getSocketUser(otherSocket)?.id === user.id && otherSocket.rooms.has(roomId));
          if (hasAnotherConnectionInRoom) continue;

          // Chủ phòng thoát phải được chuyển quyền/xóa bàn ngay để sảnh không
          // còn hiển thị phòng ma. Người chơi thường vẫn có khoảng đệm reconnect.
          if (room.hostId === user.id) handlePlayerLeaveRoom(user.id, roomId);
          else delayedRoomIds.push(roomId);
        }

        if (delayedRoomIds.length === 0) return;

        // Chỉ người chơi thường được giữ khoảng đệm reconnect; chủ phòng đã
        // được xử lý ngay ở trên để sảnh không giữ phòng ma.
        const timer = setTimeout(() => {
          disconnectTimers.delete(user.id);
          for (const roomId of delayedRoomIds) {
            const hasAnotherConnectionInRoom = Array.from(io.sockets.sockets.values())
              .some(otherSocket => getSocketUser(otherSocket)?.id === user.id && otherSocket.rooms.has(roomId));
            if (!hasAnotherConnectionInRoom) handlePlayerLeaveRoom(user.id, roomId);
          }
        }, 15000);
        disconnectTimers.set(user.id, timer);
      } else {
        broadcastLobbyRooms();
      }
    });
  });
}
