// ─────────────────────────────────────────────────────────────────────────────
// Constants & tunable defaults
// ─────────────────────────────────────────────────────────────────────────────
const APP_VERSION = 'v1.8';
const FRAME_INTERVAL_MS = 100;     // how often to process a frame
// A region's average brightness (max of R,G,B averaged across pixels) must
// exceed this fraction of the pixel-entry threshold to be considered "on".
// This rejects dim gray LED strips that are physically off.
const REGION_AVG_BRIGHTNESS_RATIO = 0.90;

// ─────────────────────────────────────────────────────────────────────────────
// DOM refs
// ─────────────────────────────────────────────────────────────────────────────
const video        = document.getElementById('video');
const canvas       = document.getElementById('canvas');
const ctx          = canvas.getContext('2d', { willReadFrequently: true });
const resultPanel  = document.getElementById('result');
const swatchEl     = document.getElementById('swatch');
const colorNameEl  = document.getElementById('colorName');
const threshSlider = document.getElementById('threshSlider');
const threshVal    = document.getElementById('threshVal');
const areaSlider   = document.getElementById('areaSlider');
const areaVal      = document.getElementById('areaVal');
const expSlider    = document.getElementById('expSlider');
const expVal       = document.getElementById('expVal');
const whiteChk     = document.getElementById('whiteChk');
const toggleBtn    = document.getElementById('toggleSettings');
const showBtn      = document.getElementById('showSettings');
const settingsPanel = document.getElementById('settings');
const zoomBadge    = document.getElementById('zoomBadge');

// ─────────────────────────────────────────────────────────────────────────────
// Settings state
// ─────────────────────────────────────────────────────────────────────────────
let brightnessThreshold = parseInt(threshSlider.value, 10);
let minAreaPx           = parseInt(areaSlider.value, 10);
// exposureCompensation: 0 = no change, negative = darker
// Stored as integer steps; actual EV range is queried from the camera track.
let exposureSteps           = parseInt(expSlider.value, 10);
let nativeExpMin            = null;
let nativeExpMax            = null;
let detectWhite             = whiteChk.checked; // false by default

whiteChk.addEventListener('change', () => { detectWhite = whiteChk.checked; });

// How long (ms) the result panel stays visible after the LED is no longer detected
const RESULT_LINGER_MS = 1000;
let hideResultTimer    = null;

function scheduleHideResult() {
  if (hideResultTimer !== null) return; // already scheduled
  hideResultTimer = setTimeout(() => {
    resultPanel.classList.add('hidden');
    hideResultTimer = null;
  }, RESULT_LINGER_MS);
}

function cancelHideResult() {
  if (hideResultTimer !== null) {
    clearTimeout(hideResultTimer);
    hideResultTimer = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Zoom state
// ─────────────────────────────────────────────────────────────────────────────
let zoomLevel        = 1.0;
const ZOOM_MIN       = 1.0;
const ZOOM_MAX       = 8.0;
let nativeZoomMin    = 1.0;
let nativeZoomMax    = 1.0;   // stays 1.0 if not supported
let videoTrack       = null;  // set after camera starts

function applyZoom(newZoom) {
  zoomLevel = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom));

  // Try native zoom first (better quality on supported devices)
  if (videoTrack && nativeZoomMax > 1.0) {
    const clampedNative = Math.max(nativeZoomMin, Math.min(nativeZoomMax, zoomLevel));
    videoTrack.applyConstraints({ advanced: [{ zoom: clampedNative }] }).catch(() => {});
  }

  // Update badge
  if (zoomLevel > 1.05) {
    zoomBadge.textContent = zoomLevel.toFixed(1) + '\u00d7';
    zoomBadge.classList.remove('hidden');
  } else {
    zoomBadge.classList.add('hidden');
  }
}

function applyExposure(steps) {
  exposureSteps = steps;
  expVal.textContent = steps === 0 ? '0' : (steps > 0 ? '+' + steps : String(steps));

  if (!videoTrack) return;
  const caps = videoTrack.getCapabilities ? videoTrack.getCapabilities() : {};
  if (!caps.exposureMode || !caps.exposureCompensation) return;

  // Map slider steps (-5..0) linearly onto the camera's native EV range
  if (nativeExpMin === null) {
    nativeExpMin = caps.exposureCompensation.min;
    nativeExpMax = caps.exposureCompensation.max;
  }
  const evRange = nativeExpMax - nativeExpMin;
  const sliderRange = 10; // total slider span (-5 to +5)
  const evValue = nativeExpMin + ((steps + 5) / sliderRange) * evRange;
  videoTrack.applyConstraints({
    advanced: [{ exposureMode: 'manual', exposureCompensation: evValue }]
  }).catch(() => {});
}

