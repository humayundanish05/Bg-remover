// script.js - cleaned & fixed version
import { ImageSegmenter, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0";

// ===== EDITOR STATE =====
// Transform state
let canvasScale = 1;
let canvasOffsetX = 0;
let canvasOffsetY = 0;
let rotation = 0; // degrees (0, 90, 180, 270)
let isFlipped = false;

// Background transform state
let bgScale = 1;
let bgOffsetX = 0;
let bgOffsetY = 0;

// Filter state
let adjBrightness = 0;
let adjContrast = 0;
let adjSaturation = 0;
let adjExposure = 0;
let adjShadows = 0;
let adjHighlights = 0;
let adjTemp = 0;
let adjTint = 0;
let adjVibrance = 0;
let adjClarity = 0;
let tintColor = null; // from presets

// Image state
let originalImg = null;      // ImageBitmap
let removedBG = null;        // Canvas containing foreground with alpha
let bgReplacement = null;    // ImageBitmap or color string
let showBackgroundLayer = true;

// Tool state
let activeTool = null; // 'crop'|'brush'|'pan'|null
let isPanning = false;
let panStart = { x: 0, y: 0 };
let isDrawing = false;
let brushSize = 30;
let brushMode = 'erase'; // 'erase' or 'restore'
let cropStart = null;
let cropRect = null;
let magicStrict = true; // true->0.6, false->0.35

// History
const history = [];
let historyIndex = -1;
const MAX_HISTORY = 30;

// ---------- DOM ----------
const fileInput = document.getElementById('fileInput');
const bgImageInput = document.getElementById('bgImageInput');
const colorPicker = document.getElementById('colorPicker');
const bgColorBtn = document.getElementById('bgColorBtn');
const bgImageBtn = document.getElementById('bgImageBtn');
const bgControls = document.getElementById('bg-controls');
const downloadBtn = document.getElementById('downloadBtn');
const clearBtn = document.getElementById('clearBtn');
const loading = document.getElementById('loading');

const canvas = document.getElementById('mainCanvas');
const ctx = canvas.getContext('2d');

const sliderFullscreen = document.getElementById('sliderFullscreen');
const sliderContainer = document.getElementById('sliderContainer');
const beforeImg = document.getElementById('beforeImg');
const afterImg = document.getElementById('afterImg');
const sliderHandle = document.getElementById('sliderHandle');

// New Category & Tool DOM
const toolsAdjust = document.getElementById('tools-adjust');
const toolsEdit = document.getElementById('tools-edit');
const toolsEnhance = document.getElementById('tools-enhance');
const toolsCreative = document.getElementById('tools-creative');
const navBtns = document.querySelectorAll('.nav-btn');

// Adjust Inputs
const inpBrightness = document.getElementById('adjBrightness');
const inpContrast = document.getElementById('adjContrast');
const inpSaturation = document.getElementById('adjSaturation');
const inpExposure = document.getElementById('adjExposure');
const inpShadows = document.getElementById('adjShadows');
const inpHighlights = document.getElementById('adjHighlights');
const inpTemp = document.getElementById('adjTemp');
const inpTint = document.getElementById('adjTint');
const inpVibrance = document.getElementById('adjVibrance');
const inpClarity = document.getElementById('adjClarity');

// Tools
const toolCrop = document.getElementById('toolCrop');
const toolRotate = document.getElementById('toolRotate');
const toolFlip = document.getElementById('toolFlip');
const toolMove = document.getElementById('toolMove'); // New
const toolBrush = document.getElementById('toolBrush');
const toolMagicEraser = document.getElementById('toolMagicEraser');
const toolUnblur = document.getElementById('toolUnblur'); // New
const btnRemoveBg = document.getElementById('btnRemoveBg'); // Manual

const zoomInBtn = document.getElementById('zoomIn');
const zoomOutBtn = document.getElementById('zoomOut');
const panTool = document.getElementById('panTool');

const undoBtn = document.getElementById('undoBtn');
const redoBtn = document.getElementById('redoBtn');

// bg adjust sliders
const bgZoom = document.getElementById('bgZoom');
const bgPosX = document.getElementById('bgPosX');
const bgPosY = document.getElementById('bgPosY');

// Presets
const presetMoody = document.getElementById('presetMoody');
const presetCinematic = document.getElementById('presetCinematic');
const presetVintage = document.getElementById('presetVintage');
const presetWarm = document.getElementById('presetWarm');
const presetCool = document.getElementById('presetCool');
const presetBW = document.getElementById('presetBW');

// ---------- Constants ----------
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';
const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm';

let segmenter = null;

// ---------- Helpers ----------
function pushHistory(label = '') {
  try {
    if (!canvas.width || !canvas.height) return;
    const data = canvas.toDataURL('image/png');
    // drop future redo states
    if (historyIndex < history.length - 1) {
      history.splice(historyIndex + 1);
    }
    history.push({ data, label });
    if (history.length > MAX_HISTORY) history.shift();
    historyIndex = history.length - 1;
    updateUndoRedoButtons();
  } catch (e) {
    console.warn('pushHistory error', e);
  }
}

function restoreHistory(index) {
  if (index < 0 || index >= history.length) return;
  const url = history[index].data;
  const img = new Image();
  img.onload = () => {
    canvas.width = img.width;
    canvas.height = img.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    // update removedBG best-effort so subsequent edits work on this state
    // Note: This flattens layers, so further bg manipulation might be limited after restore
    // Ideally we'd save full state, but for now this restores the visual state.
    const tmp = document.createElement('canvas');
    tmp.width = canvas.width; tmp.height = canvas.height;
    tmp.getContext('2d').drawImage(img, 0, 0);
    removedBG = tmp;

    historyIndex = index;
    updateUndoRedoButtons();
  };
  img.src = url;
}

function updateUndoRedoButtons() {
  if (undoBtn) undoBtn.disabled = historyIndex <= 0;
  if (redoBtn) redoBtn.disabled = historyIndex >= history.length - 1 || historyIndex === -1;
}

function getCanvasPointerPos(e) {
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (canvas.width / rect.width);
  const y = (e.clientY - rect.top) * (canvas.height / rect.height);
  return { x, y };
}

function makeFilterString() {
  // Combine all adjustments
  // CSS filter string approximations:
  // Brightness: brightness(1 + val) + Exposure (adds more)
  // Contrast: contrast(1 + val) + Clarity (adds more)
  // Saturation: saturate(1 + val) + Vibrance (adds more)
  // Temp: sepia + hue-rotate (warmth) or blue overlay (coolness)? 
  //   - Simple approach: use sepia for warmth, hue-rotate for shifting.

  // Normalized values (-1 to 1 range approx)
  const b = 1 + (adjBrightness / 100) + (adjExposure / 100);
  const c = 1 + (adjContrast / 100) + (adjClarity / 300); // Clarity affects contrast subtly
  const s = 1 + (adjSaturation / 100) + (adjVibrance / 200); // Vibrance is weaker saturation

  // Temp/Tint (Hue/Sepia)
  // Temp > 0 => Warm (Sepia), Temp < 0 => Cool (Blue tint? or just adjust hue?)
  // Hue rotate is tricky.
  // Let's stick to B/C/S/Sepia/Hue for standard CSS filters.

  // Shadows/Highlights/Tint/Temp often better done via Overlay colors (like presets) if CSS filter is limited.
  // But we have makeFilterString return a CSS string for `ctx.filter`.

  let filterStr = `brightness(${Math.max(0, b)}) contrast(${Math.max(0, c)}) saturate(${Math.max(0, s)})`;

  // Temp approximation via Sepia (Warmth)
  if (adjTemp > 0) {
    filterStr += ` sepia(${adjTemp / 200})`;
  } else if (adjTemp < 0) {
    // Coolness is hard with just CSS filters on Canvas without color-matrix.
    // We'll rely on our overlay "Tint" system for 'Temperature' manual override if we can,
    // OR we just accept Sepia only warms.
    // Actually, hue-rotate can shift slightly?
    filterStr += ` hue-rotate(${adjTemp / 5}deg)`;
  }

  // Tint (Green/Magenta shift) -> Hue Rotate
  if (adjTint !== 0) {
    filterStr += ` hue-rotate(${adjTint}deg)`;
  }

  return filterStr;
}

// ---------- Model init ----------
async function initModel() {
  if (segmenter) return;
  if (loading) loading.classList.remove('hidden');
  try {
    const vision = await FilesetResolver.forVisionTasks(WASM_PATH);
    segmenter = await ImageSegmenter.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL },
      outputConfidenceMasks: true
    });
    // warm cache
    fetch(MODEL_URL).catch(() => { });
    console.log('Model loaded');
  } catch (e) {
    console.error('Model init error', e);
    alert('Model failed to load (see console).');
  } finally {
    if (loading) loading.classList.add('hidden');
  }
}

