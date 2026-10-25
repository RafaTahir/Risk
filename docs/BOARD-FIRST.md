# Board-first tabletop update

The game now opens directly onto the authored 3D table. The previous permanent roster, command panel, history panel, setup card, navigation and footer have been replaced with a small turn indicator, contextual actions and optional menus. Solo starts in one click; optional AI/name settings and multiplayer setup remain available.

## Physical board and interaction

- The board has a thick walnut/brass frame, printed continent colors, a centre hinge and a brief opening animation. Open board in View replays it; reduced motion skips it.
- Shared low-poly geometry provides shiny infantry and cannons on territories and reserve trays. Pieces illustrate armies; exact numerical badges remain authoritative and reserve trays are representative, so users need not count physical stock manually.
- One-finger or mouse drag orbits/tilts the board. Two fingers pinch to zoom and pan. Shift/right-drag or the Pan map control pans. Wheel zoom, keyboard controls, explicit rotate/tilt controls, reset and fit remain available.
- Portrait frames the board along the phone's long axis. Orientation changes reframe it while retaining the user's camera offsets, rather than leaving a narrow portrait strip in landscape.
- Ownership is shown by colored pieces and badges; printed continent colors stay fixed. Names reveal on selection/hover/focus or closer zoom on small screens.
- Reinforcement animations move pieces from a reserve tray to their destination. Attack and fortification animations remain brief. No shadows maps or external models/textures were added; a small generated contact shadow grounds the board.

## Controls and preserved features

The contextual dock appears for a human turn or territory inspection. It retains army counts/MAX, 1–3 attacker dice, conquest movement limits, one adjacent fortification, ending attacks/turns and forced card trades. Troop commands require explicit action buttons; orbiting, panning, zooming and selecting do not issue them.

Players and their territory/army/card statistics, private room codes, host AI controls, cards and territory bonuses, continent bonuses, history, full rules, sound, motion/quality settings and the 2D fallback remain accessible through compact controls/menu. Long optional content scrolls inside its dialog, not around a dashboard.

Classic mechanics, AI algorithms, Socket.IO/HTTP transports, Worker authority, D1 persistence, session keys and migrations are unchanged. An existing saved game resumes through the same session token and serialized state.

## Verification

- `npm run build:sites:standalone` passes TypeScript and builds the complete one-file Worker.
- `npm test`:59 passed. The shared rules/backend/security/runtime suites remain unchanged and green.
- Final self-contained Worker browser run:8/8 passed in about1.5minutes. It exercises the new board/menus/dock, physical opening, orbit/tilt/pan/zoom, actual territory clicks/taps, private multiplayer, conquest/occupation/fortification/card gain, reload/rejoin, card privacy, polling recovery/stale responses/removal/expiry, mobile, keyboard, reduced motion and WebGL fallback.
- Explicit network audits confirm gestures and selection issue zero troop actions, with no outside-origin or Socket.IO requests in HTTP mode.
- Mobile checks use390×844 touch/mobile emulation plus844×390 landscape. Actual touch deployment succeeds, the selected territory badge has zero overlap with the dock in normal/zoomed/reset/landscape cases, and the orientation framing regression is covered. No physical-phone proof is claimed.
- Typical scene cost is181 draw calls and about24–25thousand triangles. Idle frames stop once the short opening/movement completes. DPR remains capped at1.5/1; these are local software-Chromium measurements, not an old-hardware FPS guarantee.

## Update the existing private Site

Use the same approved release branch and existing private Site. Rebuild and replace the complete Worker module using the parent's official starter/manifest. **Preserve the existing DB binding and data.** No migration/schema change is part of this update; do not recreate the database or rerun an already applied migration. Do not create a second Site or change sharing.

The parent owns native publication and must verify the actual existing endpoint after updating it. This child validates and transfers the source/artifact; it does not publish a new Site.
