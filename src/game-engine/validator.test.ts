import { Validator, ComboType, Combo } from './validator';
import { Card, Suit } from './card';

describe('Validator', () => {
  it('should identify SINGLE correctly', () => {
    const cards = [new Card(3, Suit.SPADES)];
    const combo = Validator.getCombo(cards);
    expect(combo.type).toBe(ComboType.SINGLE);
    expect(combo.highestCard.value).toBe(3);
  });

  it('should identify PAIR correctly', () => {
    const cards = [new Card(4, Suit.SPADES), new Card(4, Suit.HEARTS)];
    const combo = Validator.getCombo(cards);
    expect(combo.type).toBe(ComboType.PAIR);
  });

  it('should identify STRAIGHT correctly', () => {
    const cards = [new Card(3, Suit.SPADES), new Card(4, Suit.HEARTS), new Card(5, Suit.CLUBS)];
    const combo = Validator.getCombo(cards);
    expect(combo.type).toBe(ComboType.STRAIGHT);
    expect(combo.cards.length).toBe(3);
  });

  it('should REJECT STRAIGHT containing 2', () => {
    const cards = [new Card(14, Suit.SPADES), new Card(15, Suit.HEARTS), new Card(3, Suit.CLUBS)];
    const combo = Validator.getCombo(cards);
    expect(combo.type).toBe(ComboType.INVALID); // 2 không được nằm trong sảnh
  });

  it('should identify 3 PAIRS correctly', () => {
    const cards = [
      new Card(3, Suit.SPADES), new Card(3, Suit.HEARTS),
      new Card(4, Suit.CLUBS), new Card(4, Suit.DIAMONDS),
      new Card(5, Suit.SPADES), new Card(5, Suit.HEARTS)
    ];
    const combo = Validator.getCombo(cards);
    expect(combo.type).toBe(ComboType.THREE_PAIRS);
  });

  it('should allow 3 PAIRS to chop PIG (2)', () => {
    const pigCombo: Combo = { type: ComboType.SINGLE, cards: [new Card(15, Suit.HEARTS)], highestCard: new Card(15, Suit.HEARTS) };
    const threePairsCombo: Combo = {
      type: ComboType.THREE_PAIRS,
      cards: [],
      highestCard: new Card(5, Suit.HEARTS)
    };
    
    expect(Validator.canPlay(threePairsCombo, pigCombo)).toBe(true);
  });

  it('should allow DRAGON STRAIGHT to chop PAIR OF PIGS', () => {
    const pigPairCombo: Combo = { type: ComboType.PAIR, cards: [new Card(15, Suit.SPADES), new Card(15, Suit.HEARTS)], highestCard: new Card(15, Suit.HEARTS) };
    const dragonCombo: Combo = {
      type: ComboType.DRAGON_STRAIGHT,
      cards: [],
      highestCard: new Card(14, Suit.HEARTS) // Từ 3 đến A
    };
    
    expect(Validator.canPlay(dragonCombo, pigPairCombo)).toBe(true);
  });
});
