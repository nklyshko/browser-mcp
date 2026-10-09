# Desktop assets

All desktop client images and icons belong under this directory so Vite and Tauri package them together.

- `icons/`: cropped transparent PNG icons used by `src/components/AssetIcon.vue`.
- `icons/source/`: original generated icon sheets retained as editable source.
- `illustrations/`: banners, empty-state art, and other illustrations.

Add raster icons to `icons/` and register their names in `AssetIcon.vue`. Keep icons and illustrations out of source-code drawings and inline SVG.

The overview uses `illustrations/bridge-hero.png` as its banner background, and the cropped files in `illustrations/dashboard-motifs/` for card and empty-state decoration.
