# 小程序图标

- `lucide/`：图标源文件，来自 [Lucide](https://lucide.dev)（lucide-static 1.80.0，**ISC 许可**，见 `lucide/LICENSE`）。这个目录不在 `src/` 里，不会打进小程序包。
- `npm run icons`：扫描 `src/` 里用到的 `/assets/icons/<名称>-<颜色>.svg`，按颜色生成到 `src/assets/icons/`（只生成用到的，包体最小）。颜色代号见 `scripts/build-icons.mjs`。
- 底部标签栏图标必须是 PNG（81×81、小于 40KB）：`python3 scripts/build-tabbar.py`（需要 `cairosvg`）生成到 `src/assets/tabbar/`，生成结果已提交，平时不用重跑。