// ---------- Background removal ----------
async function removeBackground(threshold = 0.6) {
  if (!originalImg) return;
  if (!segmenter) { await initModel(); if (!segmenter) return; }
  if (loading) loading.classList.remove('hidden');

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = originalImg.width;
  maskCanvas.height = originalImg.height;
  const maskCtx = maskCanvas.getContext('2d');
  maskCtx.drawImage(originalImg, 0, 0);

  try {
    const segmentation = await segmenter.segment(maskCanvas);
    const mask = segmentation.confidenceMasks[0].getAsFloat32Array();
    const imgData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    for (let i = 0; i < mask.length; i++) {
      // If confidence < threshold, make transparent
      if (mask[i] < threshold) imgData.data[i * 4 + 3] = 0;
    }
    maskCtx.putImageData(imgData, 0, 0);
    removedBG = maskCanvas;

    // reset transforms on new image load usually, but here we just need to ensure canvas matches
    if (canvas.width !== removedBG.width || canvas.height !== removedBG.height) {
      canvas.width = removedBG.width;
      canvas.height = removedBG.height;
    }

    renderFinal();
    pushHistory('bg-removed');
  } catch (err) {
    console.error('Segmentation error', err);
    alert('Background segmentation failed (see console).');
  } finally {
    if (loading) loading.classList.add('hidden');
  }
}

