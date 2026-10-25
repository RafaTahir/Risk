# Printed physical board and real setup state

The board now separates printed map artwork from actual campaign state. Country names are texture print on the country surfaces in the 3D scene; they follow the physical board's perspective, orientation, fold and lighting. They are not camera-facing SVG text or billboard sprites. The board uses a thin dark frame, parchment sea, darker borders and the familiar yellow/orange/blue/red/green/purple continent palette. The implementation remains original geometry and print artwork, rather than a claim to reproduce every edition-specific illustration.

## Official reference and setup scope

The parent research pass inspected the official Hasbro B7404 board/manual imagery and reported the physical printed labels, thin board, continent colors and grounded pieces used for this correction:

- [Official product/board image](https://www.hasbro.com/common/productimages/en_US/2C7C6F5250569047F5DDEB8AC273BA4C/E3F63CB997C74515BB3145062D730805.jpg)
- [Official B7404 instructions](https://instructions.hasbro.com/api/download/B7404_en-us_risk-game.pdf): board imagery at PDF page index 1; Classic claiming at PDF index 6/printed page 12. Card-dealt allocation in Secret Mission is a different documented setup.
- [Traditional Risk instructions](https://www.hasbro.com/common/instruct/risk.pdf): alternating claims and remaining initial placements before combat.

This executor's own fetches were blocked with CONNECT 403; the retrieval record is preserved separately with release artifacts. The official visual inspection came from the parent research pass. No claim of an independent line-by-line printed-edition rules audit is made.

The existing game intentionally uses **quick automatic setup** with classic world-domination play, not an interactive claiming phase. That choice is labeled before starting. The server assigns all 42 territories, places their initial armies and allocates the remaining starting allowance only after an actual start. Allowances stay 35/30/25/20 per player for 3/4/5/6 players. Traditional manual claiming is described in RULES.md and is not silently substituted with another edition's setup.

A fresh welcome screen, private lobby, or table after leaving has no assigned armies, counters or reserve figures. Rejoining an existing campaign renders that campaign's real authoritative ownership and armies. Opening/canceling setup or resetting the camera does not initialize or reset a game. No seeded demo campaign is passed to the board.

## Camera interaction

Mouse and one-finger orbit use a captured, viewport-normalized gesture anchor. At the player's request both direct-drag axes are reversed: screen-right swivels the far board edge left, and dragging down raises the viewpoint. These directions remain consistent at different board rotations. Wheel/pinch zoom, two-finger pan, keyboard controls and view bounds are unchanged. Small movements remain clicks/taps; pinches and drags do not select territories or send orders. Pinch-to-one-finger transitions rebase the gesture rather than jumping.

The camera radius stays fixed during ordinary orbit/tilt, avoiding automatic zoom changes while the pointer moves. Resize and explicit reset refit deliberately. Zooming out and reset remain available when an intentionally rotated or zoomed board extends beyond the viewport. Text stays printed at every angle; use zoom and orbit to inspect a region, or the accessible territory finder for exact names and counts.

Classic mechanics, multiplayer authority, card privacy, room persistence and schema remain unchanged. Existing DB data, migrations and audience must be preserved by the parent when updating the existing Site.

## Opening, folding and smooth printed contours

Fresh presentation starts with a real folded board and visible back cover. The accessible Open board/Fold board button remains available in every game phase. The right leaf rotates 180° about its centre hinge; board thickness, backside and printed-map geometry are real scene objects. Country surfaces, names, counters and outline segments that cross the crease are split onto the appropriate leaf, so nothing remains detached across the fold. A flush cardboard crease avoids obscuring the map labels.

The folded view now presents a prominent **Open board** button, arrow and first-use click/tap/keyboard instruction directly over the table. A visible Open/Fold text label stays in the header on phones as well as desktops. The primary opening action is idempotent, so a double click cannot close the board again; its pointer input is isolated from the orbit surface. The header control still intentionally supports reversing a fold in progress.

Folding is local presentation only. It preserves armies, cards, selections, camera and preferences and sends no game order. Other players and AI follow the existing turn rules while a board is closed; reopening displays the newest server state. Pieces remain parented at their saved leaf positions and are concealed when the closing cardboard would cover/intersect them, then restored on opening. The board itself never fades or scales to imitate folding. Territory interaction and command submission are blocked while closed or moving; folding cancels only cosmetic troop motion.

A reversal continues from the current hinge pose, including repeated and same-event-loop actions. Reduced motion uses immediate physical endpoints. Reload/resume may present the folded board again but does not deal another game. The 2D/WebGL-unavailable tactical fallback uses honest immediate closed/open views through the same global control, without pretending it renders an animated 3D hinge.

The old straight-edged map is rounded through a shared-boundary contour layer: 304 degree-two corners are rounded, 65 junctions stay fixed, and every neighbour uses identical reversed border samples. Maximum area drift is 1.414%; all 42 identities, components, sea channels and logical adjacency are retained. Geometry tests check edge ownership, exact shared borders, bounded displacement and absence of new crossings. The same contours drive Three.js surfaces, outlines, text clipping, raycasting and SVG fallback. Flat printed land removes extruded edge facets; high quality retains antialiasing, capped pixel ratio and texture anisotropy.
