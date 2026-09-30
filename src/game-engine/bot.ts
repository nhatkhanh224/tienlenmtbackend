import { Card } from './card';
import type { Combo } from './validator';
import { ComboType, Validator } from './validator';

interface ExtractedHand {
  fourPairs: Card[][];
  fourOfKinds: Card[][];
  threePairs: Card[][];
  straights: Card[][];
  threeOfKinds: Card[][];
  pairs: Card[][];
  singles: Card[][];
  allCombos: Card[][];
}

export class BotAI {
  static groupByValue(hand: Card[]): { [key: number]: Card[] } {
    const groups: { [key: number]: Card[] } = {};
    hand.forEach(c => {
      if (!groups[c.value]) groups[c.value] = [];
      groups[c.value].push(c);
    });
    return groups;
  }

  static extractCombos(hand: Card[]): ExtractedHand {
    let remaining = Validator.sortCards([...hand]);
    const result: ExtractedHand = {
      fourPairs: [],
      fourOfKinds: [],
      threePairs: [],
      straights: [],
      threeOfKinds: [],
      pairs: [],
      singles: [],
      allCombos: []
    };

    const groups = this.groupByValue(remaining);
    for (const valStr in groups) {
      if (groups[valStr].length === 4) {
        result.fourOfKinds.push(groups[valStr]);
        result.allCombos.push(groups[valStr]);
        remaining = remaining.filter(c => c.value !== Number(valStr));
      }
    }

    let remainingGroups = this.groupByValue(remaining);
    let pairValues: number[] = [];
    for (const valStr in remainingGroups) {
      if (remainingGroups[valStr].length >= 2 && Number(valStr) < 15) {
        pairValues.push(Number(valStr));
      }
    }
    pairValues.sort((a, b) => a - b);
    
    let i = 0;
    while (i < pairValues.length) {
      let seq = [pairValues[i]];
      let j = i + 1;
      while (j < pairValues.length && pairValues[j] === seq[seq.length - 1] + 1) {
        seq.push(pairValues[j]);
        j++;
      }
      
      if (seq.length >= 4) {
        const fourPairCards: Card[] = [];
        for (let k = 0; k < 4; k++) {
          const val = seq[seq.length - 1 - k];
          fourPairCards.push(remainingGroups[val][0], remainingGroups[val][1]);
          remaining = remaining.filter(c => !(c.value === val && (c.suit === remainingGroups[val][0].suit || c.suit === remainingGroups[val][1].suit)));
        }
        const sorted4Pairs = Validator.sortCards(fourPairCards);
        result.fourPairs.push(sorted4Pairs);
        result.allCombos.push(sorted4Pairs);
      } else if (seq.length === 3) {
        const threePairCards: Card[] = [];
        for (let k = 0; k < 3; k++) {
          const val = seq[k];
          threePairCards.push(remainingGroups[val][0], remainingGroups[val][1]);
          remaining = remaining.filter(c => !(c.value === val && (c.suit === remainingGroups[val][0].suit || c.suit === remainingGroups[val][1].suit)));
        }
        const sorted3Pairs = Validator.sortCards(threePairCards);
        result.threePairs.push(sorted3Pairs);
        result.allCombos.push(sorted3Pairs);
      }
      i = j;
    }

    let straightFound = true;
    while (straightFound) {
      straightFound = false;
      const currentGroups = this.groupByValue(remaining.filter(c => c.value < 15));
      const vals = Object.keys(currentGroups).map(Number).sort((a, b) => a - b);
      
      let bestSeq: number[] = [];
      let curSeq: number[] = [];
      
      for (let v of vals) {
        if (curSeq.length === 0 || v === curSeq[curSeq.length - 1] + 1) {
          curSeq.push(v);
        } else {
          if (curSeq.length >= 3 && curSeq.length > bestSeq.length) {
            bestSeq = [...curSeq];
          }
          curSeq = [v];
        }
      }
      if (curSeq.length >= 3 && curSeq.length > bestSeq.length) {
        bestSeq = [...curSeq];
      }
      
      if (bestSeq.length >= 3) {
        straightFound = true;
        const sCards: Card[] = [];
        for (const val of bestSeq) {
          sCards.push(currentGroups[val][0]);
          remaining = remaining.filter(c => !(c.value === val && c.suit === currentGroups[val][0].suit));
        }
        const sortedStraight = Validator.sortCards(sCards);
        result.straights.push(sortedStraight);
        result.allCombos.push(sortedStraight);
      }
    }

    remainingGroups = this.groupByValue(remaining);
    for (const valStr in remainingGroups) {
      if (remainingGroups[valStr].length === 3) {
        result.threeOfKinds.push(remainingGroups[valStr]);
        result.allCombos.push(remainingGroups[valStr]);
        remaining = remaining.filter(c => c.value !== Number(valStr));
      }
    }

    remainingGroups = this.groupByValue(remaining);
    for (const valStr in remainingGroups) {
      if (remainingGroups[valStr].length === 2) {
        result.pairs.push(remainingGroups[valStr]);
        result.allCombos.push(remainingGroups[valStr]);
        remaining = remaining.filter(c => c.value !== Number(valStr));
      }
    }

    const singleCards = Validator.sortCards(remaining).map(c => [c]);
    result.singles = singleCards;
    result.allCombos.push(...singleCards);

    return result;
  }