threshSlider.addEventListener('input', () => {
  brightnessThreshold = parseInt(threshSlider.value, 10);
  threshVal.textContent = brightnessThreshold;
});

areaSlider.addEventListener('input', () => {
  minAreaPx = parseInt(areaSlider.value, 10);
  areaVal.textContent = minAreaPx;
});

expSlider.addEventListener('input', () => {
  applyExposure(parseInt(expSlider.value, 10));
});

toggleBtn.addEventListener('click', () => {
  settingsPanel.classList.add('hidden');
  showBtn.classList.remove('hidden');
});

showBtn.addEventListener('click', () => {
  settingsPanel.classList.remove('hidden');
  showBtn.classList.add('hidden');
});

// ─────────────────────────────────────────────────────────────────────────────
// Pinch-to-zoom and double-tap-to-reset gesture handling
// ─────────────────────────────────────────────────────────────────────────────
let pinchStartDist  = null;
let pinchStartZoom  = 1.0;
let lastTapTime     = 0;

function getTouchDist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

canvas.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    e.preventDefault();
    pinchStartDist = getTouchDist(e.touches);
    pinchStartZoom = zoomLevel;
  } else if (e.touches.length === 1) {
    // Double-tap detection
    const now = Date.now();
    if (now - lastTapTime < 300) {
      applyZoom(1.0);
    }
    lastTapTime = now;
  }
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  if (e.touches.length === 2 && pinchStartDist !== null) {
    e.preventDefault();
    const dist  = getTouchDist(e.touches);
    const ratio = dist / pinchStartDist;
    applyZoom(pinchStartZoom * ratio);
  }
}, { passive: false });

canvas.addEventListener('touchend', () => {
  if (pinchStartDist !== null) pinchStartDist = null;
});

// ─────────────────────────────────────────────────────────────────────────────
// Camera initialisation
// ─────────────────────────────────────────────────────────────────────────────
async function startCamera() {
  const constraints = [
    { video: { facingMode: { exact: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } },
    { video: { facingMode: 'environment' } },
    { video: true },
  ];

  for (const constraint of constraints) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraint);
      video.srcObject = stream;
      await video.play();

      // Check for native zoom support
      videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        const caps = videoTrack.getCapabilities ? videoTrack.getCapabilities() : {};
        if (caps.zoom) {
          nativeZoomMin = caps.zoom.min ?? 1.0;
          nativeZoomMax = caps.zoom.max ?? 1.0;
        }
      }
      return;
    } catch (_) {
      // try next constraint
    }
  }
  console.error('Could not access any camera.');
}

// ─────────────────────────────────────────────────────────────────────────────
// RGB → HSV  (all values 0–1)
// ─────────────────────────────────────────────────────────────────────────────
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d   = max - min;
  let h = 0;
  const s = max === 0 ? 0 : d / max;
  const v = max;

  if (d !== 0) {
    if      (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else                h = ((r - g) / d + 4) / 6;
  }
  return { h: h * 360, s, v };
}

// ─────────────────────────────────────────────────────────────────────────────
// Color classification
// ─────────────────────────────────────────────────────────────────────────────
const COLOR_DEFS = [
  { name: 'White',   css: '#ffffff', textColor: '#000' },
  { name: 'Red',     css: '#ff2020', textColor: '#fff' },
  { name: 'Yellow',  css: '#ffee00', textColor: '#000' },
  { name: 'Green',   css: '#00dd44', textColor: '#fff' },
  { name: 'Cyan',    css: '#00eeff', textColor: '#000' },
  { name: 'Blue',    css: '#2255ff', textColor: '#fff' },
  { name: 'Magenta', css: '#ee00cc', textColor: '#fff' },
];

/**
 * Classify an average {r,g,b} into one of the named colors.
 * @param {number} r 0-255
 * @param {number} g 0-255
 * @param {number} b 0-255
 * @returns {object} one of COLOR_DEFS entries
 */
