import { Card } from './card';
import { GAME_RULES } from './rule-config';

export enum ComboType {
  INVALID = 0,
  SINGLE = 1,
  PAIR = 2,
  THREE_OF_KIND = 3,
  STRAIGHT = 4,
  THREE_PAIRS = 5,
  FOUR_OF_KIND = 6,
  FOUR_PAIRS = 7,
  DRAGON_STRAIGHT = 8
}

export interface Combo {
  type: ComboType;
  cards: Card[];
  highestCard: Card; // Dùng để so sánh lớn nhỏ
}

export class Validator {
  
  // Chuyển đổi an toàn bất kỳ đối tượng bài nào thành instance của Card
  private static ensureCard(c: any): Card {
    if (!c) return new Card(0, 0);
    if (c instanceof Card) return c;
    return new Card(Number(c.value), Number(c.suit));
  }

  // Sắp xếp bài từ bé đến lớn
  static sortCards(cards: Card[]): Card[] {
    if (!cards || cards.length === 0) return [];
    const instances = cards.map(c => this.ensureCard(c));
    return [...instances].sort((a, b) => a.isGreaterThan(b) ? 1 : -1);
  }

  // Lấy ra loại bộ (Combo) của danh sách lá bài
  static getCombo(cards: Card[]): Combo {
    if (!cards || cards.length === 0) return { type: ComboType.INVALID, cards: [], highestCard: new Card(0,0) };
    
    const cardInstances = cards.map(c => this.ensureCard(c));
    const sorted = this.sortCards(cardInstances);
    const len = sorted.length;
    const highestCard = sorted[len - 1];

    if (len === 1) return { type: ComboType.SINGLE, cards: sorted, highestCard };
    
    if (len === 2) {
      if (sorted[0].value === sorted[1].value) return { type: ComboType.PAIR, cards: sorted, highestCard };
      return { type: ComboType.INVALID, cards: [], highestCard: new Card(0,0) };
    }

    if (len === 3) {
      if (sorted[0].value === sorted[1].value && sorted[1].value === sorted[2].value) {
        return { type: ComboType.THREE_OF_KIND, cards: sorted, highestCard };
      }
    }

    if (len === 4) {
      if (sorted[0].value === sorted[1].value && sorted[1].value === sorted[2].value && sorted[2].value === sorted[3].value) {
        return { type: ComboType.FOUR_OF_KIND, cards: sorted, highestCard };
      }
    }

    if (len === 6 && this.isPairsStraight(sorted)) {
      return { type: ComboType.THREE_PAIRS, cards: sorted, highestCard };
    }

    if (len === 8 && this.isPairsStraight(sorted)) {
      return { type: ComboType.FOUR_PAIRS, cards: sorted, highestCard };
    }

    if (len >= 3 && this.isStraight(sorted)) {
      if (len === 12) return { type: ComboType.DRAGON_STRAIGHT, cards: sorted, highestCard };
      return { type: ComboType.STRAIGHT, cards: sorted, highestCard };
    }

    return { type: ComboType.INVALID, cards: [], highestCard: new Card(0,0) };
  }

  // Kiểm tra sảnh (không chứa 2)
  static isStraight(sortedCards: Card[]): boolean {
    for (let i = 0; i < sortedCards.length - 1; i++) {
      if (sortedCards[i].value === 15) return false; // Sảnh không được chứa 2
      if (sortedCards[i + 1].value - sortedCards[i].value !== 1) return false;
    }
    return true;
  }

  // Kiểm tra chuỗi đôi thông (3 đôi thông, 4 đôi thông)
  static isPairsStraight(sortedCards: Card[]): boolean {
    const pairsCount = sortedCards.length / 2;
    for (let i = 0; i < pairsCount; i++) {
      const card1 = sortedCards[i * 2];
      const card2 = sortedCards[i * 2 + 1];
      if (card1.value === 15) return false; // Không được chứa đôi heo
      if (card1.value !== card2.value) return false; // Phải là đôi
      if (i > 0) {
        const prevPairCard = sortedCards[(i - 1) * 2];
        if (card1.value - prevPairCard.value !== 1) return false; // Phải liên tiếp
      }
    }
    return true;
  }

