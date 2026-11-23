// 3D figure viewer: a stylised person built from Three.js primitives (no model files).
// The figure faces +Z and stands on y = 0 (units ≈ metres). Tapping a mesh selects the part in its
// userData.partId (hair / eye / mouth / ear / skin / body); small parts get invisible, larger hit targets.
import * as THREE from 'three';

const HEAD_Y = 1.62;
const HEAD_R = { x: 0.105, y: 0.12, z: 0.11 };
// camera framing per part: target height, distance, and which way to look from
const VIEWS = {
  full: { ty: 0.92, dist: 3.3, pitch: 0.12 },
  panel: { ty: 1.22, dist: 4.4, pitch: 0.12 }, // nothing selected, bottom sheet open: upper body above the sheet
  body: { ty: 1.08, dist: 4.4, pitch: 0.12 },
  head: { ty: HEAD_Y - 0.01, dist: 1.45, pitch: 0.06 },
  hair: { ty: HEAD_Y + 0.02, dist: 1.5, pitch: 0.45 },
};
const FACE_PARTS = ['eye', 'mouth', 'skin'];

export class HumanViewer {
  constructor(container, { onSelect, colors = {} } = {}) {
    this.container = container;
    this.onSelect = onSelect || (() => {});
    this.parts = new Map(); // partId -> meshes[]
    this.selected = null;
    this.prefAutoRotate = true;
    this.autoRotate = true;
    this.rotateSpeed = 0.8;
    this.accent = new THREE.Color('#4f8cff');

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    this.scene = scene;
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(2.5, 4, 4);
    const rim = new THREE.DirectionalLight(0xa9c4ff, 1.8);
    rim.position.set(-3, 3, -4);
    const fill = new THREE.DirectionalLight(0xffe6d0, 0.6);
    fill.position.set(-4, 1.5, 3);
    scene.add(key, rim, fill, new THREE.HemisphereLight(0xdfe8ff, 0x1a1f28, 1.1));

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 50);
    // orbit state (own controls: drag = rotate, pinch / wheel = zoom)
    this.orbit = { yaw: 0.5, pitch: VIEWS.full.pitch, dist: VIEWS.full.dist, ty: VIEWS.full.ty };
    this._goal = null;

    this.figure = new THREE.Group();
    scene.add(this.figure);
    this.#buildFigure(colors);
    this.#buildFloor();

    this.hlMat = new THREE.MeshBasicMaterial({
      color: this.accent, transparent: true, opacity: 0.35, side: THREE.BackSide,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.halos = [];

    this.raycaster = new THREE.Raycaster();
    this.#bindPointer();

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.clock = new THREE.Clock();
    renderer.setAnimationLoop(() => this.#tick());
  }

  // ---------- model ----------
  #add(parent, partId, geo, mat, { pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1] } = {}) {
    const m = new THREE.Mesh(geo, mat.clone());
    m.userData.matKey = Object.keys(this.mats).find((k) => this.mats[k] === mat);
    m.position.set(...pos);
    m.rotation.set(...rot);
    m.scale.set(...scale);
    if (partId) {
      m.userData.partId = partId;
      if (!this.parts.has(partId)) this.parts.set(partId, []);
      this.parts.get(partId).push(m);
    }
    parent.add(m);
    return m;
  }

  // invisible, larger tap target for a small part (still hit by the raycaster)
  #proxy(parent, partId, r, pos, scale = [1, 1, 1]) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), new THREE.MeshBasicMaterial({ visible: false }));
    m.position.set(...pos);
    m.scale.set(...scale);
    m.userData.partId = partId;
    m.userData.proxy = true;
    parent.add(m);
  }