function classifyColor(r, g, b) {
  const { h, s, v } = rgbToHsv(r, g, b);

  // Low saturation → white. Return null if white detection is disabled
  // so the caller can treat this as "no color found".
  if (s < 0.12 || (v > 0.95 && s < 0.18)) {
    return detectWhite ? COLOR_DEFS[0] : null;
  }

  // Hue-based classification
  if (h < 30 || h >= 330)  return COLOR_DEFS[1]; // Red
  if (h < 90)              return COLOR_DEFS[2]; // Yellow
  if (h < 150)             return COLOR_DEFS[3]; // Green
  if (h < 210)             return COLOR_DEFS[4]; // Cyan
  if (h < 270)             return COLOR_DEFS[5]; // Blue
  return                          COLOR_DEFS[6]; // Magenta
}

// ─────────────────────────────────────────────────────────────────────────────
// Connected-components (union-find on a 1-D bright-pixel mask)
// Returns array of:
//   { minX, maxX, minY, maxY, pixels, sumR, sumG, sumB,
//     rimPixels, rimSumR, rimSumG, rimSumB }
// "rim" pixels are those whose own per-pixel HSV saturation >= RIM_SAT_MIN.
// These are the colorful edges of the light; the blown-out centre pixels
// (near-white, low saturation) are excluded from the rim sums.
const RIM_SAT_MIN = 0.20; // pixels below this saturation are considered blown-out
// ─────────────────────────────────────────────────────────────────────────────
function findBrightRegions(imageData, width, height, threshold) {
  const data   = imageData.data;
  const labels = new Int32Array(width * height).fill(-1);
  const parent = [];

  // Union-Find helpers
  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a, b) {
    a = find(a); b = find(b);
    if (a !== b) parent[b] = a;
  }

  let nextLabel = 0;

  // First pass — row-by-row labelling
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];
      const brightness = Math.max(r, g, b);
      if (brightness < threshold) continue;

      const pixIdx = y * width + x;
      const leftIdx  = x > 0          ? pixIdx - 1     : -1;
      const aboveIdx = y > 0          ? pixIdx - width  : -1;

      const leftLabel  = leftIdx  >= 0 && labels[leftIdx]  >= 0 ? labels[leftIdx]  : -1;
      const aboveLabel = aboveIdx >= 0 && labels[aboveIdx] >= 0 ? labels[aboveIdx] : -1;

      if (leftLabel === -1 && aboveLabel === -1) {
        // New label
        labels[pixIdx] = nextLabel;
        parent.push(nextLabel);
        nextLabel++;
      } else if (leftLabel !== -1 && aboveLabel === -1) {
        labels[pixIdx] = leftLabel;
      } else if (leftLabel === -1 && aboveLabel !== -1) {
        labels[pixIdx] = aboveLabel;
      } else {
        // Both neighbours — use left, merge with above
        labels[pixIdx] = leftLabel;
        union(leftLabel, aboveLabel);
      }
    }
  }

  // Second pass — collect region stats per root label
  const regions = new Map();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixIdx = y * width + x;
      if (labels[pixIdx] < 0) continue;

      const root = find(labels[pixIdx]);
      if (!regions.has(root)) {
        regions.set(root, {
          minX: x, maxX: x, minY: y, maxY: y,
          pixels: 0, sumR: 0, sumG: 0, sumB: 0,
          rimPixels: 0, rimSumR: 0, rimSumG: 0, rimSumB: 0,
        });
      }
      const reg = regions.get(root);
      const idx = (y * width + x) * 4;
      const r = data[idx], g = data[idx + 1], b = data[idx + 2];

      reg.pixels++;
      reg.sumR += r;
      reg.sumG += g;
      reg.sumB += b;

      // Classify this pixel as a rim (colorful edge) pixel if it has
      // meaningful saturation — i.e. it is NOT blown-out near-white.
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const pixSat = maxC === 0 ? 0 : (maxC - minC) / maxC;
      if (pixSat >= RIM_SAT_MIN) {
        reg.rimPixels++;
        reg.rimSumR += r;
        reg.rimSumG += g;
        reg.rimSumB += b;
      }

      if (x < reg.minX) reg.minX = x;
      if (x > reg.maxX) reg.maxX = x;
      if (y < reg.minY) reg.minY = y;
      if (y > reg.maxY) reg.maxY = y;
    }
  }

  return Array.from(regions.values());
}

// ─────────────────────────────────────────────────────────────────────────────
// Main processing loop
// ─────────────────────────────────────────────────────────────────────────────

