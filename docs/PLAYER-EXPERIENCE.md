# Tactical clarity and optional teaching

## Assessment

The physical table already had a strong central identity, fast solo entry, camera gestures, exact army badges, multiplayer recovery, and optional menus. Three gaps made the next decision harder than it needed to be:

1. Adjacent destinations had only a quiet color change, and eligible starting territories were not identified. Users had to discover legal moves by trial and error.
2. The army picker did not explain the resulting source/destination counts. Some owned territories showed attack controls even when no adjacent enemy existed.
3. Brief dice feedback did not explain paired comparisons or casualties. The field manual contained all the rules, but reaching the rule relevant to a first turn required reading a longer document.

This update addresses those gaps within the existing board, controls, and optional dialogs. It adds no puzzle minigames, currencies, progression systems, new Risk rules, forced tutorial, extra confirmation step, or camera movement.

## Research translated into this game

These are focused lessons from the research supplied by the managing task, not a claim to have audited every AAA game or copied its content.

| Source | Relevant design lesson | Risk implementation |
| --- | --- | --- |
| [Nintendo, Tears of the Kingdom developer interview](https://www.nintendo.com/au/news-and-articles/ask-the-developer-vol-9-the-legend-of-zelda-tears-of-the-kingdom-chapter-5/) | Consistent actions let players plan their own solutions. | Distinct source diamonds, destination rings and a route arrow identify legal options without choosing a strategy for the player. |
| [Valve interview about Portal 2](https://www.gamedeveloper.com/design/rewarding-the-players-valve-on-i-portal-2-i-) | Teach consistent interactions at a readable pace; allow experimentation. | Selecting and previewing never issues an order. Clear selection or Escape cancels a plan; explicit buttons commit it. Random combat remains final once confirmed. |
| [Tomb Raider difficulty and assistance](https://blog.playstation.com/?p=203510) | Assistance can be separate from combat difficulty. | Optional phase lessons work with every AI difficulty; opening a lesson changes no rules or opponent behavior. |
| [God of War Ragnarök accessibility](https://www.playstation.com/en-us/games/god-of-war-ragnarok/accessibility/) | Support contrast, motion and sound preferences independently. | A saved tactical-contrast toggle adds brighter labels/markers. System reduced motion and instant pieces remain supported; no outcome waits on animation. |
| [The Last of Us Part II accessibility](https://www.naughtydog.com/blog/the_last_of_us_part_ii_accessibility_features_detailed) | Optional help and visual equivalents keep information accessible. | A reopenable phase guide, visible casualty text and a paired-dice report explain the same confirmed state with sound off. |

All geometry, interface and code are original to this project. Inspiration does not imply affiliation with these publishers.

## Player-visible behavior

- Diamonds identify legal origins; rings identify adjacent destinations. Shapes and accessible labels supplement color. A directional arrow follows camera projection for a selected legal pair. The Alaska–Kamchatka seam deliberately omits an arrow across the whole world; both endpoints stay marked and named in the dock.
- The dock previews exact post-deploy, post-advance and post-fortification counts. Attack previews show legal attacking/defending dice and the leave-one/tie rules. Unusable selections explain why they cannot act.
- The ? button or Explain this phase menu item opens optional Reinforce, Attack, Advance and Fortify lessons. They include the selected territory's adjacency and continent progress, and the normal reinforcement calculation. Lessons are never forced over the board and reopen on the current phase. Tabs support arrow/Home/End keys.
- Battle feedback immediately shows dice and authoritative losses. An optional Battle report pairs the dice, explains ties, shows casualties and the confirmed ownership result. An open report is a frozen snapshot so a later AI/player roll cannot interrupt reading; reopening shows the latest roll. This local recap lasts only for the current mounted campaign; the existing room history remains authoritative.
- Clear selection or Escape cancels a preview. Required post-conquest occupation remains mandatory. Turn changes clear old selections, and invalidated targets clear after state updates.
- A synchronous request lock prevents two fast taps from issuing separate commands before disabled controls render. Existing server authority, revision checks, idempotency and card privacy remain intact.

The physical board/pieces/opening, orbit/tilt/pan/zoom, network modes, saved room schema and classic rules remain unchanged. No database migration or reset is required. No publication, push or sharing change is part of this implementation handoff.

## Validation

TypeScript, the self-contained build,75 automated tests and all11 HTTP browser scenarios pass. See VALIDATION.md and the current handoff/checkpoint for artifacts. New tests compare presentation affordances to actual authoritative engine acceptance across all territory pairs, rather than only reproducing the UI's conditions. Browser checks distinguish real Worker commands from explicitly intercepted presentation-only tie/capture fixtures. Phone checks use touch/mobile emulation; no physical-device performance claim is made.