// ---------- Render ----------
function renderFinal() {
  if (!removedBG) return;

  // ensure canvas size = removedBG size could be done here, but usually we want to keep canvas size fixed during edits unless cropping

  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // apply global canvas transform: translate to center -> scale/rotate/flip -> translate back
  ctx.translate(canvas.width / 2 + canvasOffsetX, canvas.height / 2 + canvasOffsetY);
  ctx.scale(canvasScale * (isFlipped ? -1 : 1), canvasScale);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.translate(-canvas.width / 2, -canvas.height / 2);

  // background
  if (showBackgroundLayer) {
    if (bgReplacement instanceof ImageBitmap) {
      const w = bgReplacement.width * bgScale;
      const h = bgReplacement.height * bgScale;
      const x = bgOffsetX - (w - canvas.width) / 2;
      const y = bgOffsetY - (h - canvas.height) / 2;
      ctx.drawImage(bgReplacement, x, y, w, h);
    } else if (typeof bgReplacement === 'string') {
      ctx.fillStyle = bgReplacement;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  // filters
  ctx.filter = makeFilterString();

  // foreground
  ctx.drawImage(removedBG, 0, 0);

  // Apply Tint (if any) clipped to foreground
  if (tintColor) {
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = tintColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Reset composite operation
    ctx.globalCompositeOperation = 'source-over';
  }

  ctx.filter = 'none';
  ctx.restore();

  // if cropping overlay active, draw it (no transforms)
  if (cropRect) {
    ctx.save();
    ctx.strokeStyle = '#7c3aed';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
    ctx.setLineDash([]);
    ctx.restore();
  }
}

// ---------- Background controls ----------
bgColorBtn?.addEventListener('click', () => colorPicker?.click());
colorPicker?.addEventListener('input', (e) => {
  bgReplacement = e.target.value;
  renderFinal();
});
bgImageBtn?.addEventListener('click', () => bgImageInput?.click());
bgImageInput?.addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (!f) return;
  createImageBitmap(f).then(img => {
    bgReplacement = img;
    bgScale = 1; bgOffsetX = 0; bgOffsetY = 0;
    renderFinal();
    pushHistory('bg-change');
  });
});

bgZoom?.addEventListener('input', (e) => { bgScale = parseFloat(e.target.value); renderFinal(); });
bgPosX?.addEventListener('input', (e) => { bgOffsetX = parseFloat(e.target.value); renderFinal(); });
bgPosY?.addEventListener('input', (e) => { bgOffsetY = parseFloat(e.target.value); renderFinal(); });

