// Runs in the page's MAIN world at document_start (see manifest.json), so the
// getUserMedia patch is installed before any page script can grab the camera.
// Settings and the extension base URL arrive from content.js via postMessage.
(function () {
    'use strict';

    if (window.__cameraFxInstalled) return;
    window.__cameraFxInstalled = true;

    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices || !mediaDevices.getUserMedia) return;
    const originalGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);

    const FACE_MODES = ['lens', 'censorship', 'image_overlay', 'pixelate', 'laser_eyes'];
    const DETECT_INTERVAL_MS = 50;
    const PS1_WIDTH = 320;
    const PS1_HEIGHT = 240;

    let settings = null; // null until content.js sends the first state
    let extUrl = null;
    let resolveExtUrl;
    const extUrlReady = new Promise(resolve => { resolveExtUrl = resolve; });

    // ---------- Shared resources (loaded lazily, reused by all streams) ----------

    let faceLandmarker = null;
    let faceLandmarkerPromise = null;
    let lastFaceTimestamp = 0;

    let THREE = null;
    let GLTFLoader = null;
    let threePromise = null;

    const overlayImage = new Image();
    let customImage = null;

    const gsVideo = document.createElement('video');
    gsVideo.loop = true;
    gsVideo.muted = true;
    gsVideo.playsInline = true;
    let customGsVideo = null;

    function loadFaceLandmarker() {
        if (!faceLandmarkerPromise) {
            faceLandmarkerPromise = (async () => {
                const base = await extUrlReady;
                const vision = await import(`${base}lib/vision_bundle.mjs`);
                const fileset = await vision.FilesetResolver.forVisionTasks(`${base}lib`);
                faceLandmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
                    baseOptions: { modelAssetPath: `${base}models/face_landmarker.task`, delegate: 'GPU' },
                    outputFaceBlendshapes: false,
                    runningMode: 'VIDEO',
                    numFaces: 1
                });
            })().catch(e => {
                console.error('[CameraFX] Failed to load FaceLandmarker', e);
                faceLandmarkerPromise = null;
            });
        }
        return faceLandmarkerPromise;
    }

    function loadThree() {
        if (!threePromise) {
            threePromise = (async () => {
                const base = await extUrlReady;
                const three = await import(`${base}lib/three.module.js`);
                const gltf = await import(`${base}lib/GLTFLoader.js`);
                GLTFLoader = gltf.GLTFLoader;
                THREE = three;
            })().catch(e => {
                console.error('[CameraFX] Failed to load Three.js', e);
                threePromise = null;
            });
        }
        return threePromise;
    }

    function updateOverlayImage() {
        const src = customImage || (extUrl && `${extUrl}image.png`);
        if (src && overlayImage.src !== src) overlayImage.src = src;
    }

    function updateGsVideo() {
        const src = customGsVideo || (extUrl && `${extUrl}green_screens/1.webm`);
        if (src && gsVideo.src !== src) gsVideo.src = src;
        const active = settings && settings.effectEnabled && settings.effectMode === 'greenscreen';
        if (active && gsVideo.src) {
            if (gsVideo.paused) gsVideo.play().catch(() => {});
        } else if (!gsVideo.paused) {
            gsVideo.pause();
        }
    }

    function onSettingsChanged() {
        if (!settings.effectEnabled) {
            updateGsVideo();
            return;
        }
        const mode = settings.effectMode;
        if (mode === 'ps1') loadThree();
        else if (FACE_MODES.includes(mode)) loadFaceLandmarker();
        updateGsVideo();
    }

    window.addEventListener('message', (event) => {
        if (event.source !== window || !event.data || event.data.type !== 'CAMERA_FX_STATE') return;
        const data = event.data;
        if (data.extUrl && !extUrl) {
            extUrl = data.extUrl;
            resolveExtUrl(extUrl);
        }
        // Media is only sent when it changes, so moving a slider doesn't reload it.
        if ('customImage' in data) customImage = data.customImage;
        if ('gsVideoUrl' in data) customGsVideo = data.gsVideoUrl;
        settings = data.settings;
        updateOverlayImage();
        onSettingsChanged();
    });

    window.postMessage({ type: 'CAMERA_FX_GET_STATE' }, '*');

    // ---------- WebGL filters ----------

    const VERTEX_SHADER = `
        attribute vec2 a_position;
        varying vec2 v_uv;
        void main() {
            v_uv = vec2(a_position.x * 0.5 + 0.5, 0.5 - a_position.y * 0.5);
            gl_Position = vec4(a_position, 0.0, 1.0);
        }`;

    const GRAYSCALE_SHADER = `
        precision mediump float;
        uniform sampler2D u_image;
        varying vec2 v_uv;
        void main() {
            vec4 c = texture2D(u_image, v_uv);
            float gray = dot(c.rgb, vec3(0.299, 0.587, 0.114));
            gl_FragColor = vec4(vec3(gray), 1.0);
        }`;

    const LENS_SHADER = `
        precision mediump float;
        uniform sampler2D u_image;
        uniform vec2 u_center;
        uniform float u_radius;
        uniform float u_alpha;
        uniform vec2 u_resolution;
        varying vec2 v_uv;
        void main() {
            vec2 pixel = v_uv * u_resolution;
            vec2 shift = pixel - u_center;
            float dist = length(shift);
            vec2 uv = v_uv;
            if (dist < u_radius * 2.0) {
                float factor = sin((dist / u_radius) * 1.5707963) * u_alpha;
                uv = clamp((pixel - shift * (factor / (dist + 1e-5))) / u_resolution, 0.0, 1.0);
            }
            gl_FragColor = texture2D(u_image, uv);
        }`;

    const CHROMA_KEY_SHADER = `
        precision mediump float;
        uniform sampler2D u_image;
        uniform float u_threshold;
        varying vec2 v_uv;
        void main() {
            vec4 c = texture2D(u_image, v_uv);
            float m = max(c.r, c.b);
            float a = (c.g > m && c.g - m > u_threshold) ? 0.0 : 1.0;
            gl_FragColor = vec4(c.rgb * a, a);
        }`;

    function createGLFilter(fragmentSource) {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });
        if (!gl) return null;

        const compile = (type, source) => {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            return shader;
        };
        const program = gl.createProgram();
        gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
        gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error('[CameraFX] Shader link failed', gl.getProgramInfoLog(program));
            return null;
        }
        gl.useProgram(program);

        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
        const positionLocation = gl.getAttribLocation(program, 'a_position');
        gl.enableVertexAttribArray(positionLocation);
        gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

        gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

        const uniformLocations = {};
        const uniform = name => {
            if (!(name in uniformLocations)) uniformLocations[name] = gl.getUniformLocation(program, name);
            return uniformLocations[name];
        };

        return {
            render(source, width, height, uniforms = {}) {
                if (canvas.width !== width || canvas.height !== height) {
                    canvas.width = width;
                    canvas.height = height;
                }
                gl.viewport(0, 0, width, height);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
                for (const [name, value] of Object.entries(uniforms)) {
                    if (Array.isArray(value)) gl.uniform2f(uniform(name), value[0], value[1]);
                    else gl.uniform1f(uniform(name), value);
                }
                gl.drawArrays(gl.TRIANGLES, 0, 6);
                return canvas;
            },
            dispose() {
                const ext = gl.getExtension('WEBGL_lose_context');
                if (ext) ext.loseContext();
            }
        };
    }

    // ---------- Laser eyes ----------

    const FIRE_SPRITE_STEPS = 8;
    const MAX_FIRE_PARTICLES = 600;
    let fireSprites = null;

    // Soft round sprites from yellow-white (young flame) to dark red (dying ember).
    function getFireSprites() {
        if (!fireSprites) {
            fireSprites = [];
            for (let i = 0; i < FIRE_SPRITE_STEPS; i++) {
                const k = i / (FIRE_SPRITE_STEPS - 1);
                const sprite = document.createElement('canvas');
                sprite.width = sprite.height = 64;
                const sctx = sprite.getContext('2d');
                const g = sctx.createRadialGradient(32, 32, 0, 32, 32, 32);
                const hue = 50 * (1 - k);
                g.addColorStop(0, `hsla(${hue}, 100%, ${85 - 45 * k}%, 1)`);
                g.addColorStop(0.4, `hsla(${hue}, 100%, ${60 - 30 * k}%, 0.6)`);
                g.addColorStop(1, `hsla(${hue}, 100%, 30%, 0)`);
                sctx.fillStyle = g;
                sctx.fillRect(0, 0, 64, 64);
                fireSprites.push(sprite);
            }
        }
        return fireSprites;
    }

    const BEAM_LAYERS = [
        { scale: 2.4, rgb: '255, 30, 0', alpha: 0.35, blur: 2 },
        { scale: 1.3, rgb: '255, 110, 0', alpha: 0.8, blur: 1 },
        { scale: 0.55, rgb: '255, 225, 120', alpha: 1, blur: 0 },
        { scale: 0.2, rgb: '255, 255, 255', alpha: 1, blur: 0 }
    ];

    // Landmarks of each eye: corners and lid centers.
    const LASER_EYES = [
        { outer: 33, inner: 133, upper: 159, lower: 145 },
        { outer: 263, inner: 362, upper: 386, lower: 374 }
    ];
    // Eye aspect ratio (lid gap / eye width) thresholds; the gap between them
    // keeps a half-closed eye from flickering the laser on and off.
    const EYE_CLOSED_RATIO = 0.15;
    const EYE_OPEN_RATIO = 0.2;

    const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const normalize3 = v => {
        const len = Math.hypot(v[0], v[1], v[2]) || 1;
        return [v[0] / len, v[1] / len, v[2] / len];
    };

    // ---------- PS1 3D renderer ----------

    async function fetchAsDataURL(url) {
        try {
            const blob = await (await fetch(url)).blob();
            return await new Promise(resolve => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.readAsDataURL(blob);
            });
        } catch (e) {
            console.error('[CameraFX] Failed to fetch', url, e);
            return null;
        }
    }

    function ps1ModelInfo(type) {
        const base = `${extUrl}models3d/`;
        switch (type) {
            case 'tv': return { path: `${base}tv/tv.gltf`, bodyTexture: `${base}tv/Material Base Color.png` };
            case 'one_hand': return { path: `${base}one_hand/ONE_HAND.gltf`, bodyTexture: `${base}one_hand/Body_Mat Base Color.png` };
            case 'car': return { path: `${base}car.glb` };
            case 'wm': return { path: `${base}wm.glb` };
            default: return { path: `${base}head.glb` };
        }
    }

    class PS1Renderer {
        constructor(video) {
            this.video = video;
            this.scene = new THREE.Scene();
            this.scene.background = new THREE.Color(0x050505);

            this.camera = new THREE.PerspectiveCamera(60, video.videoWidth / video.videoHeight, 0.1, 1000);
            this.camera.position.set(0, 0.5, settings.ps1Distance);
            this.camera.lookAt(0, 0, 0);

            this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
            this.renderer.setSize(PS1_WIDTH, PS1_HEIGHT, false);
            this.renderer.setPixelRatio(1);

            this.scene.add(new THREE.AmbientLight(0xffffff, 1.4));
            const light = new THREE.DirectionalLight(0xffffff, 0.8);
            light.position.set(2, 2, 5);
            this.scene.add(light);

            this.textureCanvas = document.createElement('canvas');
            this.textureCanvas.width = 512;
            this.textureCanvas.height = 512;
            this.textureCtx = this.textureCanvas.getContext('2d');

            this.faceTexture = new THREE.CanvasTexture(this.textureCanvas);
            this.faceTexture.flipY = false;
            this.faceTexture.magFilter = THREE.NearestFilter;
            this.faceTexture.minFilter = THREE.NearestFilter;

            this.ps1ShaderMaterial = new THREE.ShaderMaterial({
                uniforms: { u_texture: { value: null } },
                vertexShader: `
                    varying vec2 vUv;
                    void main() {
                        vUv = uv;
                        vec4 clipPosition = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                        float grid = 160.0;
                        clipPosition.xyz = floor(clipPosition.xyz * grid) / grid;
                        gl_Position = clipPosition;
                    }`,
                fragmentShader: `
                    varying vec2 vUv;
                    uniform sampler2D u_texture;
                    void main() {
                        vec4 color = texture2D(u_texture, vUv);
                        float levels = 16.0;
                        gl_FragColor = vec4(floor(color.rgb * levels) / levels, 1.0);
                    }`
            });

            this.modelContainer = new THREE.Group();
            this.scene.add(this.modelContainer);
            this.loader = new GLTFLoader();
            this.currentModelType = null;
            this.modelYaw = 0;
            this.modelPitch = 0;
            this.modelRoll = 0;
        }

        async loadModel(type) {
            if (this.currentModelType === type) return;
            this.currentModelType = type;
            this.modelContainer.clear();

            const info = ps1ModelInfo(type);
            let bodyTexture = null;
            if (info.bodyTexture) {
                const dataUrl = await fetchAsDataURL(info.bodyTexture);
                if (dataUrl) {
                    bodyTexture = new THREE.TextureLoader().load(dataUrl);
                    bodyTexture.flipY = false;
                    bodyTexture.magFilter = THREE.NearestFilter;
                    bodyTexture.minFilter = THREE.NearestFilter;
                }
            }
            if (this.currentModelType !== type) return; // switched while loading

            this.loader.load(info.path, (gltf) => {
                if (this.currentModelType !== type) return;
                const model = gltf.scene;
                const box = new THREE.Box3().setFromObject(model);
                const center = box.getCenter(new THREE.Vector3());
                const size = box.getSize(new THREE.Vector3());
                const scale = 3.0 / (size.y || 1);
                model.scale.setScalar(scale);
                model.position.copy(center).multiplyScalar(-scale);

                model.traverse(c => {
                    if (!c.isMesh) return;
                    const name = c.name.toLowerCase();
                    const matName = (c.material && c.material.name || '').toLowerCase();
                    const isScreen = ['screen', 'face', 'display', 'glass', 'monitor'].some(k => name.includes(k))
                        || matName.includes('screen');
                    if (isScreen) {
                        c.material = new THREE.MeshBasicMaterial({ map: this.faceTexture, side: THREE.DoubleSide });
                        return;
                    }
                    const map = bodyTexture || (c.material && c.material.map);
                    if (map) {
                        const material = this.ps1ShaderMaterial.clone();
                        material.uniforms.u_texture.value = map;
                        c.material = material;
                    }
                });
                this.modelContainer.clear();
                this.modelContainer.add(model);
            }, undefined, err => console.error('[CameraFX] Model load error', err));
        }

        render(targetCtx, targetWidth, targetHeight) {
            this.loadModel(settings.ps1Model);
            this.camera.position.z = settings.ps1Distance;

            this.textureCtx.drawImage(this.video, 0, 0, 512, 512);
            this.faceTexture.needsUpdate = true;

            const { ps1Speed: speed, ps1Amplitude: amplitude } = settings;
            const baseRotationY = this.currentModelType === 'head' ? 0 : Math.PI;
            const container = this.modelContainer;
            this.modelYaw += speed;
            container.rotation.y = baseRotationY + Math.sin(this.modelYaw) * amplitude;
            if (settings.ps1Random) {
                this.modelPitch += speed * 0.7;
                this.modelRoll += speed * 0.4;
                container.rotation.x = Math.sin(this.modelPitch) * amplitude * 0.5;
                container.rotation.z = Math.cos(this.modelRoll) * amplitude * 0.3;
                container.position.set(Math.cos(this.modelPitch * 0.5) * 0.2, Math.sin(this.modelYaw * 0.5) * 0.2, 0);
            } else {
                container.rotation.x = 0;
                container.rotation.z = 0;
                container.position.set(0, 0, 0);
            }

            this.renderer.render(this.scene, this.camera);
            targetCtx.imageSmoothingEnabled = false;
            targetCtx.drawImage(this.renderer.domElement, 0, 0, PS1_WIDTH, PS1_HEIGHT, 0, 0, targetWidth, targetHeight);
            targetCtx.imageSmoothingEnabled = true;
        }

        dispose() {
            this.renderer.dispose();
            this.renderer.forceContextLoss();
        }
    }

    // ---------- getUserMedia patch ----------

    mediaDevices.getUserMedia = async function (constraints) {
        const stream = await originalGetUserMedia(constraints);
        if (!constraints || !constraints.video || stream.getVideoTracks().length === 0) return stream;
        return applyEffect(stream);
    };

    function applyEffect(stream) {
        const cameraTracks = stream.getVideoTracks();
        const video = document.createElement('video');
        video.srcObject = new MediaStream(cameraTracks);
        video.muted = true;
        video.playsInline = true;
        video.play().catch(() => {});

        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 480;
        const ctx = canvas.getContext('2d', { alpha: false });

        // Per-stream state, created on demand.
        const filters = {};
        const getFilter = (name, source) => {
            if (!(name in filters)) filters[name] = createGLFilter(source);
            return filters[name];
        };
        let ps1 = null;
        let faceResults = null;
        let lastDetection = 0;
        const pixelCanvas = document.createElement('canvas');
        const pixelCtx = pixelCanvas.getContext('2d');
        let fireParticles = [];
        let laserForward = null; // smoothed 3D head direction
        let laserLastTime = 0;
        const laserEyeOpen = [true, true];
        const laserEyePower = [1, 1]; // 0..1, fades beams in and out

        function detectFace() {
            const now = performance.now();
            if (now - lastDetection > DETECT_INTERVAL_MS) {
                // detectForVideo needs strictly increasing timestamps across all streams.
                lastFaceTimestamp = Math.max(now, lastFaceTimestamp + 1);
                faceResults = faceLandmarker.detectForVideo(video, lastFaceTimestamp);
                lastDetection = now;
            }
            const faces = faceResults && faceResults.faceLandmarks;
            return faces && faces.length > 0 ? faces[0] : null;
        }

        function drawGrayscale(w, h) {
            const gray = getFilter('gray', GRAYSCALE_SHADER);
            if (gray) {
                ctx.drawImage(gray.render(video, w, h), 0, 0);
            } else {
                ctx.filter = 'grayscale(100%)';
                ctx.drawImage(video, 0, 0, w, h);
                ctx.filter = 'none';
            }
        }

        function drawLetterbox(w, h) {
            if (settings.letterboxBW) drawGrayscale(w, h);
            else ctx.drawImage(video, 0, 0, w, h);
            const ratio = parseFloat(settings.letterboxRatio) || 2.39;
            const barHeight = Math.round((h - w / ratio) / 2);
            if (barHeight > 0) {
                ctx.fillStyle = 'black';
                ctx.fillRect(0, 0, w, barHeight);
                ctx.fillRect(0, h - barHeight, w, barHeight);
            }
        }

        function drawLens(w, h, landmarks) {
            const lens = getFilter('lens', LENS_SHADER);
            if (!lens || !landmarks) return ctx.drawImage(video, 0, 0, w, h);
            const nose = landmarks[4];
            ctx.drawImage(lens.render(video, w, h, {
                u_center: [nose.x * w, nose.y * h],
                u_radius: settings.lensRadius,
                u_alpha: settings.lensAlpha,
                u_resolution: [w, h]
            }), 0, 0);
        }

        function drawEyeOverlay(w, h, landmarks) {
            ctx.drawImage(video, 0, 0, w, h);
            if (!landmarks) return;
            const leftEye = landmarks[33];
            const rightEye = landmarks[263];
            const nose = landmarks[4];
            const dx = (rightEye.x - leftEye.x) * w;
            const dy = (rightEye.y - leftEye.y) * h;
            const scale = Math.hypot(dx, dy) / 100;
            const rectW = settings.censorshipWidth * scale;
            const rectH = settings.censorshipHeight * scale;
            ctx.save();
            ctx.translate(nose.x * w, nose.y * h);
            ctx.rotate(Math.atan2(dy, dx));
            ctx.translate(settings.offsetX * scale, settings.offsetY * scale);
            if (settings.effectMode === 'censorship') {
                ctx.fillStyle = 'black';
                ctx.fillRect(-rectW / 2, -rectH / 2, rectW, rectH);
            } else if (overlayImage.complete && overlayImage.naturalWidth) {
                ctx.drawImage(overlayImage, -rectW / 2, -rectH / 2, rectW, rectH);
            }
            ctx.restore();
        }

        function drawLaserBeam(ex, ey, dx, dy, length, width, flicker) {
            const nx = -dy, ny = dx;
            const endX = ex + dx * length;
            const endY = ey + dy * length;
            for (const layer of BEAM_LAYERS) {
                const start = width * layer.scale * flicker / 2;
                const end = start * 2.5; // beam spreads with distance
                const g = ctx.createLinearGradient(ex, ey, endX, endY);
                g.addColorStop(0, `rgba(${layer.rgb}, ${layer.alpha})`);
                g.addColorStop(0.7, `rgba(${layer.rgb}, ${layer.alpha * 0.6})`);
                g.addColorStop(1, `rgba(${layer.rgb}, 0)`);
                ctx.fillStyle = g;
                ctx.shadowColor = `rgba(${layer.rgb}, 1)`;
                ctx.shadowBlur = width * layer.blur;
                ctx.beginPath();
                ctx.moveTo(ex + nx * start, ey + ny * start);
                ctx.lineTo(endX + nx * end, endY + ny * end);
                ctx.lineTo(endX - nx * end, endY - ny * end);
                ctx.lineTo(ex - nx * start, ey - ny * start);
                ctx.closePath();
                ctx.fill();
            }
            ctx.shadowBlur = 0;
        }

        function drawEyeFlare(ex, ey, width, angle, flicker) {
            const r = width * 3 * flicker;
            const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
            g.addColorStop(0, 'rgba(255, 255, 255, 1)');
            g.addColorStop(0.2, 'rgba(255, 220, 110, 0.9)');
            g.addColorStop(0.5, 'rgba(255, 90, 0, 0.4)');
            g.addColorStop(1, 'rgba(255, 0, 0, 0)');
            ctx.fillStyle = g;
            ctx.save();
            ctx.translate(ex, ey);
            ctx.fillRect(-r, -r, r * 2, r * 2);
            // Anamorphic streak along the eye line.
            ctx.rotate(angle);
            ctx.scale(4, 0.15);
            ctx.fillRect(-r, -r, r * 2, r * 2);
            ctx.restore();
        }

        function spawnFire(ex, ey, dx, dy, length, width, dt, power) {
            const count = Math.round(settings.laserFire * 6 * dt * power * (0.5 + Math.random()));
            for (let i = 0; i < count && fireParticles.length < MAX_FIRE_PARTICLES; i++) {
                const t = Math.pow(Math.random(), 1.5) * length * 0.8;
                const side = (Math.random() - 0.5) * width;
                const speed = length * (0.3 + Math.random() * 0.5);
                const spread = (Math.random() - 0.5) * width * 4;
                fireParticles.push({
                    x: ex + dx * t - dy * side,
                    y: ey + dy * t + dx * side,
                    vx: dx * speed - dy * spread,
                    vy: dy * speed + dx * spread,
                    size: width * (0.8 + Math.random() * 1.2) * (1 + t / length * 2),
                    age: 0,
                    life: 0.25 + Math.random() * 0.45
                });
            }
        }

        function drawFire(dt) {
            const sprites = getFireSprites();
            fireParticles = fireParticles.filter(p => (p.age += dt) < p.life);
            for (const p of fireParticles) {
                p.x += p.vx * dt;
                p.y += p.vy * dt;
                p.vy -= p.size * 6 * dt; // flames rise
                const k = p.age / p.life;
                const size = p.size * (1 + k);
                ctx.globalAlpha = (1 - k) * 0.9;
                ctx.drawImage(sprites[Math.min(FIRE_SPRITE_STEPS - 1, Math.floor(k * FIRE_SPRITE_STEPS))],
                    p.x - size / 2, p.y - size / 2, size, size);
            }
            ctx.globalAlpha = 1;
        }

        function drawLaserEyes(w, h, landmarks) {
            ctx.drawImage(video, 0, 0, w, h);
            const now = performance.now();
            const dt = laserLastTime ? Math.min(0.1, (now - laserLastTime) / 1000) : 0;
            laserLastTime = now;

            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            if (landmarks) {
                const pt = i => [landmarks[i].x * w, landmarks[i].y * h, landmarks[i].z * w];
                const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
                const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
                let eyes = LASER_EYES.map(e => mid(pt(e.outer), pt(e.inner)));
                // 468/473 are iris centers (absent in older models); match each to its eye.
                if (landmarks.length > 473) {
                    const irises = [pt(468), pt(473)];
                    if (dist(irises[0], eyes[0]) > dist(irises[0], eyes[1])) irises.reverse();
                    eyes = irises;
                }
                LASER_EYES.forEach((e, i) => {
                    const ratio = dist(pt(e.upper), pt(e.lower)) / (dist(pt(e.outer), pt(e.inner)) || 1);
                    if (ratio < EYE_CLOSED_RATIO) laserEyeOpen[i] = false;
                    else if (ratio > EYE_OPEN_RATIO) laserEyeOpen[i] = true;
                    const target = laserEyeOpen[i] ? 1 : 0;
                    laserEyePower[i] += (target - laserEyePower[i]) * Math.min(1, dt * 15);
                });
                const right = sub3(pt(263), pt(33));
                const up = sub3(pt(10), pt(152));
                const eyeDist = Math.hypot(right[0], right[1]);
                const eyeAngle = Math.atan2(right[1], right[0]);

                let dx, dy, reach;
                if (settings.laserFollowHead) {
                    const forward = normalize3(cross3(right, up));
                    laserForward = laserForward
                        ? normalize3(laserForward.map((v, i) => v * 0.7 + forward[i] * 0.3))
                        : forward;
                    const planar = Math.hypot(laserForward[0], laserForward[1]);
                    dx = planar > 1e-3 ? laserForward[0] / planar : 0;
                    dy = planar > 1e-3 ? laserForward[1] / planar : 1;
                    // Facing the camera, the beams point at the viewer and look short.
                    reach = Math.min(1, Math.max(0.15, planar * 2.5));
                } else {
                    const a = eyeAngle + settings.laserAngle * Math.PI / 180;
                    dx = Math.cos(a);
                    dy = Math.sin(a);
                    reach = 1;
                }

                const length = Math.hypot(w, h) * settings.laserLength / 100 * reach;
                const width = eyeDist * settings.laserWidth / 100;
                const flicker = 1 + 0.12 * Math.sin(now / 37) * Math.sin(now / 23);
                const activeEyes = eyes
                    .map(([ex, ey], i) => ({ ex, ey, power: laserEyePower[i] }))
                    .filter(e => e.power > 0.01);
                for (const { ex, ey, power } of activeEyes) {
                    ctx.globalAlpha = power;
                    drawLaserBeam(ex, ey, dx, dy, length * power, width, flicker);
                    spawnFire(ex, ey, dx, dy, length, width, dt, power);
                }
                drawFire(dt);
                for (const { ex, ey, power } of activeEyes) {
                    ctx.globalAlpha = power;
                    drawEyeFlare(ex, ey, width, eyeAngle, flicker);
                }
                ctx.globalAlpha = 1;
            } else {
                drawFire(dt);
            }
            ctx.restore();
        }

        function drawPixelatedFace(w, h, landmarks) {
            ctx.drawImage(video, 0, 0, w, h);
            if (!landmarks) return;
            let minX = 1, minY = 1, maxX = 0, maxY = 0;
            for (const p of landmarks) {
                minX = Math.min(minX, p.x);
                minY = Math.min(minY, p.y);
                maxX = Math.max(maxX, p.x);
                maxY = Math.max(maxY, p.y);
            }
            const pad = settings.pixelPadding / 100;
            const x = Math.max(0, (minX - pad) * w);
            const y = Math.max(0, (minY - pad) * h);
            const rw = Math.min(w, (maxX + pad) * w) - x;
            const rh = Math.min(h, (maxY + pad) * h) - y;
            if (rw <= 0 || rh <= 0) return;
            const smallW = Math.max(1, Math.ceil(rw / settings.pixelSize));
            const smallH = Math.max(1, Math.ceil(rh / settings.pixelSize));
            pixelCanvas.width = smallW;
            pixelCanvas.height = smallH;
            pixelCtx.drawImage(canvas, x, y, rw, rh, 0, 0, smallW, smallH);
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(pixelCanvas, 0, 0, smallW, smallH, x, y, rw, rh);
            ctx.imageSmoothingEnabled = true;
        }

        function drawGreenscreen(w, h) {
            ctx.drawImage(video, 0, 0, w, h);
            if (gsVideo.readyState < 2 || !gsVideo.videoWidth) return;
            const gw = gsVideo.videoWidth;
            const gh = gsVideo.videoHeight;
            const chroma = getFilter('chroma', CHROMA_KEY_SHADER);
            const source = chroma
                ? chroma.render(gsVideo, gw, gh, { u_threshold: (255 - settings.gsTolerance) / 255 })
                : gsVideo;
            const scale = settings.gsSize / 100;
            const dw = gw * scale;
            const dh = gh * scale;
            ctx.save();
            ctx.translate(w / 2 + settings.gsOffsetX, h / 2 + settings.gsOffsetY);
            ctx.rotate(settings.gsRotation * Math.PI / 180);
            ctx.drawImage(source, 0, 0, gw, gh, -dw / 2, -dh / 2, dw, dh);
            ctx.restore();
        }

        function drawFrame(w, h) {
            if (!settings || !settings.effectEnabled) return ctx.drawImage(video, 0, 0, w, h);
            const mode = settings.effectMode;
            if (mode === 'grayscale') return drawGrayscale(w, h);
            if (mode === 'letterbox') return drawLetterbox(w, h);
            if (mode === 'greenscreen') return drawGreenscreen(w, h);
            if (mode === 'ps1' && THREE) {
                if (!ps1) ps1 = new PS1Renderer(video);
                return ps1.render(ctx, w, h);
            }
            if (FACE_MODES.includes(mode) && faceLandmarker) {
                const landmarks = detectFace();
                if (mode === 'lens') return drawLens(w, h, landmarks);
                if (mode === 'pixelate') return drawPixelatedFace(w, h, landmarks);
                if (mode === 'laser_eyes') return drawLaserEyes(w, h, landmarks);
                return drawEyeOverlay(w, h, landmarks);
            }
            // Effect still loading or unknown mode: pass the camera through.
            ctx.drawImage(video, 0, 0, w, h);
        }

        let running = true;

        function processFrame() {
            if (!running) return;
            if (video.readyState >= 2 && video.videoWidth) {
                if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
                    canvas.width = video.videoWidth;
                    canvas.height = video.videoHeight;
                }
                try {
                    drawFrame(canvas.width, canvas.height);
                } catch (e) {
                    console.error('[CameraFX] Frame error', e);
                    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                }
            }
            // requestAnimationFrame is paused in background tabs, which would freeze
            // the outgoing video during a call, so fall back to a timer there.
            if (document.hidden) setTimeout(processFrame, 1000 / 30);
            else requestAnimationFrame(processFrame);
        }
        requestAnimationFrame(processFrame);

        const outputTrack = canvas.captureStream(30).getVideoTracks()[0];
        const stopOutputTrack = outputTrack.stop.bind(outputTrack);

        function cleanup() {
            if (!running) return;
            running = false;
            cameraTracks.forEach(t => t.stop());
            video.srcObject = null;
            Object.values(filters).forEach(f => f && f.dispose());
            if (ps1) ps1.dispose();
        }

        // Stopping the processed track must release the real camera too,
        // otherwise the camera indicator stays on after the call ends.
        outputTrack.stop = function () {
            stopOutputTrack();
            cleanup();
        };
        cameraTracks.forEach(t => t.addEventListener('ended', () => {
            stopOutputTrack();
            cleanup();
            outputTrack.dispatchEvent(new Event('ended'));
        }));

        return new MediaStream([outputTrack, ...stream.getAudioTracks()]);
    }
})();