  #buildFigure(colors) {
    const std = (color, roughness = 0.6, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0, ...extra });
    this.mats = {
      skin: std(colors.skin || '#f0c4a0', 0.55),
      hair: std(colors.hair || '#2a1c15', 0.45, { side: THREE.DoubleSide }),
      shirt: std(colors.shirt || '#4a7fa8', 0.8),
      pants: std('#2a3242', 0.85),
      shoe: std('#e9ecf1', 0.5),
      white: std('#fbfbfb', 0.25),
      iris: std('#3b2a20', 0.2),
      lip: std('#c86d6a', 0.5),
      mouthIn: std('#5a2026', 0.8),
      brow: std(colors.hair || '#2a1c15', 0.7),
    };
    const M = this.mats;
    const F = this.figure;
    const cap = (r, len) => new THREE.CapsuleGeometry(r, len, 8, 20);
    const sph = (seg = 32) => new THREE.SphereGeometry(1, seg, Math.round(seg * 0.75));

    // ---- body (内科・外科・健康診断・リラクゼーション・整骨院) ----
    for (const s of [-1, 1]) {
      this.#add(F, 'body', cap(0.045, 0.11), M.shoe, { pos: [s * 0.1, 0.046, 0.035], rot: [Math.PI / 2, 0, 0] });
      this.#add(F, 'body', cap(0.07, 0.72), M.pants, { pos: [s * 0.1, 0.5, 0] });
      // arms: short sleeve, bare forearm, hand
      this.#add(F, 'body', cap(0.052, 0.22), M.shirt, { pos: [s * 0.252, 1.28, 0], rot: [0, 0, s * 0.13] });
      this.#add(F, 'body', cap(0.042, 0.22), M.skin, { pos: [s * 0.282, 1.0, 0.01], rot: [0.06, 0, s * 0.08] });
      this.#add(F, 'body', sph(16), M.skin, { pos: [s * 0.296, 0.83, 0.015], scale: [0.04, 0.058, 0.03] });
    }
    this.#add(F, 'body', sph(), M.pants, { pos: [0, 0.92, 0], scale: [0.19, 0.1, 0.12] });
    this.torso = this.#add(F, 'body', cap(0.16, 0.36), M.shirt, { pos: [0, 1.18, 0], scale: [1.15, 1, 0.72] });
    this.#add(F, 'body', new THREE.CylinderGeometry(0.047, 0.056, 0.13, 20), M.skin, { pos: [0, 1.5, 0] });

    // ---- head ----
    const head = new THREE.Group();
    head.position.set(0, HEAD_Y, 0);
    F.add(head);
    this.head = head;
    const { x: rx, y: ry, z: rz } = HEAD_R;
    const surfZ = (x, y) => rz * Math.sqrt(Math.max(0, 1 - (x / rx) ** 2 - (y / ry) ** 2));
    // 肌: the face / head surface
    this.#add(head, 'skin', sph(48), M.skin, { scale: [rx, ry, rz] });
    this.#add(head, 'skin', sph(16), M.skin, { pos: [0, -0.018, surfZ(0, -0.018) - 0.006], scale: [0.014, 0.019, 0.016] }); // nose

    // 髪: a cap tilted back over the skull, back volume and a fringe
    this.#add(head, 'hair', new THREE.SphereGeometry(1, 48, 24, 0, Math.PI * 2, 0, Math.PI * 0.5), M.hair,
      { rot: [-0.42, 0, 0], scale: [rx * 1.08, ry * 1.07, rz * 1.1] });
    // second cap tipped further back: covers the back of the head down to the nape (just inside the first one)
    this.#add(head, 'hair', new THREE.SphereGeometry(1, 48, 24, 0, Math.PI * 2, 0, Math.PI * 0.5), M.hair,
      { rot: [-1.2, 0, 0], scale: [rx * 1.065, ry * 1.06, rz * 1.09] });
    this.#add(head, 'hair', sph(), M.hair, { pos: [0.022, 0.074, 0.074], rot: [0.75, 0, 0.3], scale: [0.058, 0.014, 0.03] }); // side-swept fringe

    // 目: sclera, iris, catch light, brows
    for (const s of [-1, 1]) {
      const x = s * 0.038, y = 0.012, z = surfZ(x, y);
      this.#add(head, 'eye', sph(20), M.white, { pos: [x, y, z - 0.006], scale: [0.016, 0.012, 0.008] });
      this.#add(head, 'eye', sph(16), M.iris, { pos: [x, y, z - 0.0005], scale: [0.0085, 0.0085, 0.006] });
      this.#add(head, 'eye', sph(8), M.white, { pos: [x + 0.003, y + 0.003, z + 0.0055], scale: [0.0022, 0.0022, 0.0012] });
      this.#add(head, 'eye', cap(0.0042, 0.024), M.brow, { pos: [x, 0.043, surfZ(x, 0.043) + 0.001], rot: [0, 0, Math.PI / 2 + s * 0.12] });
      this.#proxy(head, 'eye', 0.03, [x, 0.022, z - 0.004], [1, 0.9, 0.6]);
    }

    // 口（歯）: lips, dark inside, a row of teeth
    const my = -0.058, mz = surfZ(0, my);
    this.#add(head, 'mouth', new THREE.TorusGeometry(0.023, 0.0048, 10, 32), M.lip, { pos: [0, my, mz - 0.001], scale: [1, 0.42, 1] });
    this.#add(head, 'mouth', sph(20), M.mouthIn, { pos: [0, my, mz - 0.004], scale: [0.022, 0.0085, 0.004] });
    this.#add(head, 'mouth', new THREE.BoxGeometry(0.03, 0.0055, 0.004), M.white, { pos: [0, my + 0.0035, mz - 0.0005] });
    this.#proxy(head, 'mouth', 0.035, [0, my, mz - 0.006], [1.15, 0.75, 0.6]);

    // 耳
    for (const s of [-1, 1]) {
      this.#add(head, 'ear', sph(20), M.skin, { pos: [s * (rx - 0.003), -0.008, -0.006], rot: [0, s * 0.25, 0], scale: [0.013, 0.032, 0.021] });
      this.#add(head, 'ear', sph(12), M.mouthIn, { pos: [s * (rx + 0.008), -0.012, -0.002], scale: [0.003, 0.012, 0.008] });
      this.#proxy(head, 'ear', 0.04, [s * (rx + 0.008), -0.008, -0.006], [0.8, 1.1, 1]);
    }

    for (const m of this.#meshes()) {
      if (!m.material.emissive) continue;
      m.userData.baseEmissive = m.material.emissive.clone();
    }
  }

  #meshes(id) {
    const list = id ? this.parts.get(id) || [] : [...this.parts.values()].flat();
    return list.filter((m) => !m.userData.proxy);
  }

  #buildFloor() {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    const ctx = cv.getContext('2d');
    const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    g.addColorStop(0, 'rgba(0,0,0,0.55)');
    g.addColorStop(0.35, 'rgba(0,0,0,0.3)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.1, 1.1),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.002;
    this.scene.add(shadow);
    // a faint glowing ring the figure stands on
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.46, 0.475, 96),
      new THREE.MeshBasicMaterial({ color: this.accent, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.003;
    this.scene.add(this.ring);
  }

  setColors({ skin, hair, shirt } = {}) {
    const keys = { skin: [skin], hair: [hair], brow: [hair], shirt: [shirt] };
    for (const m of this.#meshes()) {
      const c = keys[m.userData.matKey]?.[0];
      if (c) m.material.color.set(c);
    }
  }

  // ---------- interaction ----------
  #bindPointer() {
    const el = this.renderer.domElement;
    const pts = new Map();
    let down = null, pinch0 = null, dragging = false;
    const start = () => {
      if (dragging) return;
      dragging = true;
      this.autoRotate = false;
      this._goal = null; // the user takes over from any automatic camera move
      this.onInteract?.();
    };
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture?.(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) down = { x: e.clientX, y: e.clientY, t: performance.now() };
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), dist: this.orbit.dist };
        down = null;
      }
    });
    el.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (pts.size === 2 && pinch0) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        start();
        this.orbit.dist = THREE.MathUtils.clamp(pinch0.dist * (pinch0.d / Math.max(d, 1)), 0.7, 5);
        return;
      }
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6 && !dragging) return;
      start();
      this.orbit.yaw -= dx * 0.009;
      this.orbit.pitch = THREE.MathUtils.clamp(this.orbit.pitch + dy * 0.006, -0.35, 1.1);
    });
    const end = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch0 = null;
      if (pts.size) return;
      const wasDrag = dragging;
      dragging = false;
      if (!down || wasDrag || e.type === 'pointercancel') { down = null; return; }
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const dt = performance.now() - down.t;
      down = null;
      if (moved < 10 && dt < 500) this.#pick(e.clientX, e.clientY);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      start(); dragging = false;
      this.orbit.dist = THREE.MathUtils.clamp(this.orbit.dist * (1 + e.deltaY * 0.0012), 0.7, 5);
    }, { passive: false });
  }

  #pick(cx, cy) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.figure.children, true).find((h) => h.object.userData.partId);
    const id = hit?.object.userData.partId || null;
    this.select(id);
    this.onSelect(id);
  }

  /** Highlight a part (or nothing) and turn the camera towards it. */
  select(id, { focus = true } = {}) {
    this.selected = id;
    for (const h of this.halos) h.removeFromParent();
    this.halos = [];
    for (const m of this.#meshes()) {
      m.material.emissive?.copy(m.userData.baseEmissive);
      m.material.emissiveIntensity = 1;
    }
    if (id) {
      this.autoRotate = false;
      for (const m of this.#meshes(id)) {
        m.material.emissive.copy(this.accent);
        // a slightly larger back-face shell around the mesh reads as a soft glowing outline
        const halo = new THREE.Mesh(m.geometry, this.hlMat);
        halo.scale.setScalar(id === 'body' ? 1.06 : 1.14);
        halo.raycast = () => {};
        m.add(halo);
        this.halos.push(halo);
      }
    } else {
      this.autoRotate = this.prefAutoRotate;
    }
    if (focus) this.focusOn(id);
  }

  focusOn(id) {
    const o = this.orbit;
    const near = (target) => o.yaw + Math.atan2(Math.sin(target - o.yaw), Math.cos(target - o.yaw)); // shortest way round
    let v = this._insetTarget > 0 ? VIEWS.panel : VIEWS.full, yaw = null;
    if (id === 'body') v = VIEWS.body;
    if (id === 'hair') { v = VIEWS.hair; yaw = near(0.35); }
    else if (FACE_PARTS.includes(id)) { v = VIEWS.head; yaw = near(id === 'skin' ? 0.3 : 0); }
    else if (id === 'ear') { v = VIEWS.head; yaw = near(Math.sin(o.yaw) >= 0 ? Math.PI / 2 : -Math.PI / 2); }
    this._goal = { ...v, yaw: yaw ?? o.yaw };
  }

  setAccent(color) {
    this.accent.set(color);
    this.hlMat.color.set(color);
    this.ring.material.color.set(color);
    if (this.selected) this.select(this.selected, { focus: false });
  }

  /** Appearance settings from the 設定 tab. */
  setPrefs({ brightness = 1, autoRotate = true, rotateSpeed = 0.8 } = {}) {
    this.renderer.domElement.style.filter = Math.abs(brightness - 1) > 0.01 ? `brightness(${brightness})` : '';
    this.rotateSpeed = rotateSpeed;
    if (this.prefAutoRotate !== autoRotate) this.autoRotate = autoRotate && !this.selected;
    this.prefAutoRotate = autoRotate;
  }

  // Shift the rendered image up so the figure stays visible above the bottom sheet.
  setBottomInset(px) {
    const was = this._insetTarget > 0;
    this._insetTarget = px;
    if (!this.selected && was !== px > 0) this.focusOn(null); // pull back so the figure fits above the sheet
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px';
    this.renderer.domElement.style.height = h + 'px';
    this.camera.aspect = w / h;
    // wide (landscape) screens: keep the lens; narrow ones are already tall enough for a standing figure
    this.camera.fov = THREE.MathUtils.clamp(38 / Math.min(1, Math.max(this.camera.aspect, 0.5) * 1.6), 38, 50);
    this.camera.updateProjectionMatrix();
  }

  #tick() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const t = this.clock.elapsedTime;
    const o = this.orbit;
    if (this._goal) {
      const g = this._goal, k = 1 - Math.pow(0.0015, dt); // ~ smooth ease, frame-rate independent
      for (const key of ['yaw', 'pitch', 'dist', 'ty']) o[key] += (g[key] - o[key]) * k;
      if (['yaw', 'pitch', 'dist', 'ty'].every((key) => Math.abs(g[key] - o[key]) < 0.002)) this._goal = null;
    } else if (this.autoRotate) {
      o.yaw += this.rotateSpeed * 0.105 * dt;
    }
    // breathing
    this.torso.scale.set(1.15 * (1 + Math.sin(t * 1.7) * 0.008), 1, 0.72 * (1 + Math.sin(t * 1.7) * 0.015));
    const pulse = 0.5 - 0.5 * Math.cos(t * 2.6);
    this.hlMat.opacity = 0.12 + 0.4 * pulse;
    if (this.selected) for (const m of this.#meshes(this.selected)) m.material.emissiveIntensity = 0.08 + 0.45 * pulse;
    this.ring.material.opacity = 0.22 + 0.12 * Math.sin(t * 1.3);

    const cp = Math.cos(o.pitch);
    this.camera.position.set(Math.sin(o.yaw) * cp * o.dist, o.ty + Math.sin(o.pitch) * o.dist, Math.cos(o.yaw) * cp * o.dist);
    this.camera.lookAt(0, o.ty, 0);
    const tgt = this._insetTarget || 0;
    this._inset = (this._inset || 0) + (tgt - (this._inset || 0)) * 0.15;
    if (Math.abs(this._inset - tgt) < 0.5) this._inset = tgt;
    if (this._inset > 0) {
      const pr = this.renderer.getPixelRatio();
      const { width: w, height: h } = this.renderer.domElement;
      this.camera.setViewOffset(w / pr, h / pr, 0, this._inset * 0.5, w / pr, h / pr);
    } else if (this.camera.view) this.camera.clearViewOffset();
    this.renderer.render(this.scene, this.camera);
  }
}
