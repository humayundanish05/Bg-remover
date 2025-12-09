# Upgrade notes

Files included in this package:
- index.html — improved accessibility, drag & drop, semantic layout
- style.css — responsive, modern UI, better spacing and animations
- script.js — lazy model init, chunked mask processing (non-blocking), createImageBitmap, memory cleanup, better UX
- service-worker.js — caches app shell and runtime caches for model files
- manifest.json — PWA metadata

Quick test (local):
1. Serve with a static server (recommended): `npx http-server -c-1` or `python -m http.server 8000`
2. Open the site and try uploading an image. Open DevTools -> Application -> Service Workers to see SW registration.

Deployment tips:
- Deploy to GitHub Pages or Netlify — both provide HTTPS which is required for PWA + model fetches.
- Consider hosting the model with the app if you want complete offline usage (model is ~a few MBs — check size).

Further improvements you can ask me to add (I can implement):
- Optional image editing brush to refine mask.
- Background replace (solid color / image) instead of transparent.
- WebWorker-based segmentation for extra responsiveness.
- Auto-generated demo GIF for README.

