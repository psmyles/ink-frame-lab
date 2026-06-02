# Ink Frame Lab

A browser-based tool for preparing images for e-ink picture frames. Start by importing images, and cropping them to the aspect ratio and resolution of your e-ink panel. Then preview the results in a 3D view in different lighting conditions at different angles. It dithers photos down to the limited colour palettes used by e-paper displays and exports ready-to-use PNG files for uploading.

I've written a [blog post](https://psmyles.com/blog/standalone-e-ink-picture-frame) detailing the need for this tool and a related standalone firmware for displaying images on an i-ink panel.A web version can be accessed [here](https://psmyles.github.io/ink-frame-lab/).

## Workflow

* Import one or more images via drag-and-drop or file picker
* Crop and fit each image to the target display resolution
* Dither using error diffusion (Floyd-Steinberg, Atkinson, Jarvis, and more), ordered (Bayer), random noise, or plain quantization
* Choose from built-in palettes (Default B\&W, Waveshare Spectra 6, Gallery AcEP 7c) or enter custom hex colours
* Preview the result in a 3D frame mockup with configurable image based lighting presets
* Export as individual PNG files or a ZIP archive, numbered for direct firmware upload

## Supported displays

Resolution presets are included for common e-ink displays. Any custom resolution and related color palette values can be entered manually.

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
presets.json      device presets and calibrated colour palettes
IBL/              environment maps for the 3D viewer
```

## Credits

* [**Three.js**](https://threejs.org/) - 3D rendering, used for the frame viewer, IBL lighting, and post-processing pipeline (OrbitControls, RoomEnvironment, RGBELoader, EffectComposer, GTAOPass, OutputPass). MIT License.
* [**JSZip**](https://stuk.github.io/jszip/) - client-side ZIP archive creation for the Export ZIP feature. MIT License.
* [**Inter**](https://rsms.me/inter/) - UI typeface by Rasmus Andersson, served via Google Fonts. SIL Open Font License.
* **Dithering algorithms** - error diffusion kernels (Floyd-Steinberg, Atkinson, False Floyd-Steinberg, Jarvis-Judice-Ninke, Stucki, Burkes, Sierra-3, Sierra-2, Sierra-2-4A), ordered Bayer matrix, and random noise dithering are original implementations of published public-domain techniques.
* [**polyhaven.com**](https://polyhaven.com/hdris) - images used for image based lighting in the 3D view.
