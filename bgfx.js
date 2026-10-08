/* Nova background — CINEMATIC WebGL BLACK HOLE (GLSL, zero dependencies).
   Matches the reference: pitch-black event horizon top-center, electric
   blue/cyan accretion halo wrapping the top arch, silky swirling filaments
   pulled around the disk, doppler-boosted approaching side, starfield,
   pure-black floor. One fullscreen fragment shader = one draw call (fast).
   Motion states: NovaFX.state("idle|listening|processing|speaking").
   No Three.js needed — raw WebGL1 keeps the app fully offline-capable. */
(function () {
  const canvas = document.getElementById("bgfx-canvas");
  if (!canvas) return;
  const gl = canvas.getContext("webgl", { antialias: false, alpha: false, powerPreference: "high-performance" });
  if (!gl) return; // CSS gradient layers remain as fallback

  const cssBg = document.querySelector(".bgfx");
  if (cssBg) cssBg.style.display = "none";

  const MOBILE = Math.min(window.innerWidth, window.innerHeight) < 640 ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  /* ═══════ PERFORMANCE MODES — each one changes real behavior ═══════
     scale: internal render resolution (the shader is smooth; CSS upscales
     it — you cannot see the difference, the GPU surely can).
     fps: frame cap (the animation is slow swirling — 30fps is visually
     identical when idle; full 60 only while Nova is actually busy).
     Stored in localStorage('nova.perfMode') — set from Settings → Performance. */
  const PERF = {
    balanced: { scale: 0.75, fpsIdle: 30, fpsActive: 60 },
    fast:     { scale: 0.55, fpsIdle: 30, fpsActive: 45 },
    battery:  { scale: 0.45, fpsIdle: 20, fpsActive: 30 },
  };
  let perfMode = PERF.balanced;
  try {
    const saved = localStorage.getItem("nova.perfMode");
    if (saved && PERF[saved]) perfMode = PERF[saved];
  } catch { /* storage blocked → default */ }

  const VERT = `
    attribute vec2 a_pos;
    void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }
  `;

  const FRAG = `
    precision highp float;
    uniform vec2  u_res;
    uniform float u_time;    // seconds
    uniform float u_spin;    // spin multiplier (processing = fast)
    uniform float u_glow;    // brightness multiplier
    uniform float u_level;   // live mic level 0..1 (listening)
    uniform float u_ripR[2]; // ripple radii
    uniform float u_ripA[2]; // ripple alphas
    uniform float u_pulse;   // processing pulse ring radius (0 = off)
    uniform float u_warm;    // 0 = cyan, 1 = amber (processing)

    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
    float noise(vec2 p){
      vec2 i = floor(p), f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                 mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
    }
    float fbm(vec2 p){
      float v = 0.0, a = 0.5;
      for(int i = 0; i < 4; i++){ v += a * noise(p); p *= 2.03; a *= 0.5; }
      return v;
    }
    /* star position inside a grid cell (used by starfield + constellation links) */
    vec2 sPos(vec2 c){ return c + vec2(hash(c), hash(c + 3.17)); }

    void main(){
      vec2 uv = gl_FragCoord.xy / u_res;          // y up
      vec2 p  = vec2(uv.x, 1.0 - uv.y);           // y down (top = 0)

      vec2 c  = vec2(0.485, 0.16);                // vortex center (top-center)
      vec2 d  = p - c;
      float squash = 0.40;                        // tilted-disk perspective
      vec2 q  = vec2(d.x, d.y / squash);
      float r = length(q);
      float ang = atan(q.y, q.x);

      float R0 = 0.205 * min(u_res.x / u_res.y * 1.5, 1.35) * (u_res.y / u_res.x) * (u_res.x / u_res.y); // placeholder, set below
      R0 = 0.16;                                  // photon-ring radius (scene units)
      float R1 = 0.62;                            // outer sweep

      /* ---------- starfield (deep space, avoids the vortex) ---------- */
      vec2 sp = uv * vec2(u_res.x / u_res.y, 1.0) * 42.0;
      vec2 cell = floor(sp);
      float star = hash(cell);
      float tw = 0.55 + 0.45 * sin(u_time * (1.0 + star * 3.0) + star * 40.0);
      float sdf = length(sp - sPos(cell));
      float starM = smoothstep(0.16, 0.0, sdf) * step(0.955, star) * tw;
      starM *= smoothstep(0.10, 0.26, r) + smoothstep(0.34, 0.62, p.y); // fade near vortex
      vec3 col = vec3(0.85, 0.92, 1.0) * starM * 0.85;
      // a few warm pink stars
      float pink = step(0.985, hash(cell + 7.3));
      col += vec3(1.0, 0.55, 0.75) * starM * pink * 0.8;

      /* ---------- neural constellation: faint violet links between stars ---------- */
      vec3 links = vec3(0.0);
      for(int k = 0; k < 2; k++){
        vec2 off  = (k == 0) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
        vec2 cA = cell;
        vec2 cB = cell + off;
        float sA = step(0.955, hash(cA));
        float sB = step(0.955, hash(cB));
        vec2 pA = sPos(cA);
        vec2 pB = sPos(cB);
        vec2 pa = sp - pA;
        vec2 ba = pB - pA;
        float hh = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
        float seg = length(pa - ba * hh);
        float sh = 0.55 + 0.45 * sin(u_time * 0.6 + hash(cA) * 31.0);
        links += vec3(0.60, 0.48, 1.0) * smoothstep(0.06, 0.0, seg) * sA * sB * sh;
      }
      links *= (smoothstep(0.10, 0.26, r) + smoothstep(0.34, 0.62, p.y)) * (0.30 + u_level * 0.55);
      col += links;

      /* ---------- accretion disk: silky swirling filaments ---------- */
      float spin = u_time * 0.22 * u_spin;
      // logarithmic spiral coords: filaments stretch along the orbit
      float sw = ang * 3.0 - log(max(r, 0.02)) * 7.0 - spin * (2.2 / (0.25 + r));
      float fil = fbm(vec2(sw * 1.6, r * 9.0 - spin * 0.55));
      float fil2 = fbm(vec2(sw * 3.1 + 4.7, r * 14.0 + spin * 0.35));
      float disk = 0.0;
      float inDisk = smoothstep(R0 * 0.96, R0 * 1.05, r) * smoothstep(R1, R0 * 1.6, r);
      // radial brightness: hottest at the inner edge
      float radial = exp(-(r - R0) * 4.4) * 1.15 + 0.22 * exp(-(r - R0) * 1.1);
      float silk = pow(fil, 1.7) * 1.25 + pow(fil2, 2.2) * 0.75;
      disk = inDisk * radial * silk;
      // doppler beaming: the approaching (lower) side burns brighter
      float dop = 0.45 + 0.85 * pow(max(sin(ang), 0.0), 1.6);
      disk *= dop;
      // inner edge is white-hot, outer fades to deep blue
      vec3 cHot  = vec3(0.62, 0.95, 1.0);
      vec3 cMid  = vec3(0.05, 0.45, 1.0);
      vec3 cOut  = vec3(0.02, 0.10, 0.36);
      vec3 diskCol = mix(cHot, cMid, smoothstep(R0, R0 * 1.9, r));
      diskCol = mix(diskCol, cOut, smoothstep(R0 * 1.8, R1, r));
      col += diskCol * disk * 1.5 * u_glow;

      /* ---------- gravitationally-lensed halo (the top arch) ---------- */
      // near-circular ring bent over the top of the shadow
      vec2 hd = p - (c - vec2(0.0, 0.012));
      float hr = length(hd * vec2(1.0, 1.9));
      float arch = exp(-abs(hr - R0 * 1.52) * 16.0);
      arch *= smoothstep(c.y + 0.02, c.y - 0.06, p.y);       // above center only
      float arch2 = exp(-abs(hr - R0 * 1.60) * 34.0);
      arch2 *= smoothstep(c.y + 0.02, c.y - 0.06, p.y);
      col += (vec3(0.35, 0.85, 1.0) * arch * 0.55 + vec3(0.85, 0.98, 1.0) * arch2 * 0.65) * u_glow;
      // violet aura accent wrapped into the halo
      col += vec3(0.50, 0.34, 0.98) * arch * 0.10 * u_glow;
      // faint mirrored arc under the shadow (lensed bottom)
      float under = exp(-abs(hr - R0 * 1.52) * 20.0) * smoothstep(c.y - 0.01, c.y + 0.05, p.y);
      col += vec3(0.20, 0.55, 0.95) * under * 0.28 * u_glow;

      /* ---------- photon ring: razor-thin white-cyan circle ---------- */
      float ring = exp(-abs(r - R0) * 90.0);
      float ringGlow = exp(-abs(r - R0) * 14.0) * 0.35;
      vec3 ringCol = mix(vec3(0.55, 0.95, 1.0), vec3(1.0, 0.72, 0.35), u_warm);
      col += ringCol * (ring * 1.6 + ringGlow) * dop * u_glow;
      // wide soft violet bloom breathing around the photon ring
      col += vec3(0.44, 0.30, 0.95) * exp(-abs(r - R0) * 5.5) * 0.09 * u_glow;

      /* ---------- event horizon: pitch black, soft lensed edge ---------- */
      float hole = smoothstep(R0 * 1.005, R0 * 0.94, r);
      col *= 1.0 - hole * 0.985;
      // faint blue rim light just outside the shadow
      col += vec3(0.10, 0.30, 0.55) * exp(-abs(r - R0) * 26.0) * (1.0 - hole) * 0.35 * u_glow;

      /* ---------- voice ripples (listening / speaking) ---------- */
      for(int i = 0; i < 2; i++){
        float rr = u_ripR[i];
        float ra = u_ripA[i];
        if(ra > 0.01){
          float rip = exp(-abs(r - rr) * 34.0) * ra;
          col += vec3(0.0, 0.85, 1.0) * rip * (1.0 - hole);
        }
      }
      /* ---------- processing energy pulse (amber) ---------- */
      if(u_pulse > 0.0){
        float pu = exp(-abs(r - u_pulse) * 30.0) * (1.0 - hole);
        col += mix(vec3(0.0, 0.9, 1.0), vec3(1.0, 0.62, 0.12), 0.65) * pu * 0.5;
      }

      /* ---------- listening: gentle breathing brightness ---------- */
      col *= 1.0 + u_level * 0.35 * smoothstep(R0 * 0.8, R1, r);

      /* ---------- radiation tendrils: slow violet wisps drifting outward ---------- */
      vec2 cdir = vec2(cos(ang), sin(ang));
      float tend = fbm(cdir * 1.7 + vec2(u_time * 0.030, -u_time * 0.021) + r * 2.6);
      tend = pow(tend, 3.0);
      tend *= smoothstep(R0 * 1.15, R1 * 0.85, r) * smoothstep(0.95, 0.25, p.y);
      col += vec3(0.36, 0.30, 0.88) * tend * 0.38 * u_glow;

      /* ---------- atmosphere + floor fade ---------- */
      float lift = exp(-r * 2.0) * 0.16;
      col += vec3(0.02, 0.07, 0.16) * lift;
      col *= smoothstep(1.05, 0.42, p.y);                    // sink to black below
      col *= 0.94 + 0.06 * uv.y;                              // subtle top ambient

      /* ---------- filmic tonemap ---------- */
      col = 1.0 - exp(-col * 1.35);
      col = pow(col, vec3(0.92));

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn("[bgfx] shader:", gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  }

  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn("[bgfx] link:", gl.getProgramInfoLog(prog));
    return;
  }
  gl.useProgram(prog);

  // fullscreen triangle
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "a_pos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const U = {};
  ["u_res", "u_time", "u_spin", "u_glow", "u_level", "u_ripR", "u_ripA", "u_pulse", "u_warm"]
    .forEach((n) => { U[n] = gl.getUniformLocation(prog, n); });

  function resize() {
    const d = perfMode.scale * (MOBILE ? 1.0 : Math.min(window.devicePixelRatio || 1, 1.3));
    canvas.width = Math.max(2, Math.floor(window.innerWidth * d));
    canvas.height = Math.max(2, Math.floor(window.innerHeight * d));
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  resize();
  window.addEventListener("resize", resize);

  /* ---------------- state engine (JARVIS HUD) ---------------- */
  let state = "idle";
  let level = 0;
  let glow = 1, glowT = 1;
  let spinM = 1, spinT = 1;
  let warm = 0, warmT = 0;
  const rips = [ { r: 0, a: 0, v: 0 }, { r: 0, a: 0, v: 0 } ];
  let ripIdx = 0;
  let pulse = 0, pulseV = 0, pulseTimer = 0;

  const NovaFX = {
    state(name) {
      // Extended REAL states: error/waiting map onto the shader's actual
      // controls (warm tint, glow, spin) — never fake motion.
      if (name === "error" || name === "waiting" || name === "executing") {
        state = name;
        glowT = name === "error" ? 1.05 : name === "executing" ? 1.6 : 1.15;
        spinT = name === "executing" ? 2.6 : name === "error" ? 0.5 : 0.8;
        warmT = name === "error" ? 0.95 : name === "waiting" ? 0.35 : 0.85;
        return;
      }
      state = (name === "listening" || name === "processing" || name === "speaking") ? name : "idle";
      glowT = state === "processing" ? 1.5 : state === "listening" ? 1.25 : state === "speaking" ? 1.35 : 1;
      spinT = state === "processing" ? 2.4 : 1;
      warmT = state === "processing" ? 0.8 : 0;
    },
    level(v) { level = Math.max(0, Math.min(1, Number(v) || 0)); },
    burst() {
      // celebration: quick double ripple + brightness kick
      const rp = rips[ripIdx % 2]; ripIdx++;
      rp.r = 0.16; rp.a = 0.5; rp.v = 0.30;
      glowT = Math.max(glowT, 1.5);
    },
    pulse() { glowT = Math.max(glowT, 1.5); },
    current() { return state; },
    setPerf(mode) {
      if (!PERF[mode]) return false;
      perfMode = PERF[mode];
      resize();          // apply the new render scale immediately
      return true;
    },
  };
  window.NovaFX = NovaFX;

  let running = true, last = performance.now(), t0 = last;
  let lastDraw = 0;                       // frame-cap clock
  document.addEventListener("visibilitychange", () => {
    running = !document.hidden;
    if (running) { last = performance.now(); requestAnimationFrame(frame); }
  });

  function frame(now) {
    if (!running) return;
    const t = (now - t0) / 1000;
    const dt = Math.min(now - last, 50);
    last = now;

    // Frame cap: idle scenes are slow swirling — 30fps is visually identical
    // and halves the GPU work. Full rate only when Nova is actually busy.
    const active = state !== "idle" || pulse > 0 || rips[0].a > 0.01 || rips[1].a > 0.01 || Math.abs(glowT - 1) > 0.03;
    const frameMin = 1000 / (active ? perfMode.fpsActive : perfMode.fpsIdle);
    if (now - lastDraw < frameMin) { requestAnimationFrame(frame); return; }
    lastDraw = now;

    glow += (glowT - glow) * 0.06;
    glowT += (1 - glowT) * 0.012;
    const sustained = state === "processing" || state === "executing" || state === "error" || state === "waiting";
    spinM += (spinT - spinM) * 0.05;
    if (!sustained) spinT = 1;
    warm += (warmT - warm) * 0.06;
    if (!sustained) warmT = 0;

    // ripples expand + fade
    for (const rp of rips) {
      if (rp.a > 0.005) { rp.r += rp.v * dt * 0.06 * (0.5 + spinM * 0.5); rp.a -= 0.00045 * dt; }
      else rp.a = 0;
    }
    // listening: spawn ripples from mic level
    if (state === "listening" && level > 0.06) {
      const rp = rips[ripIdx % 2];
      if (rp.a < 0.08 && Math.random() < level * 0.5) {
        ripIdx++;
        rips[ripIdx % 2] = { r: 0.165, a: 0.22 + level * 0.2, v: 0.16 + level * 0.2 };
      }
      NovaFX.state("listening");
      glowT = 1.15 + level * 0.5;
    }
    // speaking: rhythmic soft ripples
    if (state === "speaking" && Math.random() < 0.05) {
      ripIdx++;
      rips[ripIdx % 2] = { r: 0.165, a: 0.16 + Math.random() * 0.1, v: 0.13 };
    }
    // processing: expanding amber pulses
    if (state === "processing") {
      pulseTimer -= dt;
      if (pulseTimer <= 0 && pulse <= 0) { pulse = 0.03; pulseV = 0.00035; pulseTimer = 500; }
    }
    if (pulse > 0) { pulse += pulseV * dt; if (pulse > 0.7) pulse = 0; }

    gl.uniform2f(U.u_res, canvas.width, canvas.height);
    gl.uniform1f(U.u_time, t);
    gl.uniform1f(U.u_spin, spinM);
    gl.uniform1f(U.u_glow, glow);
    gl.uniform1f(U.u_level, level);
    gl.uniform1fv(U.u_ripR, new Float32Array([rips[0].r, rips[1].r]));
    gl.uniform1fv(U.u_ripA, new Float32Array([rips[0].a, rips[1].a]));
    gl.uniform1f(U.u_pulse, pulse);
    gl.uniform1f(U.u_warm, warm);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
