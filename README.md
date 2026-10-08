# Rubik's XR

A hand-tracked Rubik's cube for Meta Quest in passthrough AR (WebXR, three.js, Rapier).
The cube drops onto your table; you pick it up, throw it and turn its faces.

Live at https://meros.github.io/rubiks-xr/ (open it in the Quest Browser).

## Play

| Do this | What happens | What you see |
|---|---|---|
| Pinch near the cube | Grab it; it follows your hand | Outline box: faint when in reach, bright in the hand's colour while held; a ring at your fingers fills as you pinch |
| Open the pinch while you move | Throw or drop it | |
| Point at a face, pinch | Turn that face 90° | Hand ray and reticle; the layer glows; an arrow shows the direction |
| Hold the cube in one hand, poke a face with the other index finger | Turn that face | Same layer glow and arrow, stronger as the finger gets closer |
| Turn the left palm toward you | Wrist menu: New cube, Scramble, Solve / reset | Poke a button with the right index finger |

The right hand turns clockwise (seen from outside the face), the left hand counterclockwise.
Right-hand affordances are cyan, left-hand ones amber.

## Run on a Quest

The headset needs Space Setup with the desk marked as a table. Without a table the cube floats in front of you.

Over USB (no certificate needed, because `localhost` is a secure origin):

```sh
npm install
npm run dev
nix shell nixpkgs#android-tools --command adb reverse tcp:5173 tcp:5173
```

Then open `http://localhost:5173` in the Quest Browser and press **Start AR**. The Quest asks for
permission to use spatial data; allow it, or the table is not found.

Over Wi-Fi: `HTTPS=1 npm run dev -- --host` and open `https://<your-ip>:5173` (accept the self-signed certificate).

## Develop on the desktop

A browser without WebXR AR loads the Immersive Web Emulation Runtime (IWER): an emulated Quest 3 with
hands and a scanned room. `?emulate` forces it, `?room=living_room` picks another room
(`office_small`, `office_large`, `living_room`, `meeting_room`, `music_room`), `?nodevui` hides its control panel.
`window.__game` exposes the state and the emulated device for scripted tests.

## Model

`public/cube.glb` is exported from `blender/rubiks_cube.blend` (26 cubie nodes, about 33k triangles).
`src/cube.ts` holds the cube state: each cubie's grid position and orientation, the turn queue and the solved check.
`blender/rubiks_cube_build.py` rebuilds that scene; it loads `rubiks_turns.py` from its own folder.

## Status

Personal project. Playable on a Quest; each push to `main` deploys to GitHub Pages.

## License

0BSD. See [LICENSE](LICENSE).