  // Kiểm tra bài đánh ra (playCombo) có hợp lệ để đè bài trước (prevCombo) không?
  static canPlay(playCombo: Combo, prevCombo: Combo | null): boolean {
    if (!playCombo) return false;
    if (!prevCombo || prevCombo.cards.length === 0) return playCombo.type !== ComboType.INVALID;
    if (playCombo.type === ComboType.INVALID) return false;

    // Đánh cùng loại
    if (playCombo.type === prevCombo.type) {
      if (playCombo.cards.length !== prevCombo.cards.length) return false;
      return playCombo.highestCard.isGreaterThan(prevCombo.highestCard);
    }

    // Luật chặt đặc trưng Miền Trung
    // 1. Sảnh rồng (DRAGON_STRAIGHT) chặt được tất cả mọi thứ
    if (playCombo.type === ComboType.DRAGON_STRAIGHT) return true;

    // 2. Chặt Heo lẻ (Single 2)
    if (prevCombo.type === ComboType.SINGLE && prevCombo.highestCard.value === 15) {
      if (GAME_RULES.three_pairs_chop_pig && playCombo.type === ComboType.THREE_PAIRS) return true;
      if (GAME_RULES.four_chop_pig && playCombo.type === ComboType.FOUR_OF_KIND) return true;
      if (GAME_RULES.four_pairs_chop_pig && playCombo.type === ComboType.FOUR_PAIRS) return true;
    }

    // 3. Chặt Đôi Heo (Pair 2)
    if (prevCombo.type === ComboType.PAIR && prevCombo.highestCard.value === 15) {
      if (GAME_RULES.four_chop_pig_pair && playCombo.type === ComboType.FOUR_OF_KIND) return true;
      if (GAME_RULES.four_pairs_chop_pig_pair && playCombo.type === ComboType.FOUR_PAIRS) return true;
    }

    // 4. Chặt 3 đôi thông
    if (prevCombo.type === ComboType.THREE_PAIRS) {
      if (GAME_RULES.four_chop_three_pairs && playCombo.type === ComboType.FOUR_OF_KIND) return true;
      if (GAME_RULES.four_pairs_chop_three_pairs && playCombo.type === ComboType.FOUR_PAIRS) return true;
    }

    // 5. Chặt Tứ Quý
    if (prevCombo.type === ComboType.FOUR_OF_KIND) {
      if (GAME_RULES.four_pairs_chop_four_of_kind && playCombo.type === ComboType.FOUR_PAIRS) return true;
    }

    return false;
  }

  // Lấy ra tất cả các bộ bài (Combo) hợp lệ có thể tạo từ danh sách lá bài
  static getAllValidCombos(hand: Card[]): Combo[] {
    const combos: Combo[] = [];
    if (!hand || hand.length === 0) return combos;

    const sortedHand = this.sortCards(hand);

    // 1. Single (lá đơn)
    for (const card of sortedHand) {
      combos.push(this.getCombo([card]));
    }

    // Nhóm bài theo value để tạo Đôi, Xám cô, Tứ quý
    const valueMap: { [key: number]: Card[] } = {};
    for (const card of sortedHand) {
      if (!valueMap[card.value]) valueMap[card.value] = [];
      valueMap[card.value].push(card);
    }

    // 2. Đôi (Pair - 2 lá cùng value)
    for (const valStr in valueMap) {
      const cards = valueMap[valStr];
      if (cards.length >= 2) {
        for (let i = 0; i < cards.length; i++) {
          for (let j = i + 1; j < cards.length; j++) {
            combos.push(this.getCombo([cards[i], cards[j]]));
          }
        }
      }
    }

    // 3. Xám cô (Three of a kind - 3 lá cùng value)
    for (const valStr in valueMap) {
      const cards = valueMap[valStr];
      if (cards.length >= 3) {
        for (let i = 0; i < cards.length; i++) {
          for (let j = i + 1; j < cards.length; j++) {
            for (let k = j + 1; k < cards.length; k++) {
              combos.push(this.getCombo([cards[i], cards[j], cards[k]]));
            }
          }
        }
      }
    }

    // 4. Tứ quý (Four of a kind - 4 lá cùng value)
    for (const valStr in valueMap) {
      const cards = valueMap[valStr];
      if (cards.length === 4) {
        combos.push(this.getCombo(cards));
      }
    }

    // 5. Sảnh (Straight - từ 3 đến 12 lá liên tiếp, không chứa 2)
    const nonPigValues = Object.keys(valueMap).map(Number).filter(v => v < 15).sort((a, b) => a - b);
    
    for (let i = 0; i < nonPigValues.length; i++) {
      const currentSeq: number[] = [nonPigValues[i]];
      for (let j = i + 1; j < nonPigValues.length; j++) {
        if (nonPigValues[j] === currentSeq[currentSeq.length - 1] + 1) {
          currentSeq.push(nonPigValues[j]);
          if (currentSeq.length >= 3) {
            const straightCardCombos = this.cartesianProduct(currentSeq.map(v => valueMap[v]));
            for (const sCards of straightCardCombos) {
              const combo = this.getCombo(sCards);
              if (combo.type === ComboType.STRAIGHT || combo.type === ComboType.DRAGON_STRAIGHT) {
                combos.push(combo);
              }
            }
          }
        } else {
          break;
        }
      }
    }

    // 6. 3 đôi thông & 7. 4 đôi thông
    const pairValues = nonPigValues.filter(v => valueMap[v].length >= 2);
    for (let i = 0; i < pairValues.length; i++) {
      // 3 đôi thông
      if (i + 2 < pairValues.length && 
          pairValues[i+1] === pairValues[i] + 1 && 
          pairValues[i+2] === pairValues[i] + 2) {
        const p1List = this.getPairsOfValue(valueMap[pairValues[i]]);
        const p2List = this.getPairsOfValue(valueMap[pairValues[i+1]]);
        const p3List = this.getPairsOfValue(valueMap[pairValues[i+2]]);
        for (const p1 of p1List) {
          for (const p2 of p2List) {
            for (const p3 of p3List) {
              const combo = this.getCombo([...p1, ...p2, ...p3]);
              if (combo.type === ComboType.THREE_PAIRS) {
                combos.push(combo);
              }
            }
          }
        }
      }
      // 4 đôi thông
      if (i + 3 < pairValues.length && 
          pairValues[i+1] === pairValues[i] + 1 && 
          pairValues[i+2] === pairValues[i] + 2 &&
          pairValues[i+3] === pairValues[i] + 3) {
        const p1List = this.getPairsOfValue(valueMap[pairValues[i]]);
        const p4List = this.getPairsOfValue(valueMap[pairValues[i+3]]);
        const p2List = this.getPairsOfValue(valueMap[pairValues[i+1]]);
        const p3List = this.getPairsOfValue(valueMap[pairValues[i+2]]);
        for (const p1 of p1List) {
          for (const p2 of p2List) {
            for (const p3 of p3List) {
              for (const p4 of p4List) {
                const combo = this.getCombo([...p1, ...p2, ...p3, ...p4]);
                if (combo.type === ComboType.FOUR_PAIRS) {
                  combos.push(combo);
                }
              }
            }
          }
        }
      }
    }

    return combos;
  }

