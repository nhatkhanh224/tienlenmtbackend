import { Deck } from './deck';
import { Card } from './card';
import { Validator, Combo, ComboType } from './validator';
import { GAME_RULES } from './rule-config';

export enum GameStatus {
  WAITING = 'WAITING',
  PLAYING = 'PLAYING',
  FINISHED = 'FINISHED'
}

export interface PlayerState {
  id: string;
  username: string;
  cards: Card[];
  hasPassed: boolean; // Bỏ lượt trong vòng hiện tại
}

export class GameState {
  roomId: string;
  status: GameStatus = GameStatus.WAITING;
  players: PlayerState[] = [];
  deck: Deck = new Deck();
  
  turnIndex: number = 0; // Index của người đang tới lượt
  firstTurnOfGame: boolean = true;
  lastPlayedCombo: Combo | null = null;
  lastPlayedPlayerId: string | null = null;

  constructor(roomId: string) {
    this.roomId = roomId;
  }

  join(playerId: string, username: string) {
    if (this.players.length >= 4) throw new Error("Phòng đã đầy");
    if (this.status !== GameStatus.WAITING) throw new Error("Phòng đang chơi");
    this.players.push({ id: playerId, username, cards: [], hasPassed: false });
  }

  leave(playerId: string) {
    this.players = this.players.filter(p => p.id !== playerId);
    if (this.players.length === 0) {
      this.status = GameStatus.FINISHED;
    }
  }

  start() {
    if (this.players.length < 2) throw new Error("Cần ít nhất 2 người để bắt đầu");
    this.status = GameStatus.PLAYING;
    this.deck.initialize();
    this.deck.shuffle();
    
    const hands = this.deck.deal();
    this.players.forEach((p, idx) => {
      p.cards = hands[idx];
      p.hasPassed = false;
    });

    this.firstTurnOfGame = true;
    this.lastPlayedCombo = null;
    this.lastPlayedPlayerId = null;

    // Tìm người có 3 Bích đi trước (hoặc lá nhỏ nhất tùy vào rules)
    this.turnIndex = this.findFirstPlayerIndex();
  }

  private findFirstPlayerIndex(): number {
    let minCard = new Card(16, 3); // Giá trị ảo cực lớn (Suit 3 = Cơ)
    let minIndex = 0;
    
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (p.cards.length > 0) {
        // Bài đã được sort, lá đầu tiên là nhỏ nhất của người đó
        const pMinCard = p.cards[0];
        if (minCard.isGreaterThan(pMinCard)) {
          minCard = pMinCard;
          minIndex = i;
        }
      }
    }
    return minIndex;
  }

  // Chuyển lượt sang người kế tiếp (bỏ qua những người đã pass)
  nextTurn() {
    // Nếu tất cả những người khác đều pass, vòng chơi mới bắt đầu
    const activePlayers = this.players.filter(p => !p.hasPassed);
    if (activePlayers.length <= 1) {
      // Vòng mới
      this.players.forEach(p => p.hasPassed = false);
      this.lastPlayedCombo = null;
      // Người đánh cuối cùng sẽ được đánh tiếp vòng mới
      this.turnIndex = this.players.findIndex(p => p.id === this.lastPlayedPlayerId);
      if (this.turnIndex === -1) this.turnIndex = 0;
      return;
    }

    let nextIdx = (this.turnIndex + 1) % this.players.length;
    while (this.players[nextIdx].hasPassed || this.players[nextIdx].cards.length === 0) {
      nextIdx = (nextIdx + 1) % this.players.length;
    }
    this.turnIndex = nextIdx;
  }

  passTurn(playerId: string) {
    if (this.players[this.turnIndex].id !== playerId) throw new Error("Chưa tới lượt");
    if (this.lastPlayedCombo === null) throw new Error("Không thể bỏ lượt khi vòng mới bắt đầu");
    
    this.players[this.turnIndex].hasPassed = true;
    this.nextTurn();
  }

  playCards(playerId: string, cardIndexes: number[]) {
    if (this.players[this.turnIndex].id !== playerId) throw new Error("Chưa tới lượt");
    
    const player = this.players[this.turnIndex];
    const playedCards = cardIndexes.map(idx => player.cards[idx]);
    const combo = Validator.getCombo(playedCards);

    if (combo.type === ComboType.INVALID) {
      throw new Error("Bộ bài đánh ra không hợp lệ");
    }

    if (this.firstTurnOfGame && GAME_RULES.must_play_3_spades_first_round) {
      const minCard = player.cards[0];
      const containsMinCard = playedCards.some(c => c.value === minCard.value && c.suit === minCard.suit);
      if (!containsMinCard) throw new Error("Ván đầu phải đánh lá bài nhỏ nhất");
    }

    if (!Validator.canPlay(combo, this.lastPlayedCombo)) {
      throw new Error("Không thể chặt bài này");
    }

    if (Validator.wouldFinishWithPig(player.cards, playedCards)) {
      throw new Error("Không được đánh Heo (2) để về cuối");
    }

    // Đánh thành công
    this.firstTurnOfGame = false;
    this.lastPlayedCombo = combo;
    this.lastPlayedPlayerId = playerId;

    // Loại bỏ bài đã đánh khỏi tay
    player.cards = player.cards.filter((_, idx) => !cardIndexes.includes(idx));

    // Kiểm tra hết bài chưa
    if (player.cards.length === 0) {
      this.status = GameStatus.FINISHED;
      return { isWin: true };
    }

    this.nextTurn();
    return { isWin: false };
  }
}