// ---------- Upload flow ----------
fileInput?.addEventListener('change', async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  try {
    await initModel(); // ensure model ready
    originalImg = await createImageBitmap(file);
    // size canvas to original
    canvas.width = originalImg.width;
    canvas.height = originalImg.height;

    // reset state for new image
    canvasScale = 1; canvasOffsetX = 0; canvasOffsetY = 0; rotation = 0; isFlipped = false;
    bgReplacement = null; bgScale = 1; bgOffsetX = 0; bgOffsetY = 0;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(originalImg, 0, 0);

    // Auto BG removal REMOVED. Now manual.
    // Just display original.
    // Set removedBG to original initially so we can edit/crop even without removing BG
    removedBG = document.createElement('canvas');
    removedBG.width = canvas.width; removedBG.height = canvas.height;
    removedBG.getContext('2d').drawImage(originalImg, 0, 0);

    if (bgControls) bgControls.classList.remove('hidden');
    if (downloadBtn) downloadBtn.disabled = true;
    if (clearBtn) clearBtn.disabled = true;

    if (downloadBtn) downloadBtn.disabled = false;
    if (clearBtn) clearBtn.disabled = false;

    // Activate Adjust tab by default
    switchCategory('tools-adjust');
    if (clearBtn) clearBtn.disabled = false;

    history.length = 0; historyIndex = -1; // reset history for new file
    pushHistory('init');
  } catch (err) {
    console.error('Upload error', err);
    alert('Failed to load image (see console).');
  }
});

// ---------- Clear / Download / Save ----------
clearBtn?.addEventListener('click', () => {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  originalImg = null; removedBG = null; bgReplacement = null;
  bgScale = 1; bgOffsetX = 0; bgOffsetY = 0;
  if (bgControls) bgControls.classList.add('hidden');
  if (downloadBtn) downloadBtn.disabled = true;
  if (clearBtn) clearBtn.disabled = true;
  history.length = 0; historyIndex = -1;
  updateUndoRedoButtons();
});

downloadBtn?.addEventListener('click', () => {
  // Render final state to a clean canvas for download to ensure quality
  // Or just use current canvas if it's already rendered
  renderFinal();
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = `bg_removed_${Date.now()}.png`;
  a.click();
});
if (saveBtn) saveBtn.addEventListener('click', () => downloadBtn?.click());

// ---------- Fullscreen before/after slider ----------
let sliderDragging = false;
let sliderRectRaw = null;

if (canvas) {
  canvas.addEventListener('click', () => {
    // Only show if we have something to show
    if (!removedBG || !originalImg) return;
    if (sliderFullscreen) sliderFullscreen.classList.remove('hidden');

    // For before/after, we probably want to compare "Original" vs "Result"
    // Result = canvas content
    // Original = originalImg

    // before
    const beforeCanvas = document.createElement('canvas');
    beforeCanvas.width = canvas.width; beforeCanvas.height = canvas.height;
    beforeCanvas.getContext('2d').drawImage(originalImg, 0, 0, canvas.width, canvas.height);
    if (beforeImg) beforeImg.src = beforeCanvas.toDataURL();

    // after (current state)
    if (afterImg) afterImg.src = canvas.toDataURL();

    if (sliderContainer) {
      sliderRectRaw = sliderContainer.getBoundingClientRect();
      const startX = sliderRectRaw.width / 2;
      if (sliderHandle) sliderHandle.style.left = startX + 'px';
      if (afterImg) {
        afterImg.style.clipPath = `inset(0 0 0 ${startX}px)`;
        afterImg.style.position = 'absolute';
        afterImg.style.top = '0';
        afterImg.style.left = '0';
        afterImg.style.width = '100%';
        afterImg.style.height = '100%';
      }
    }
  });
}

if (sliderFullscreen) {
  sliderFullscreen.addEventListener('click', (e) => {
    if (e.target === sliderFullscreen) sliderFullscreen.classList.add('hidden');
  });
}
if (sliderHandle) {
  sliderHandle.addEventListener('pointerdown', () => {
    sliderDragging = true;
    if (sliderContainer) sliderRectRaw = sliderContainer.getBoundingClientRect();
  });
}
window.addEventListener('pointerup', () => { sliderDragging = false; });
window.addEventListener('pointermove', (e) => {
  if (!sliderDragging || !sliderContainer) return;
  let x = e.clientX - sliderRectRaw.left;
  x = Math.max(0, Math.min(x, sliderRectRaw.width));
  if (sliderHandle) sliderHandle.style.left = x + 'px';
  if (afterImg) afterImg.style.clipPath = `inset(0 0 0 ${x}px)`;
});


