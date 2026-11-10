import { WORLD_RADIUS } from '../world/worldConfig';
import * as THREE from 'three';
import { GERSTNER_GLSL, WaveField } from './waves';
import { PALETTE } from '../render/palette';
import { ShoreField, SHORE_TEX_MIN, SHORE_TEX_RANGE } from './shore';

/**
 * Stylized toon ocean.
 *
 * Vertex: Gerstner displacement (shared with CPU physics), faded out at the
 * horizon so distant tessellation doesn't alias.
 * Fragment: hard-banded colour ramp by wave height + lighting, crest foam,
 * hand-drawn-looking foam streaks, fresnel and fog. Near land (from the shore
 * map) the water turns shallow turquoise and foam lines lap at the beach.
 */
/** Most sea creatures the ocean shader can draw at once. */
export const MAX_LURKERS = 4;

export function createOceanMaterial(waves: WaveField, sunDir: THREE.Vector3, shore: ShoreField | null): THREE.ShaderMaterial {
  // Terrain height map as an 8-bit texture; a single deep texel if there is no land.
  const size = shore?.size ?? 1;
  const shoreTex = new THREE.DataTexture(shore ? shore.toBytes() : new Uint8Array([0]), size, size, THREE.RedFormat, THREE.UnsignedByteType);
  shoreTex.magFilter = shoreTex.minFilter = THREE.LinearFilter;
  shoreTex.wrapS = shoreTex.wrapT = THREE.ClampToEdgeWrapping;
  shoreTex.needsUpdate = true;
  return new THREE.ShaderMaterial({
    uniforms: {
      ...waves.uniforms,
      uCenter: { value: new THREE.Vector2() },
      uFade: { value: new THREE.Vector2(260, 900) },
      uMaxAmp: { value: 1 },
      uSunDir: { value: sunDir },
      uDeep: { value: new THREE.Color(PALETTE.oceanDeep) },
      uMid: { value: new THREE.Color(PALETTE.oceanMid) },
      uShallow: { value: new THREE.Color(PALETTE.oceanCrest) },
      uFoam: { value: new THREE.Color(PALETTE.foam) },
      uShoreWater: { value: new THREE.Color(PALETTE.shoreWater) },
      uShoreMap: { value: shoreTex },
      uShoreExtent: { value: shore?.extent ?? 1 },
      uHorizon: { value: new THREE.Color(PALETTE.horizon) },
      uFogRange: { value: new THREE.Vector2(250, 1400) },
      uFoamAmount: { value: 1 },
      // The sea stops here and falls off the edge of the world (src/world/WorldEdge.ts)
      uWorldRadius: { value: WORLD_RADIUS },
      // Day-night + weather (see src/weather): light multiplier, tint toward a colour (red tide)
      uLight: { value: new THREE.Color(1, 1, 1) },
      uTint: { value: new THREE.Color(0x8a1010) },
      uTintAmount: { value: 0 },
      uFlash: { value: 0 },
      // Sea creatures under the surface: xz, heading (cos, sin) / strength, eye open, scale, glow
      uLurkA: { value: Array.from({ length: MAX_LURKERS }, () => new THREE.Vector4()) },
      uLurkB: { value: Array.from({ length: MAX_LURKERS }, () => new THREE.Vector4()) },
      uLurkCount: { value: 0 },
    },
    vertexShader: /* glsl */ `
      ${GERSTNER_GLSL}
      uniform vec2 uCenter;
      uniform vec2 uFade;

      varying vec3 vWorldPos;
      varying vec3 vNormal;
      varying float vHeight;
      varying vec2 vGrid;
      varying float vFade;
      varying float vEnv;

      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        float dist = distance(world.xz, uCenter);
        float fade = 1.0 - smoothstep(uFade.x, uFade.y, dist);
        // calm the sea in shallow water so waves lap at beaches instead of cutting through them
        float shore = shoreScale(terrainHeight(world.xz));
        float scale = fade * shore;
        vec3 n;
        float env;
        vec3 d = gerstner(world.xz, scale, n, env);
        // a tsunami is seen from afar: it does not fade with distance like the ordinary sea
        d += swell(world.xz, shore, n, env);
        vEnv = env;
        world.xyz += d;
        vWorldPos = world.xyz;
        vNormal = n;
        vHeight = d.y;
        vGrid = world.xz - d.xz;
        vFade = fade;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uMaxAmp;
      uniform vec3 uSunDir;
      uniform vec3 uDeep;
      uniform vec3 uMid;
      uniform vec3 uShallow;
      uniform vec3 uFoam;
      uniform vec3 uShoreWater;
      uniform sampler2D uShoreMap;
      uniform float uShoreExtent;
      uniform vec3 uHorizon;
      uniform vec2 uFogRange;
      uniform float uFoamAmount;
      uniform float uWorldRadius;
      uniform vec3 uLight;
      uniform vec3 uTint;
      uniform float uTintAmount;
      uniform float uFlash;
      uniform vec4 uLurkA[${MAX_LURKERS}];
      uniform vec4 uLurkB[${MAX_LURKERS}];
      uniform int uLurkCount;

      varying vec3 vWorldPos;
      varying vec3 vNormal;
      varying float vHeight;
      varying vec2 vGrid;
      varying float vFade;
      varying float vEnv;

      // --- value noise ---------------------------------------------------
      float hash(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }
      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
                   mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
      }
      float fbm(vec2 p) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 4; i++) {
          v += a * noise(p);
          p = p * 2.03 + 17.1;
          a *= 0.5;
        }
        return v;
      }
      // crisp but anti-aliased step
      float aastep(float edge, float x) {
        float w = max(fwidth(x), 1e-4) * 0.75;
        return smoothstep(edge - w, edge + w, x);
      }

      void main() {
        // the edge of the world: no sea beyond the rim
        float rim = uWorldRadius - length(vWorldPos.xz);
        if (rim < 0.0) discard;
        vec3 N = normalize(vNormal);
        vec3 V = normalize(cameraPosition - vWorldPos);
        vec3 L = normalize(uSunDir);
        float dist = length(cameraPosition - vWorldPos);

        // Height 0..1 across the current sea state.
        float h = clamp(vHeight / max(uMaxAmp, 0.01) * 0.5 + 0.5, 0.0, 1.0);

        // Lighting, quantized into two bands.
        float ndl = dot(N, L) * 0.5 + 0.5;
        float light = mix(0.78, 1.0, aastep(0.62, ndl));

        // Banded colour ramp: deep troughs -> mid -> bright crests.
        float bandNoise = (fbm(vGrid * 0.05 + uTime * 0.03) - 0.5) * 0.18;
        vec3 col = uDeep;
        col = mix(col, uMid, aastep(0.38 + bandNoise, h));
        col = mix(col, uShallow, aastep(0.72 + bandNoise, h) * 0.85);
        col *= light;

        // Foam streaks: wavy white lines drifting with the water, like the
        // brush strokes in the reference art. Denser on crests.
        // the drift turns from one stretch of sea to the next and the lines are
        // domain-warped, so they never line up into one direction of travel
        float driftA = fbm(vGrid * 0.004 + 3.7) * 12.0;
        vec2 drift = vec2(cos(driftA), sin(driftA)) * uTime * 0.05;
        vec2 fp = vGrid * 0.11 + drift;
        fp += (vec2(fbm(vGrid * 0.02 + 1.3 + uTime * 0.01), fbm(vGrid * 0.02 + 7.1 - uTime * 0.012)) - 0.5) * 3.0;
        float n1 = fbm(fp);
        float line = 1.0 - aastep(0.03, abs(fract(n1 * 5.0) - 0.5));
        // Wave groups: vEnv > 1 inside a big set, < 1 in the lulls between.
        float inSet = smoothstep(0.95, 1.2, vEnv);
        float mask = aastep(0.58, fbm(vGrid * 0.03 - uTime * 0.02)) * aastep(0.45, h);
        float streaks = line * mask * vFade * uFoamAmount * (0.35 + 0.65 * inSet);

        // Crest caps: only the tallest crests of a big set break, and a
        // large-scale noise leaves whole patches of sea clean.
        float capNoise = fbm(vGrid * 0.35 + uTime * 0.25);
        float cleanPatch = aastep(0.5, fbm(vGrid * 0.011 + vec2(uTime * 0.01, -uTime * 0.006)));
        float caps = aastep(0.93 - capNoise * 0.12, h) * inSet * cleanPatch * uFoamAmount;

        float foam = max(streaks * 0.9, caps);
        // fade foam detail out in the distance to avoid shimmer
        foam *= 1.0 - smoothstep(180.0, 450.0, dist);
        col = mix(col, uFoam, foam);

        // Shoreline, from the terrain map: depth > 0 is water over sand.
        float depth = -(texture2D(uShoreMap, vWorldPos.xz / uShoreExtent + 0.5).r * ${SHORE_TEX_RANGE.toFixed(1)} + ${SHORE_TEX_MIN.toFixed(1)});
        float shallow = 1.0 - smoothstep(0.3, 6.5, depth);
        col = mix(col, uShoreWater * light, shallow * 0.8);
        // foam lines that follow the depth contours and creep up the beach
        float sn = fbm(vWorldPos.xz * 0.16 + vec2(uTime * 0.04, -uTime * 0.03));
        float lap = fract(depth * 0.55 + sn * 1.6 + uTime * 0.16);
        float lapLine = aastep(0.8, lap) * (1.0 - smoothstep(0.5, 3.6, depth)) * aastep(0.35, sn + shallow * 0.35);
        // solid foam where the water meets the sand, with a ragged edge
        float swash = 1.0 - aastep(0.22 + sn * 0.5 + 0.12 * sin(uTime * 0.9 + sn * 9.0), depth);
        col = mix(col, uFoam, max(lapLine * 0.85, swash));

        // Red tide: pull the water toward a blood-red version of itself.
        float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = mix(col, uTint * (0.55 + lum * 1.6), uTintAmount);

        // Something huge under the surface: a dark shape with glowing eyes.
        vec3 eyes = vec3(0.0);
        for (int i = 0; i < ${MAX_LURKERS}; i++) {
          if (i >= uLurkCount) break;
          vec4 la = uLurkA[i];
          vec4 lb = uLurkB[i];
          vec2 rel = vWorldPos.xz - la.xy;
          float sc = lb.z;
          vec2 q = vec2(dot(rel, vec2(-la.w, la.z)), dot(rel, la.zw)) / sc; // x = right, y = forward
          float wob = fbm(q * 0.25 + uTime * 0.15) - 0.5;
          float body = length(vec2(q.x / 5.0, (q.y + 2.0) / 8.0)) + wob * 0.35;
          col *= 1.0 - 0.7 * lb.x * (1.0 - smoothstep(0.55, 1.05, body));
          for (int s = -1; s <= 1; s += 2) {
            vec2 e = q - vec2(float(s) * 1.7, 3.4);
            vec2 er = e / vec2(1.05, 0.62 * max(lb.y, 0.05));
            float r = length(er);
            float core = 1.0 - smoothstep(0.8, 1.0, r);
            float slit = smoothstep(0.12, 0.24, abs(e.x));
            float halo = exp(-dot(e, e) * 0.45) * lb.w;
            vec3 eyeCol = mix(vec3(1.0, 0.55, 0.08), vec3(1.0, 0.92, 0.35), 1.0 - r);
            eyes += lb.x * (eyeCol * core * mix(0.15, 1.0, slit) * lb.y * 1.3 + vec3(0.55, 0.9, 0.3) * halo * 0.35);
          }
        }

        col *= uLight;
        col += eyes;
        col += vec3(0.6, 0.65, 0.8) * uFlash * 0.5;

        // Fresnel toward the sky at grazing angles.
        float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
        col = mix(col, uHorizon, fres * 0.45);

        // white water where the sea gathers speed toward the rim
        col = mix(col, uFoam * uLight, (1.0 - smoothstep(0.0, 14.0, rim)) * 0.85);

        // Fog into the horizon colour.
        // linear like the scene fog, so the sea and islands fade together in thick weather
        float fog = clamp((dist - uFogRange.x) / max(uFogRange.y - uFogRange.x, 1.0), 0.0, 1.0);
        fog = fog * fog * (3.0 - 2.0 * fog) * 0.35 + fog * 0.65;
        col = mix(col, uHorizon, fog);

        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
}
