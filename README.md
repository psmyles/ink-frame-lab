# Ink Frame Lab

A browser-based tool for preparing images for e-ink picture frames. It dithers photos down to the limited colour palettes used by e-paper displays and exports ready-to-use PNG files for uploading. A 3D viewer is included to visualize the result in different lighting conditions at different angles.

## Features

- Import one or more images via drag-and-drop or file picker
- Crop and fit each image to the target display resolution
- Dither using error diffusion (Floyd-Steinberg, Atkinson, Jarvis, and more), ordered (Bayer), random noise, or plain quantization
- Choose from built-in palettes (Default B&W, Waveshare Spectra 6, Gallery AcEP 7c) or enter custom hex colours
- Preview the result in a 3D frame mockup with configurable image based lighting presets
- Export as individual PNG files or a ZIP archive, numbered for direct firmware upload

## Supported displays

Resolution presets are included for common Waveshare and Pimoroni Inky displays. Any custom resolution can be entered manually.

## Running

This is a static web app with no build step. Because it uses ES modules it must be served over HTTP, not opened directly as a file.

```
npx serve .
```

Then open the URL shown in the terminal (typically `http://localhost:3000`).

## Project layout

```
index.html        entry point
css/styles.css    all styles
js/
  main.js         app init and event wiring
  state.js        shared mutable state
  sidebar.js      resolution, palette, and dithering controls
  ui.js           filmstrip, crop tool, canvas preview
  export.js       image processing and file download
  dithering.js    palette data loading and dithering algorithms
  viewer3d.js     Three.js 3D frame viewer
palettes.json     calibrated colour palettes
IBL/              environment maps for the 3D viewer
```
