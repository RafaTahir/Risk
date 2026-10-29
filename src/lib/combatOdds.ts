/** Exact probability that a single legal Risk roll removes a defending army. */
const cache = new Map<string, number>();
export function defenderLossChance(attackerDice: number, defenderDice: number): number {
  if (!Number.isInteger(attackerDice) || attackerDice < 1 || attackerDice > 3 || !Number.isInteger(defenderDice) || defenderDice < 1 || defenderDice > 2) throw new RangeError('Invalid Risk dice');
  const key = `${attackerDice}:${defenderDice}`, known = cache.get(key);
  if (known !== undefined) return known;
  let wins = 0, rolls = 0;
  const dice = Array<number>(attackerDice + defenderDice).fill(1);
  function visit(index: number): void {
    if (index < dice.length) { for (let value = 1; value <= 6; value++) { dice[index] = value; visit(index + 1); } return; }
    const attacker = dice.slice(0, attackerDice).sort((a, b) => b - a);
    const defender = dice.slice(attackerDice).sort((a, b) => b - a);
    rolls++;
    if (defender.some((value, i) => i < attacker.length && attacker[i] > value)) wins++;
  }
  visit(0); const chance = wins / rolls; cache.set(key, chance); return chance;
}