// =======================================
// TOOLBAR ACTIONS
// =======================================

// -------- Tool Utility --------
function setActiveTool(name) {
  activeTool = name;

  // reset cursor
  canvas.style.cursor = 'default';

  switch (name) {
    case 'crop':
      canvas.style.cursor = 'crosshair';
      break;
    case 'brush':
      canvas.style.cursor = 'crosshair';
      break;
    case 'pan':
      canvas.style.cursor = 'grab';
      break;
    case 'move':
      canvas.style.cursor = 'move';
      break;
  }

  // Update UI active state
  document.querySelectorAll('.active-tool').forEach(b => b.classList.remove('active-tool'));
  // Find button with id 'tool'+CapitalizedName
  if (name) {
    const btn = document.getElementById('tool' + name.charAt(0).toUpperCase() + name.slice(1));
    if (btn) btn.classList.add('active-tool');
  }
}

// -------- Category Switch Logic --------
function switchCategory(targetId) {
  // Hide all
  const toolbars = document.querySelectorAll('.active-toolbar');
  toolbars.forEach(tb => tb.classList.add('hidden'));

  // Show target
  const target = document.getElementById(targetId);
  if (target) target.classList.remove('hidden');

  // Update Nav Active State
  navBtns.forEach(btn => {
    btn.classList.remove('active-cat');
    if (btn.dataset.target === targetId) btn.classList.add('active-cat');
  });
}

// Nav Click Events
navBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    switchCategory(btn.dataset.target);
  });
});

// -------- Manual BG Removal --------
btnRemoveBg?.addEventListener('click', async () => {
  if (!originalImg) return;
  btnRemoveBg.innerHTML = '<span class="material-symbols-outlined">hourglass_top</span><br>...';
  await removeBackground(0.6);
  btnRemoveBg.innerHTML = '<span class="material-symbols-outlined">auto_fix_high</span><br>BG Remover';
});

// -------- Unblur Tool (Simulated) --------
toolUnblur?.addEventListener('click', () => {
  if (!originalImg) return;
  // Simulate unblur by boosting sharpness/contrast slightly
  adjContrast += 10;
  adjClarity += 20;
  if (inpContrast) inpContrast.value = adjContrast;
  if (inpClarity) inpClarity.value = adjClarity;
  renderFinal();
  alert('Enhancement applied!');
});

// -------- Magic Eraser (Brush Erase) --------
toolMagicEraser?.addEventListener('click', () => {
  // Switch to brush mode, erase
  brushMode = 'erase';
  setActiveTool('brush'); // Share brush cursor logic
  // Visually activate magic eraser button instead of brush button
  document.querySelectorAll('.active-tool').forEach(b => b.classList.remove('active-tool'));
  toolMagicEraser.classList.add('active-tool');
});

// -------- Brush Tool (Paint) --------
toolBrush?.addEventListener('click', () => {
  brushMode = 'restore'; // Paint? or White?
  // User asked for "Brush / Paint - allows drawing/painting".
  // For now let's make it simple black/white or just 'restore' doesn't make sense if we don't have alpha mask to restore.
  // Let's make it a simple white brush for now or a color brush.
  // Given "Creative", a color brush is best.
  // Standard ctx.strokeStyle... but handleBrushStroke uses fill.
  brushMode = 'paint';
  setActiveTool('brush');
});

// -------- Move Tool --------
toolMove?.addEventListener('click', () => setActiveTool(activeTool === 'move' ? null : 'move'));

// -------- Crop Tool --------
toolCrop?.addEventListener('click', () => {
  setActiveTool(activeTool === 'crop' ? null : 'crop');
});

// -------- Rotate --------
toolRotate?.addEventListener('click', () => {
  rotation = (rotation + 90) % 360;
  renderFinal();
  pushHistory('rotate');
});

// -------- Flip Horizontal --------
toolFlip?.addEventListener('click', () => {
  isFlipped = !isFlipped;
  renderFinal();
  pushHistory('flip');
});

// -------- Brush Tool --------
toolBrush?.addEventListener('click', () => {
  brushMode = 'erase';
  setActiveTool(activeTool === 'brush' ? null : 'brush');
});

// -------- Magic Eraser (AI re-mask) --------
toolMagicEraser?.addEventListener('click', async () => {
  magicStrict = !magicStrict;
  await removeBackground(magicStrict ? 0.6 : 0.35);
  pushHistory('magic-eraser');
});

