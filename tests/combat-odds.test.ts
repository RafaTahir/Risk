import { describe, expect, it } from 'vitest';
import { defenderLossChance } from '../src/lib/combatOdds';
describe('one battle roll', () => {
  it('counts ties as defender wins and matches exact dice distributions', () => {
    expect(defenderLossChance(1, 1)).toBeCloseTo(15 / 36, 12);
    expect(defenderLossChance(1, 2)).toBeCloseTo(55 / 216, 12);
    expect(defenderLossChance(2, 1)).toBeCloseTo(125 / 216, 12);
    expect(defenderLossChance(3, 1)).toBeCloseTo(855 / 1296, 12);
    expect(defenderLossChance(3, 2)).toBeCloseTo(5501 / 7776, 12);
  });
  it('rejects dice counts the rules never allow', () => {
    expect(() => defenderLossChance(0, 1)).toThrow();
    expect(() => defenderLossChance(3, 3)).toThrow();
  });
});