  static getBestMove(hand: Card[], centerCombo: Combo | null, isNewRound: boolean, isFirstMove: boolean = false): Card[] {
    const sortedHand = Validator.sortCards(hand);
    const extracted = this.extractCombos(sortedHand);
    
    const allSortedCombos = extracted.allCombos.sort((a, b) => {
        const aMin = Math.min(...a.map(c => c.value));
        const bMin = Math.min(...b.map(c => c.value));
        return aMin - bMin;
    });

    if (isFirstMove) {
      const comboWith3Spades = allSortedCombos.find(combo => combo.some(c => c.value === 3 && c.suit === 0));
      if (comboWith3Spades) return comboWith3Spades;
      return [sortedHand.find(c => c.value === 3 && c.suit === 0)!];
    }

    if (isNewRound || !centerCombo) {
      const smallestCard = sortedHand[0];
      const comboWithSmallest = allSortedCombos.find(combo => combo.some(c => c.value === smallestCard.value && c.suit === smallestCard.suit));
      if (comboWithSmallest) return comboWithSmallest;
      return [smallestCard];
    }

    for (const comboCards of allSortedCombos) {
      const candidateCombo = Validator.getCombo(comboCards);
      if (Validator.canPlay(candidateCombo, centerCombo)) {
        if (candidateCombo.type === ComboType.FOUR_OF_KIND || candidateCombo.type === ComboType.THREE_PAIRS || candidateCombo.type === ComboType.FOUR_PAIRS) {
           if (centerCombo.highestCard.value !== 15) continue;
        }
        return comboCards;
      }
    }

    if (centerCombo.type === ComboType.SINGLE) {
      const validSingles = sortedHand.filter(c => c.isGreaterThan(centerCombo.highestCard));
      if (validSingles.length > 0) {
        return [validSingles[0]];
      }

      if (centerCombo.highestCard.value === 15) {
        if (extracted.threePairs.length > 0) return extracted.threePairs[0];
        if (extracted.fourOfKinds.length > 0) return extracted.fourOfKinds[0];
        if (extracted.fourPairs.length > 0) return extracted.fourPairs[0];
      }
    }

    if (centerCombo.type === ComboType.PAIR) {
      const valueGroups = this.groupByValue(sortedHand);
      const validPairs: Card[][] = [];
      for (const valStr in valueGroups) {
        const cards = valueGroups[valStr];
        if (cards.length >= 2) {
          const candidatePair = [cards[0], cards[1]];
          const combo = Validator.getCombo(candidatePair);
          if (Validator.canPlay(combo, centerCombo)) {
            validPairs.push(candidatePair);
          }
        }
      }
      if (validPairs.length > 0) {
         return validPairs[0];
      }

      if (centerCombo.highestCard.value === 15) {
        if (extracted.fourOfKinds.length > 0) return extracted.fourOfKinds[0];
        if (extracted.fourPairs.length > 0) return extracted.fourPairs[0];
      }
    }

    return [];
  }
}
