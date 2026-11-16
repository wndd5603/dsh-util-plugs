# Demos

Synthetic clean-profile recordings for the README. No live data, credentials, private project names or user paths are used.

| File | What it shows |
|---|---|
| `collaboration.gif` | Sidebar “协作网络” panel: demo task board, task detail, status filters and cursor movement. |
| `plugin-console.gif` | Unified plugin console cards, status badges and configuration entry points. |

## Regenerate

Requirements: Node ≥20, Playwright + Chromium + its ffmpeg, `playcast`, `ffmpeg-static`.

```sh
DSH_HOME=/path/to/clean/home dsh e2e-ui2 --port 13087 --no-open
FFMPEG_DIR=/path/to/ffmpeg node record-collaboration.mjs "<token>" ./collaboration.gif
FFMPEG_DIR=/path/to/ffmpeg node record-plugin-console.mjs "<token>" ./plugin-console.gif
```

The scripts inject a red cursor overlay and a short CSS focus effect; interactions are normal Playwright clicks.
Demo data is synthetic and lives only in the isolated clean test home.
