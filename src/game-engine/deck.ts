import { Card, Suit } from './card';

export class Deck {
  cards: Card[] = [];

  constructor() {
    this.initialize();
  }

  initialize() {
    this.cards = [];
    // Khởi tạo 52 lá bài
    for (let value = 3; value <= 15; value++) {
      for (let suit = 0; suit <= 3; suit++) {
        this.cards.push(new Card(value, suit));
      }
    }
  }

  shuffle() {
    // Thuật toán xáo bài Fisher-Yates
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
    }
  }

  // Chia cho 4 người, mỗi người 13 lá
  deal(): Card[][] {
    const hands: Card[][] = [[], [], [], []];
    for (let i = 0; i < 52; i++) {
      hands[i % 4].push(this.cards[i]);
    }
    // Sắp xếp bài trên tay mỗi người để dễ xử lý (theo value, rồi suit)
    for (let i = 0; i < 4; i++) {
      hands[i].sort((a, b) => a.isGreaterThan(b) ? 1 : -1);
    }
    return hands;
  }
}
