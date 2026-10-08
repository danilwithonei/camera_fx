// Isolated-world bridge: forwards settings from chrome.storage to inject.js,
// which runs in the page's MAIN world and has no access to extension APIs.

const DEFAULTS = {
    effectEnabled: true,
    effectMode: 'grayscale',
    lensRadius: 100,
    lensAlpha: 50,
    ps1Model: 'tv',
    ps1Distance: 5.5,
    ps1Amplitude: 0.8,
    ps1Speed: 0.02,
    ps1Random: false,
    pixelSize: 12,
    pixelPadding: 4,
    censorshipWidth: 150,
    censorshipHeight: 45,
    offsetX: 0,
    offsetY: 0,
    letterboxRatio: '2.39',
    letterboxBW: false,
    gsOffsetX: 0,
    gsOffsetY: 0,
    gsSize: 50,
    gsRotation: 0,
    gsTolerance: 50,
    laserLength: 100,
    laserWidth: 25,
    laserFire: 60,
    laserFollowHead: true,
    laserAngle: 60
};

// Large data URLs: sent only initially and when they change.
const MEDIA_KEYS = ['customImage', 'gsVideoUrl'];

function sendState(includeMedia) {
    const keys = Object.keys(DEFAULTS).concat(includeMedia ? MEDIA_KEYS : []);
    chrome.storage.local.get(keys, (stored) => {
        const settings = {};
        for (const key of Object.keys(DEFAULTS)) {
            settings[key] = stored[key] !== undefined ? stored[key] : DEFAULTS[key];
        }
        const message = { type: 'CAMERA_FX_STATE', extUrl: chrome.runtime.getURL(''), settings };
        if (includeMedia) {
            for (const key of MEDIA_KEYS) message[key] = stored[key] || null;
        }
        window.postMessage(message, '*');
    });
}

window.addEventListener('message', (event) => {
    if (event.source === window && event.data && event.data.type === 'CAMERA_FX_GET_STATE') {
        sendState(true);
    }
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    sendState(MEDIA_KEYS.some(key => key in changes));
});

// inject.js may have started before this listener existed, so push state now too.
sendState(true);
