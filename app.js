// ─────────────────────────────────────────────────────────────────────────────
// Constants & tunable defaults
// ─────────────────────────────────────────────────────────────────────────────
const FRAME_INTERVAL_MS = 100; // how often to process a frame

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
const toggleBtn    = document.getElementById('toggleSettings');
const showBtn      = document.getElementById('showSettings');
const settingsPanel = document.getElementById('settings');

// ─────────────────────────────────────────────────────────────────────────────
// Settings state
// ─────────────────────────────────────────────────────────────────────────────
let brightnessThreshold = parseInt(threshSlider.value, 10);
let minAreaPx           = parseInt(areaSlider.value, 10);

threshSlider.addEventListener('input', () => {
  brightnessThreshold = parseInt(threshSlider.value, 10);
  threshVal.textContent = brightnessThreshold;
});

areaSlider.addEventListener('input', () => {
  minAreaPx = parseInt(areaSlider.value, 10);
  areaVal.textContent = minAreaPx;
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

  // Low saturation → white (or very dim — but those shouldn't reach this function)
  if (s < 0.25 || v > 0.95 && s < 0.35) {
    return COLOR_DEFS[0]; // White
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
// Returns array of { minX, maxX, minY, maxY, pixels: count, sumR, sumG, sumB }
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
        regions.set(root, { minX: x, maxX: x, minY: y, maxY: y, pixels: 0, sumR: 0, sumG: 0, sumB: 0 });
      }
      const reg = regions.get(root);
      const idx = (y * width + x) * 4;
      reg.pixels++;
      reg.sumR += data[idx];
      reg.sumG += data[idx + 1];
      reg.sumB += data[idx + 2];
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

  // Draw current video frame to offscreen for pixel analysis
  offCtx.drawImage(video, 0, 0, vw, vh);
  const imageData = offCtx.getImageData(0, 0, vw, vh);

  // Find bright connected regions
  const regions = findBrightRegions(imageData, vw, vh, brightnessThreshold);

  // Filter by minimum area and pick the largest
  const candidates = regions.filter(r => r.pixels >= minAreaPx);
  const best = candidates.length > 0
    ? candidates.reduce((a, b) => (a.pixels > b.pixels ? a : b))
    : null;

  // Draw the camera frame onto the visible canvas
  ctx.drawImage(video, 0, 0, vw, vh);

  if (best) {
    const avgR = best.sumR / best.pixels;
    const avgG = best.sumG / best.pixels;
    const avgB = best.sumB / best.pixels;
    const colorDef = classifyColor(avgR, avgG, avgB);

    // Draw bounding box
    const boxW = best.maxX - best.minX + 1;
    const boxH = best.maxY - best.minY + 1;
    ctx.strokeStyle = colorDef.css;
    ctx.lineWidth   = 4;
    ctx.strokeRect(best.minX, best.minY, boxW, boxH);

    // Update the result panel
    swatchEl.style.backgroundColor = colorDef.css;
    colorNameEl.textContent         = colorDef.name;
    resultPanel.classList.remove('hidden');
  } else {
    resultPanel.classList.add('hidden');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────
startCamera().then(() => {
  setInterval(processFrame, FRAME_INTERVAL_MS);
});