  private static getPairsOfValue(cards: Card[]): Card[][] {
    const pairs: Card[][] = [];
    for (let i = 0; i < cards.length; i++) {
      for (let j = i + 1; j < cards.length; j++) {
        pairs.push([cards[i], cards[j]]);
      }
    }
    return pairs;
  }

  private static cartesianProduct(arrays: Card[][]): Card[][] {
    return arrays.reduce<Card[][]>((acc, curr) => {
      const res: Card[][] = [];
      for (const a of acc) {
        for (const c of curr) {
          res.push([...a, c]);
        }
      }
      return res;
    }, [[]]);
  }

  // Lấy ra danh sách index các lá bài có thể playable dựa vào centerCombo và rule
  static getPlayableIndices(hand: Card[], centerCombo: Combo | null, isFirstMove: boolean = false): number[] {
    if (!hand || hand.length === 0) return [];

    const cardInstances = hand.map(c => this.ensureCard(c));
    const allCombos = this.getAllValidCombos(cardInstances);
    const has3SpadesInHand = cardInstances.some(c => c.value === 3 && c.suit === 0);

    if (!centerCombo || centerCombo.cards.length === 0) {
      if (isFirstMove && has3SpadesInHand) {
        const validCombos = allCombos.filter(cb => cb.cards.some(c => c.value === 3 && c.suit === 0));
        const playableCardSet = new Set<string>();
        for (const cb of validCombos) {
          for (const c of cb.cards) {
            playableCardSet.add(`${c.value}-${c.suit}`);
          }
        }
        return cardInstances.map((c, i) => playableCardSet.has(`${c.value}-${c.suit}`) ? i : -1).filter(i => i !== -1);
      }
      return cardInstances.map((_, i) => i);
    }

    let validCombos = allCombos.filter(cb => this.canPlay(cb, centerCombo));

    if (isFirstMove && has3SpadesInHand) {
      validCombos = validCombos.filter(cb => cb.cards.some(c => c.value === 3 && c.suit === 0));
    }

    const playableCardSet = new Set<string>();
    for (const cb of validCombos) {
      for (const c of cb.cards) {
        playableCardSet.add(`${c.value}-${c.suit}`);
      }
    }

    return cardInstances.map((c, i) => playableCardSet.has(`${c.value}-${c.suit}`) ? i : -1).filter(i => i !== -1);
  }
}