// Offscreen canvas for pixel reads (kept at video resolution)
const offscreen = document.createElement('canvas');
const offCtx    = offscreen.getContext('2d', { willReadFrequently: true });

function processFrame() {
  if (video.readyState < video.HAVE_CURRENT_DATA) return;

  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (vw === 0 || vh === 0) return;

  // Keep offscreen canvas in sync with video dimensions
  if (offscreen.width !== vw || offscreen.height !== vh) {
    offscreen.width  = vw;
    offscreen.height = vh;
  }

  // Keep display canvas matching the window (CSS handles scaling)
  if (canvas.width !== vw || canvas.height !== vh) {
    canvas.width  = vw;
    canvas.height = vh;
  }

  // Compute source crop rectangle for the current zoom level
  // (used for both digital zoom fallback and bounding-box coordinate space)
  const cropW = vw / zoomLevel;
  const cropH = vh / zoomLevel;
  const cropX = (vw - cropW) / 2;
  const cropY = (vh - cropH) / 2;

  // Draw the zoomed crop to offscreen at full canvas resolution for analysis
  offCtx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, vw, vh);

  // Software exposure darkening: when native exposure is not available,
  // or as a supplement, darken the frame by drawing a semi-transparent black
  // overlay. Each step darkens by ~8% opacity. Negative steps = darken.
  // This recovers color saturation from overexposed/clipped LEDs.
  if (exposureSteps < 0) {
    const darkenAlpha = Math.min(0.85, (-exposureSteps) * 0.12);
    offCtx.fillStyle = `rgba(0,0,0,${darkenAlpha})`;
    offCtx.fillRect(0, 0, vw, vh);
  }

  const imageData = offCtx.getImageData(0, 0, vw, vh);

  // Find bright connected regions
  const regions = findBrightRegions(imageData, vw, vh, brightnessThreshold);

  // Filter by minimum area and pick the largest
  const candidates = regions.filter(r => r.pixels >= minAreaPx);
  const best = candidates.length > 0
    ? candidates.reduce((a, b) => (a.pixels > b.pixels ? a : b))
    : null;

  // Draw the same zoomed crop to the visible canvas, then apply darkening
  ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, vw, vh);
  if (exposureSteps < 0) {
    const darkenAlpha = Math.min(0.85, (-exposureSteps) * 0.12);
    ctx.fillStyle = `rgba(0,0,0,${darkenAlpha})`;
    ctx.fillRect(0, 0, vw, vh);
  }

  if (best) {
    const avgR = best.sumR / best.pixels;
    const avgG = best.sumG / best.pixels;
    const avgB = best.sumB / best.pixels;

    // Reject regions whose average brightness is too close to the threshold —
    // these are likely the unlit LED strip reflecting ambient light.
    const avgBrightness = Math.max(avgR, avgG, avgB);
    if (avgBrightness < brightnessThreshold * REGION_AVG_BRIGHTNESS_RATIO) {
      scheduleHideResult();
      return;
    }

    // Prefer rim (colorful edge) pixels for classification; they are not
    // blown-out and carry the true hue. Fall back to all-pixel average
    // only if too few rim pixels were found (< 5% of region or < 10 px).
    const useRim = best.rimPixels >= 10 && best.rimPixels >= best.pixels * 0.05;
    const sampleR = useRim ? best.rimSumR / best.rimPixels : avgR;
    const sampleG = useRim ? best.rimSumG / best.rimPixels : avgG;
    const sampleB = useRim ? best.rimSumB / best.rimPixels : avgB;

    const colorDef = classifyColor(sampleR, sampleG, sampleB);
    if (!colorDef) {
      // White detection disabled and result would be white — treat as no detection
      scheduleHideResult();
      return;
    }

    // Draw bounding box
    const boxW = best.maxX - best.minX + 1;
    const boxH = best.maxY - best.minY + 1;
    ctx.strokeStyle = colorDef.css;
    ctx.lineWidth   = 4;
    ctx.strokeRect(best.minX, best.minY, boxW, boxH);

    // Update the result panel
    cancelHideResult();
    swatchEl.style.backgroundColor = colorDef.css;
    colorNameEl.textContent         = colorDef.name;
    resultPanel.classList.remove('hidden');
  } else {
    scheduleHideResult();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────
startCamera().then(() => {
  setInterval(processFrame, FRAME_INTERVAL_MS);
});

// Stamp version into the settings panel
document.getElementById('versionLabel').textContent = APP_VERSION;
