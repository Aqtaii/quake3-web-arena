# Genuine Inferno Wingman import

Compiled and runtime-verified in [Run 39037434835](https://github.com/Aqtaii/quake3-web-arena/actions/runs/39037434835).
Registered as `inferno_wingman` (`Inferno · Yoldaş`) in `web/game-data.json` with server-side map-only loading (`inferno-map.pk3` in `serverPackages`).

## Verified source

Official Steam app 730, depot 2347770, manifest 2520908610273941189
(2026-10-15 17:23:21). Anonymous acquisition works without user credentials.
Only Inferno and the shared archive chunks needed by its dependencies are requested.
All acquisition, conversion and testing execute on GitHub-hosted cloud runners.
No project is cloned or downloaded to the user's computer.

[Complete textured export](https://github.com/Aqtaii/quake3-web-arena/actions/runs/39027347591):

- Render: 6,754 meshes, 7,131 nodes, 8,486,377 triangles, 923 materials, 869 images.
- Physics: 591 meshes, 74,467 triangles.
- No missing required source assets, missing output images or invalid buffer ranges.
- Requested archive resources were checked against their original VPK CRC32.
- This validates source extraction, not Quake playability.

## Verified Wingman region

[Region validation](https://github.com/Aqtaii/quake3-web-arena/actions/runs/39029313061)
found 806 reachable areas of the original 2,738-area NAV, using five original
Wingman navigation blockers and all eight original spawn placements.

Playable NAV bounds in original Source units:
(511.99997, -762.50018, 79.99993) to (2661.5, 1538.49988, 301.99991).

Four T spawns lie slightly outside the baked full-map NAV. Flood-fill seeds use
their measured nearest walkable area within a bounded 128-unit search; the original
spawn coordinates are retained. Navigation blockers are never treated as player walls.

Metadata live in wingman-source.json, region-source.json and lighting-source.json.

## Conversion and current candidate

The pipeline crops actual source triangles to a context around the verified region.
It copies retained vertex attributes, preserves scene transforms and compacts buffers.
Source physics is separate from visible geometry; triggers and nav volumes are excluded.

[Native glTF-to-BSP fixture](https://github.com/Aqtaii/quake3-web-arena/actions/runs/39028636751)
verified BSP version 46 and exact source axes/units. q3map2's Assimp conversion is
compensated by misc_model angles "0 90 0" and modelscale 39.37007874015748.

Texture conversion uses existing cloud Chrome Canvas and own Node code, with no npm
packages. Opaque images become quality-98 JPEG; alpha images become 32-bit TGA.
Original base-colour factors are applied in linear colour space.

The build workflow now prepares real geometry/textures, compiles BSP/PVS/lighting,
checks Quake surface limits and collision/spawn data, and retains candidate PK3 files.
A candidate artifact alone is not a tested or deployed map.

Current prototype limitations:

- Source 2 PBR/HDR lighting is adapted to Quake vertex lighting.
- The sky is currently a colour placeholder; the original cubemap needs conversion.
- Grenade-only clip filters have no identical stock Quake contents bit.
- Source props are static and Source 2 entity logic is not executed.
- Quake spawn Z is offset by 24 units for its player bounding box.
- Collision boundaries, spawn clearance, textures, memory and frame rate require real-map testing.

The lobby and dedicated server now read the installed-map catalog from game-data.json.
The server can load a map-only package without caching client texture packs.
The manifest still contains only the four installed original Quake maps.

## Validation

Import tests verify VPK parsing/CRC metadata, corrupt input rejection, path containment,
glTF bounds, source spawn counts, browser PNG-to-TGA conversion and exact retained
vertex bytes. Dedicated-server tests pass original WASM map startup, API catalog,
uninstalled map rejection, room capacity and owner deletion.

playtest.mjs drives two actual WASM clients in existing cloud Chrome, checks replicated
players, standing/walking collision and browser exceptions, and saves screenshots/logs.

Before enabling Inferno, validate the actual candidate with that harness and visually
inspect it. No recreated layout, unrelated Quake textures or vanity map is substituted.

## Pinned tools

- SteamRE DepotDownloader 3.4.0, official maintainer release.
- Source 2 Viewer 20.1; archive SHA-256:
  29d25a6d6b62377fc5386c3e5145b0a2180a401a50041afe9494b3f503deaef5.
- NetRadiant Custom 20260114; archive SHA-256:
  f48f6f1d0db2b910ef9cb5dc5d8a722852510f3c5c278dc17615c0466b8a7a3d.

The compiler was extracted from the AppImage's SquashFS without running the AppImage
launcher. Only q3map2 itself was executed. No game executable or installer was run.
The user explicitly authorized GitHub storage of converted assets for testing/integration.

References:

- [SteamRE DepotDownloader](https://github.com/SteamRE/DepotDownloader)
- [Source 2 Viewer CLI](https://s2v.app/ValveResourceFormat/guides/command-line.html)
- [Source 2 Viewer map export](https://s2v.app/ValveResourceFormat/guides/exporting-maps.html)
- [q3map2 model importer](https://github.com/Garux/netradiant-custom/blob/master/tools/quake3/q3map2/model.cpp)