// -------- Zoom --------
zoomInBtn?.addEventListener('click', () => {
  canvasScale = Math.min(4, canvasScale + 0.1);
  renderFinal();
});

zoomOutBtn?.addEventListener('click', () => {
  canvasScale = Math.max(0.2, canvasScale - 0.1);
  renderFinal();
});

// -------- Pan Tool --------
panTool?.addEventListener('click', () => {
  setActiveTool(activeTool === 'pan' ? null : 'pan');
});

// -------- Adjustments --------
function bindSlider(elem, varName) {
  if (!elem) return;
  elem.addEventListener('input', () => {
    // Update global var dynamically
    // eval(`${varName} = +elem.value`); // Avoid eval.
    // Use switch or object map.
    const val = +elem.value;
    switch (varName) {
      case 'adjBrightness': adjBrightness = val; break;
      case 'adjContrast': adjContrast = val; break;
      case 'adjSaturation': adjSaturation = val; break;
      case 'adjExposure': adjExposure = val; break;
      case 'adjShadows': adjShadows = val; break;
      case 'adjHighlights': adjHighlights = val; break;
      case 'adjTemp': adjTemp = val; break;
      case 'adjTint': adjTint = val; break;
      case 'adjVibrance': adjVibrance = val; break;
      case 'adjClarity': adjClarity = val; break;
    }
    renderFinal();
  });
}

bindSlider(inpBrightness, 'adjBrightness');
bindSlider(inpContrast, 'adjContrast');
bindSlider(inpSaturation, 'adjSaturation');
bindSlider(inpExposure, 'adjExposure');
bindSlider(inpShadows, 'adjShadows');
bindSlider(inpHighlights, 'adjHighlights');
bindSlider(inpTemp, 'adjTemp');
bindSlider(inpTint, 'adjTint');
bindSlider(inpVibrance, 'adjVibrance');
bindSlider(inpClarity, 'adjClarity');

// -------- Undo / Redo --------
undoBtn?.addEventListener('click', () => {
  if (historyIndex > 0) {
    historyIndex--;
    restoreHistory(historyIndex);
  }
});

redoBtn?.addEventListener('click', () => {
  if (historyIndex < history.length - 1) {
    historyIndex++;
    restoreHistory(historyIndex);
  }
});

// -------- Layers Toggle --------
if (layersToggle) {
  layersToggle.addEventListener('click', () => {
    showBackgroundLayer = !showBackgroundLayer;
    renderFinal();
  });
}

// -------- Reset Editor --------
if (resetBtn) {
  resetBtn.addEventListener('click', async () => {
    if (!originalImg) return;

    canvasScale = 1;
    canvasOffsetX = 0;
    canvasOffsetY = 0;
    rotation = 0;
    isFlipped = false;

    bgReplacement = null;
    bgScale = 1;
    bgOffsetX = 0;
    bgOffsetY = 0;

    adjBrightness = 0; adjContrast = 0; adjSaturation = 0;
    adjExposure = 0; adjShadows = 0; adjHighlights = 0;
    adjTemp = 0; adjTint = 0; adjVibrance = 0; adjClarity = 0;

    // Reset inputs
    document.querySelectorAll('.active-toolbar input[type="range"]').forEach(i => i.value = 0);

    tintColor = null;

    // Reset removedBG to original (undo BG removal)
    removedBG = document.createElement('canvas');
    removedBG.width = canvas.width; removedBG.height = canvas.height;
    removedBG.getContext('2d').drawImage(originalImg, 0, 0);

    renderFinal();
    pushHistory('reset');
  });
}

// =======================================
// POINTER HANDLING (Crop / Brush / Pan)
// =======================================

canvas?.addEventListener('pointerdown', e => {
  const p = getCanvasPointerPos(e);

  if (activeTool === 'crop') {
    cropStart = p;
    cropRect = null;
    isDrawing = true;
  }

  if (activeTool === 'brush') {
    isDrawing = true;
    handleBrushStroke(p.x, p.y);
  }

  if (activeTool === 'pan') {
    isDrawing = true;
    panStart = { x: e.clientX, y: e.clientY };
    canvas.style.cursor = 'grabbing';
  }
});

