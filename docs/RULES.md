# Rules used by World Command

This implementation uses traditional **Risk world domination for 3–6 players**, with the classic progressive card exchange schedule and **adjacent-territory fortification**. The objective is to control all 42 territories. It does not implement missions, capitals, two-player neutral armies, fixed card values, or connected-path fortification.

## Setup and automated decisions

The server randomizes player order. Territory assignment and initial army placement are automatic: shuffled territories are dealt evenly, one army is placed on each, then each player's remaining armies are distributed randomly among their territories. The total starting allowance is 35 armies each for three players, 30 for four, 25 for five, and 20 for six. This automates initial placement; the traditional tabletop game lets players choose their territories and initial placements in turn.

Defenders automatically roll the maximum legal dice (two with at least two armies, otherwise one). The tabletop defender may choose one die instead. These are automated legal choices, not a new combat formula. Attackers choose one to three dice, limited to the attacking territory's armies minus one.

## Each turn

1. **Reinforce.** Receive the greater of three armies or one per three owned territories, rounded down, plus any controlled continents: North America 5, South America 2, Europe 5, Africa 3, Asia 7, Australia 2. Place all reinforcements on owned territories before attacking.
2. **Attack.** Attack an adjacent enemy territory, including the map's sea connections, while leaving at least one army behind. Roll dice, sort each side descending, and compare corresponding dice. Each comparison removes one army; ties favor the defender. Repeat or stop voluntarily.
3. **Occupy.** After conquest, move at least the number of attacking dice used in the winning roll and at most all but one army from the attacking territory. Complete occupation before any other action.
4. **Fortify.** Optionally move armies from one owned territory to one **adjacent** owned territory, leaving at least one behind. One movement ends the turn; skipping it also ends the turn.
5. **Draw.** Receive exactly one card if at least one territory was conquered that turn, irrespective of the number conquered. Shuffle the discard pile when the draw pile is empty.

## Cards and elimination

There are 42 territory cards (14 infantry, 14 cavalry, 14 artillery) and two wild cards. Symbols are assigned evenly by map order; their territory-to-symbol pairing is an implementation choice rather than a reproduction of a specific printed deck. A set is three of the same symbol or one of each, with wild cards substituting for any symbol. The shared exchange schedule is 4, 6, 8, 10, 12, 15, then increases by 5 for every later set, regardless of who trades.

At the start of a turn, five or more cards require an exchange before deployment. Smaller valid sets may be exchanged voluntarily. If a traded set includes a territory the player owns, add two armies directly to exactly one such territory. The player may select that territory; if omitted, the engine chooses the first eligible submitted card. The bonus cannot be split.

Eliminating a player transfers all their cards to the conqueror. If this leaves six or more cards, finish occupation, exchange sets until four or fewer cards remain, then deploy the exchange reinforcements before resuming attacks. With five or fewer inherited cards, wait until a later turn to exchange them. During a mandatory inherited-card interruption, optional additional exchanges after reaching four or fewer cards are prohibited. The game ends after completing occupation of the final enemy territory; no further exchanges or turns are needed.

## Source and verification status

Reference: Hasbro's traditional Risk instruction booklet, historically published at <https://www.hasbro.com/common/instruct/risk.pdf>. Its original world-domination conventions above are the intended rule baseline. The development environment's network proxy denied access to that URL (HTTP 403 on CONNECT), so the booklet could not be retrieved and compared line by line during this implementation. No publication date or exact printed edition is claimed. This source limitation is distinct from the executable rules checks.

Automated tests exercise setup allowances, continent bonuses and borders, reinforcement and malformed-action validation, dice sorting and ties, occupation limits, adjacent fortification, card sets and the exchange schedule, elimination and forced exchanges, deck conservation, and complete deterministic AI games across all three difficulty levels. These tests validate the stated implementation; they do not substitute for an independent review against a physical rulebook.
