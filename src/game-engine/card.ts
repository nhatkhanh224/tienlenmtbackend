export enum Suit {
  SPADES = 0,   // Bích
  CLUBS = 1,    // Chuồn
  DIAMONDS = 2, // Rô
  HEARTS = 3    // Cơ
}

export class Card {
  constructor(public value: number, public suit: Suit) {}

  // Trả về true nếu lá bài hiện tại lớn hơn lá bài other
  isGreaterThan(other: Card): boolean {
    if (this.value > other.value) return true;
    if (this.value === other.value) {
      return this.suit > other.suit;
    }
    return false;
  }

  // Tiện ích in ra tên lá bài (dùng cho debug)
  toString(): string {
    const valueNames: { [key: number]: string } = {
      11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2'
    };
    const suitNames = ['Bích', 'Chuồn', 'Rô', 'Cơ'];
    const v = valueNames[this.value] || this.value.toString();
    return `${v} ${suitNames[this.suit]}`;
  }
}
