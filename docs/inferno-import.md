# Inferno import: status and acceptance criteria

Work happens on `codex/inferno-import`. The live game and `main` are unchanged.

## Verified acquisition

GitHub Actions run [39026226707](https://github.com/Aqtaii/quake3-web-arena/actions/runs/39026226707)
successfully retrieved the current official `game/csgo/maps/de_inferno.vpk`
and `game/csgo/gameinfo.gi` directly from Steam content servers.

- App: 730; depot: 2347770; public manifest: 2520908610273941189.
- Manifest timestamp reported by Steam: 2026-10-15 17:23:21.
- Anonymous access succeeded. No Steam password, session token or account was supplied.
- Exactly the two requested files were downloaded, not the entire CS2 installation.
- Downloads and tool execution take place on an ephemeral GitHub-hosted Ubuntu runner.
  This workflow does not clone or download the project to the user's computer.

The workflow records source file sizes, SHA-256 hashes and VPK headers.
It uploads diagnostic reports only, not a playable map.
SteamRE DepotDownloader 3.4.0 is pinned to a release URL.
Source 2 Viewer 20.1 is pinned and its archive checked against the release SHA-256.

## Verified geometry and Wingman metadata

[Run 39026304781](https://github.com/Aqtaii/quake3-web-arena/actions/runs/39026304781)
exported 6,641 render meshes and a separate 92-mesh physics document.
The initial render export had no materials or images because the shared CS2 packages
had not yet been resolved. A successful exporter exit code alone is not completeness.

[Run 39026746105](https://github.com/Aqtaii/quake3-web-arena/actions/runs/39026746105)
identified 48 original Wingman-related entities, including four terrorist and four
counterterrorist spawn placements. Their original coordinates and models are recorded
in `tools/inferno/wingman-source.json`.

These metadata are not a playable map. In particular, `func_nav_blocker` changes
bot navigation and must not be converted directly into a solid player wall.

The dependency resolver reads official VPK indexes, requests required archive chunks
one at a time, extracts requested resources, checks their VPK CRC32 and removes each
chunk afterward. The export auditor checks geometry counts, buffer bounds and
missing resource references. Both run on the GitHub runner, with no local project clone.

## Conversion stages still required

1. Export the real map geometry, material references and physics from the official VPK.
2. Resolve shared CS2 assets from official Steam depots. Missing assets must be reported,
   rather than silently replaced with unrelated Quake textures.
3. Identify the actual Wingman play area and original placements from map entities.
   Keep source coordinates and record the conversion of axes and scale.
4. Convert render surfaces and collision to Quake III BSP version 46.
   A glTF preview alone is not a playable Quake map.
5. Adapt materials to the existing WebGL renderer and bake suitable lighting.
6. Package the result as a PK3, with a reproducible source manifest.
7. Register the installed map in the browser lobby and the dedicated WASM server together.
8. Test two clients in the same room, spawn clearance, stairs, walls, projectiles,
   map boundaries, visual completeness and memory use.

Do not expose an Inferno option until the BSP and required assets are actually packaged.
Do not label a recreated layout or a textureless third-party model as the original map.
Do not use `de_inferno_vanity`, which is a menu-background variant.

## Reproduce the acquisition probe

The workflow runs when its file changes on this branch. Its reports are visible in the
GitHub Actions run summary and the `inferno-acquisition-report` artifact.
When merged into the default branch it can also be started manually.
The workflow has read-only repository permissions and does not deploy or commit generated files.

References:
- [SteamRE DepotDownloader](https://github.com/SteamRE/DepotDownloader)
- [Source 2 Viewer map export](https://s2v.app/ValveResourceFormat/guides/exporting-maps.html)
- [Source 2 Viewer CLI](https://s2v.app/ValveResourceFormat/guides/command-line.html)

Source 2 export does not preserve the original lighting or game logic automatically.
Asset redistribution permissions must be assessed before publishing Valve assets as a web download.
