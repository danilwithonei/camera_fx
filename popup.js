// Every settings control has an id equal to its chrome.storage key.
const NUMBER_INPUTS = [
    'lensRadius', 'lensAlpha',
    'ps1Distance', 'ps1Amplitude', 'ps1Speed',
    'pixelSize', 'pixelPadding',
    'censorshipWidth', 'censorshipHeight', 'offsetX', 'offsetY',
    'gsSize', 'gsRotation', 'gsTolerance',
    'laserLength', 'laserWidth', 'laserFire', 'laserAngle'
];
const CHECKBOXES = ['effectEnabled', 'ps1Random', 'letterboxBW', 'laserFollowHead'];
const SELECTS = ['effectMode', 'ps1Model', 'letterboxRatio'];

// Keys left behind by the removed "hand overlay" effect.
const OBSOLETE_KEYS = ['hoSize', 'hoRotation', 'hoTolerance', 'hoVideoUrl', 'hoSkeleton'];

const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

const $ = id => document.getElementById(id);
const modeSelect = $('effectMode');

function updateUI(mode) {
    document.querySelectorAll('.controls').forEach(panel => {
        panel.classList.toggle('active', panel.dataset.modes.split(' ').includes(mode));
    });
    $('imageUploadRow').style.display = mode === 'image_overlay' ? 'flex' : 'none';
    updateLaserAngleRow();
}

// The fixed angle only matters when beams don't follow the head.
function updateLaserAngleRow() {
    $('laserAngleRow').style.display = $('laserFollowHead').checked ? 'none' : 'flex';
}

function save(values) {
    chrome.storage.local.set(values, () => {
        if (chrome.runtime.lastError) alert(`Не удалось сохранить: ${chrome.runtime.lastError.message}`);
    });
}

chrome.storage.local.remove(OBSOLETE_KEYS);

chrome.storage.local.get([...NUMBER_INPUTS, ...CHECKBOXES, ...SELECTS, 'gsOffsetX', 'gsOffsetY'], (stored) => {
    for (const key of NUMBER_INPUTS) {
        if (stored[key] !== undefined) $(key).value = stored[key];
    }
    for (const key of CHECKBOXES) {
        if (stored[key] !== undefined) $(key).checked = stored[key];
    }
    for (const key of SELECTS) {
        if (stored[key] !== undefined) $(key).value = stored[key];
    }
    // Stored mode may no longer exist (e.g. a removed effect).
    if (modeSelect.selectedIndex === -1) {
        modeSelect.value = 'grayscale';
        save({ effectMode: 'grayscale' });
    }
    updateUI(modeSelect.value);
    moveGsDot(stored.gsOffsetX || 0, stored.gsOffsetY || 0);
    updateGsDotSize(parseFloat($('gsSize').value));
});

for (const key of NUMBER_INPUTS) {
    $(key).addEventListener('input', () => save({ [key]: parseFloat($(key).value) }));
}
for (const key of CHECKBOXES) {
    $(key).addEventListener('change', () => save({ [key]: $(key).checked }));
}
for (const key of SELECTS) {
    $(key).addEventListener('change', () => save({ [key]: $(key).value }));
}
modeSelect.addEventListener('change', () => updateUI(modeSelect.value));
$('laserFollowHead').addEventListener('change', updateLaserAngleRow);
$('gsSize').addEventListener('input', () => updateGsDotSize(parseFloat($('gsSize').value)));

// Green screen position pad: offsets are in video pixels, ±500.
const gsPad = $('gsPad');
const gsDot = $('gsDot');
const PAD_W = 210, PAD_H = 120, MAX_OFFSET = 500;
let dragging = false;

function moveGsDot(ox, oy) {
    gsDot.style.left = Math.max(0, Math.min(PAD_W, PAD_W / 2 * (1 + ox / MAX_OFFSET))) + 'px';
    gsDot.style.top = Math.max(0, Math.min(PAD_H, PAD_H / 2 * (1 + oy / MAX_OFFSET))) + 'px';
}

function updateGsDotSize(size) {
    const s = 12 + size * 0.24;
    gsDot.style.width = s + 'px';
    gsDot.style.height = s + 'px';
}

function handleGsDrag(clientX, clientY) {
    const rect = gsPad.getBoundingClientRect();
    const px = Math.max(0, Math.min(PAD_W, clientX - rect.left));
    const py = Math.max(0, Math.min(PAD_H, clientY - rect.top));
    const ox = Math.round((px / (PAD_W / 2) - 1) * MAX_OFFSET);
    const oy = Math.round((py / (PAD_H / 2) - 1) * MAX_OFFSET);
    moveGsDot(ox, oy);
    save({ gsOffsetX: ox, gsOffsetY: oy });
}

gsPad.addEventListener('pointerdown', (e) => {
    dragging = true;
    gsPad.setPointerCapture(e.pointerId);
    handleGsDrag(e.clientX, e.clientY);
});
gsPad.addEventListener('pointermove', (e) => { if (dragging) handleGsDrag(e.clientX, e.clientY); });
gsPad.addEventListener('pointerup', () => { dragging = false; });
gsPad.addEventListener('pointercancel', () => { dragging = false; });

function readFileAsDataURL(file, maxBytes, tooBigMessage, onLoad) {
    if (!file) return;
    if (file.size > maxBytes) {
        alert(tooBigMessage);
        return;
    }
    const reader = new FileReader();
    reader.onload = () => onLoad(reader.result);
    reader.readAsDataURL(file);
}

$('imageUpload').addEventListener('change', (e) => {
    readFileAsDataURL(e.target.files[0], MAX_IMAGE_BYTES, 'Картинка слишком большая! Выберите файл меньше 1.5 МБ',
        dataUrl => save({ customImage: dataUrl }));
});

$('gsVideoUpload').addEventListener('change', (e) => {
    readFileAsDataURL(e.target.files[0], MAX_VIDEO_BYTES, 'Видео слишком большое! Выберите файл меньше 50 МБ',
        dataUrl => save({ gsVideoUrl: dataUrl }));
});