canvas?.addEventListener('pointermove', e => {
  const p = getCanvasPointerPos(e);

  // Crop Preview
  if (activeTool === 'crop' && isDrawing && cropStart) {
    cropRect = {
      x: Math.min(cropStart.x, p.x),
      y: Math.min(cropStart.y, p.y),
      w: Math.abs(p.x - cropStart.x),
      h: Math.abs(p.y - cropStart.y)
    };
    renderFinal();
  }

  // Brush
  if (activeTool === 'brush' && isDrawing) {
    // Need to transform pointer coords back to image coords if we are drawing on the image itself
    // This is tricky if transforms are applied...
    // For now, brush is simple and might assume 1:1 if we don't inverse transform.
    // But we have transforms. So we likely need to inverse transform p.x/p.y to get "image coordinates"
    // or simplisticly, we just draw on specific coordinates if we assume brush is "on top".
    // Actually, brush modifies 'removedBG' which is the source image. 
    // So we MUST map the pointer coordinate back to the 'removedBG' coordinate space.

    // Inverse Transform logic:
    // visualX = (imgX - center + offset) * scale * flip + center
    // => imgX = ((visualX - center) / (scale * flip)) - offset + center

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;

    const dx = p.x - cx;
    const dy = p.y - cy;

    // Inverse rotate
    const angle = -rotation * Math.PI / 180;
    const rx = dx * Math.cos(angle) - dy * Math.sin(angle);
    const ry = dx * Math.sin(angle) + dy * Math.cos(angle);

    // Inverse scale/flip
    const sx = rx / (canvasScale * (isFlipped ? -1 : 1));
    const sy = ry / canvasScale;

    // Inverse translate
    const finalX = sx - canvasOffsetX + cx;
    const finalY = sy - canvasOffsetY + cy;

    handleBrushStroke(finalX, finalY);
  }

  // Pan or Move
  if ((activeTool === 'pan' || activeTool === 'move') && isDrawing) {
    const dx = e.clientX - panStart.x;
    const dy = e.clientY - panStart.y;
    panStart = { x: e.clientX, y: e.clientY };
    canvasOffsetX += dx;
    canvasOffsetY += dy;
    renderFinal();
  }
});

canvas?.addEventListener('pointerup', () => {
  if (activeTool === 'crop' && cropRect?.w > 5 && cropRect?.h > 5) {
    performCrop(
      Math.round(cropRect.x),
      Math.round(cropRect.y),
      Math.round(cropRect.w),
      Math.round(cropRect.h)
    );
    pushHistory('crop');
  }

  if (activeTool === 'brush' && isDrawing) {
    pushHistory('brush');
  }

  // Move/Pan end
  if ((activeTool === 'pan' || activeTool === 'move') && isDrawing) {
    if (activeTool === 'pan') canvas.style.cursor = 'grab';
    if (activeTool === 'move') canvas.style.cursor = 'move';
  }

  isDrawing = false;
  cropStart = null;
  cropRect = null;
  if (activeTool === 'pan') canvas.style.cursor = 'grab';
});

// Cancel safety
canvas?.addEventListener('pointercancel', () => {
  isDrawing = false;
  cropStart = null;
  cropRect = null;
});

// -------- Brush Size via Wheel --------
canvas?.addEventListener('wheel', e => {
  if (activeTool === 'brush') {
    e.preventDefault();
    brushSize = Math.max(4, brushSize + (e.deltaY > 0 ? -4 : 4));
  }
});

// ---------- Presets Logic ----------
function applyPreset(name) {
  // Reset basics first (optional, but presets usually override current state)
  // Or should they be additive? Usually presets set a baseline.

  switch (name) {
    case 'moody': // Low brightness, high contrast, low sat, teal tint
      adjBrightness = -10;
      adjContrast = 20;
      adjSaturation = -20;
      tintColor = 'rgba(0, 40, 60, 0.4)';
      break;
    case 'cinematic': // High contrast, low sat, teal/blue tint
      adjBrightness = 0;
      adjContrast = 15;
      adjSaturation = -10;
      tintColor = 'rgba(0, 100, 150, 0.25)';
      break;
    case 'vintage': // Low contrast, warm yellow tint
      adjBrightness = 5;
      adjContrast = -10;
      adjSaturation = -20;
      tintColor = 'rgba(220, 180, 50, 0.3)';
      break;
    case 'warm': // Bright, contrast, warm orange tint
      adjBrightness = 5;
      adjContrast = 5;
      adjSaturation = 10;
      tintColor = 'rgba(255, 140, 0, 0.2)';
      break;
    case 'cool': // Contrast, low sat, blue tint
      adjBrightness = 0;
      adjContrast = 10;
      adjSaturation = -10;
      tintColor = 'rgba(0, 180, 255, 0.2)';
      break;
    case 'bw': // B&W, high contrast
      adjBrightness = 0;
      adjContrast = 20;
      adjSaturation = -100;
      tintColor = null;
      break;
  }

  // Update UI sliders
  if (inpBrightness) inpBrightness.value = adjBrightness;
  if (inpContrast) inpContrast.value = adjContrast;
  if (inpSaturation) inpSaturation.value = adjSaturation;

  renderFinal();
  pushHistory('preset-' + name);
}

presetMoody?.addEventListener('click', () => applyPreset('moody'));
presetCinematic?.addEventListener('click', () => applyPreset('cinematic'));
presetVintage?.addEventListener('click', () => applyPreset('vintage'));
presetWarm?.addEventListener('click', () => applyPreset('warm'));
presetCool?.addEventListener('click', () => applyPreset('cool'));
presetBW?.addEventListener('click', () => applyPreset('bw'));


// ---------- performCrop ----------
function performCrop(x, y, w, h) {
  // produce a temp canvas of the current rendered pixels (with transforms applied)
  // easiest approach: renderFinal to a snapshot canvas and extract region
  const snapshot = document.createElement('canvas');
  snapshot.width = canvas.width; snapshot.height = canvas.height;
  const sctx = snapshot.getContext('2d');

  // RENDER INTO SNAPSHOT (Duplicate logic of renderFinal but into sctx)
  sctx.save();
  // We want to capture exactly what is visible, so we replicate the transforms:
  sctx.translate(canvas.width / 2 + canvasOffsetX, canvas.height / 2 + canvasOffsetY);
  sctx.scale(canvasScale * (isFlipped ? -1 : 1), canvasScale);
  sctx.rotate((rotation * Math.PI) / 180);
  sctx.translate(-canvas.width / 2, -canvas.height / 2);

  // Background
  if (showBackgroundLayer) {
    if (bgReplacement instanceof ImageBitmap) {
      const W = bgReplacement.width * bgScale;
      const H = bgReplacement.height * bgScale;
      const X = bgOffsetX - (W - canvas.width) / 2;
      const Y = bgOffsetY - (H - canvas.height) / 2;
      sctx.drawImage(bgReplacement, X, Y, W, H);
    } else if (typeof bgReplacement === 'string') {
      sctx.fillStyle = bgReplacement;
      sctx.fillRect(0, 0, snapshot.width, snapshot.height);
    }
  }

  sctx.filter = makeFilterString();
  sctx.drawImage(removedBG, 0, 0);
  sctx.filter = 'none';
  sctx.restore();

  // extract selected region
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  tmp.getContext('2d').drawImage(snapshot, x, y, w, h, 0, 0, w, h);

  // update removedBG & originalImg & canvas
  // We need to set removedBG to this new cropped view
  // And we should probably reset transforms because we are defining a new "base" image
  removedBG = document.createElement('canvas');
  removedBG.width = w; removedBG.height = h;
  removedBG.getContext('2d').drawImage(tmp, 0, 0);

  createImageBitmap(tmp).then(bm => {
    originalImg = bm;
    canvas.width = w;
    canvas.height = h;

    // Reset transforms since we've now baked the previous transforms into the new image
    canvasScale = 1; canvasOffsetX = 0; canvasOffsetY = 0;
    rotation = 0; isFlipped = false;

    renderFinal();
  });
}

// ---------- Brush stroke ----------
function handleBrushStroke(x, y) {
  if (!removedBG) return;
  const bctx = removedBG.getContext('2d');
  bctx.save();

  if (brushMode === 'erase') {
    bctx.globalCompositeOperation = 'destination-out';
    bctx.beginPath();
    bctx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
    bctx.fill();
  } else if (brushMode === 'paint') {
    bctx.globalCompositeOperation = 'source-over';
    bctx.fillStyle = '#ff0000'; // Default red paint for 'Creative' brush
    bctx.beginPath();
    bctx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
    bctx.fill();
  }

  bctx.restore();
  renderFinal();
}

// ---------- init & UX ----------
updateUndoRedoButtons();
console.log('script.js loaded and ready');
