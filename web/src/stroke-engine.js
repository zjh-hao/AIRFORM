import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Group, Mesh, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { createShape3DMesh, regularizeStroke, recognizeShape3D } from './shape-3d.js';

const SIDES = 12, SEGMENTS = 128, CAP_VERTICES = 2 * (SIDES + 1);
const angles = Array.from({ length: SIDES }, (_, i) => [Math.cos(i * 2 * Math.PI / SIDES), Math.sin(i * 2 * Math.PI / SIDES)]);

function pointValue(point) {
  if (!point || !['x', 'y', 'z'].every(k => typeof point[k] === 'number' && Number.isFinite(point[k]))) throw new TypeError('Expected finite x, y, z');
  if (['x', 'y', 'z'].some(k => Math.abs(point[k]) > 10000)) throw new RangeError('Coordinates must be within ±10000 scene units');
  return new Vector3(point.x, point.y, point.z);
}

function styleValue({ color = '#35bfff', size = 3, mineral=false, shape3d=false, smartDraw=false } = {}) {
  if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) throw new TypeError('Expected #RRGGBB color');
  if (!Number.isFinite(size) || size < .1 || size > 100) throw new RangeError('Size must be between 0.1 and 100');
  return { color, size, mineral, shape3d: Boolean(shape3d), smartDraw: Boolean(smartDraw) };
}

function brushMaterial(style) {
  const material=new MeshStandardMaterial({color:style.color,roughness:style.mineral ? .32 : .45});
  if(style.mineral) {
    material.emissive.set(style.color);
    material.emissiveIntensity=.95;
    material.onBeforeCompile=shader=>{
      shader.vertexShader='varying float brushTint;\n'+shader.vertexShader.replace('#include <begin_vertex>',
        '#include <begin_vertex>\nbrushTint = 0.5 + 0.5 * sin(dot(position, vec3(1.4, 1.1, 0.9)));');
      shader.fragmentShader='varying float brushTint;\n'+shader.fragmentShader.replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\nfloat rim = pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 2.0);\n'+
        'totalEmissiveRadiance = mix(totalEmissiveRadiance, totalEmissiveRadiance.gbr, 0.18 * brushTint) * (0.85 + 1.15 * rim);');
    };
  }
  return material;
}

function checkPrecision(point, size) {
  if (size * .01 < Math.max(Math.abs(point.x), Math.abs(point.y), Math.abs(point.z)) * 2 ** -20) throw new RangeError('Radius is too small for Float32 coordinates; use scene units near the origin');
}

// Keep pending uploads bounded even if many samples arrive between renders.
function dirty(attribute, start, count) {
  const ranges = [...attribute.updateRanges, { start, count }].sort((a, b) => a.start - b.start);
  attribute.clearUpdateRanges();
  for (const range of ranges) {
    const last = attribute.updateRanges.at(-1);
    if (last && range.start <= last.start + last.count) last.count = Math.max(last.start + last.count, range.start + range.count) - last.start;
    else attribute.addUpdateRange(range.start, range.count);
  }
  attribute.needsUpdate = true;
}

function chunk(material) {
  const geometry = new BufferGeometry();
  for (const name of ['position', 'normal']) geometry.setAttribute(name,
    new BufferAttribute(new Float32Array((CAP_VERTICES + (SEGMENTS + 1) * SIDES) * 3), 3).setUsage(DynamicDrawUsage));
  const indices = [];
  for (let cap = 0; cap < 2; cap++) {
    const base = cap * (SIDES + 1);
    for (let i = 0; i < SIDES; i++) {
      const a = base + 1 + i, b = base + 1 + (i + 1) % SIDES;
      indices.push(base, cap ? a : b, cap ? b : a);
    }
  }
  for (let s = 0; s < SEGMENTS; s++) {
    const base = CAP_VERTICES + s * SIDES;
    for (let i = 0; i < SIDES; i++) {
      const a = base + i, b = base + (i + 1) % SIDES, c = a + SIDES, d = b + SIDES;
      indices.push(a, b, c, b, d, c);
    }
  }
  geometry.setIndex(new BufferAttribute(new Uint16Array(indices), 1));
  geometry.setDrawRange(0, 0);
  const mesh = new Mesh(geometry, material);
  // shortcut: no frustum culling; add cached bounds if large offscreen scenes become costly.
  mesh.frustumCulled = false;
  return { mesh, segments: 0 };
}

function writeVertices(geometry, offset, positions, normals) {
  for (const [name, values] of [['position', positions], ['normal', normals]]) {
    const attribute = geometry.attributes[name];
    values.forEach((v, i) => v.toArray(attribute.array, (offset + i) * 3));
    dirty(attribute, offset * 3, values.length * 3);
  }
}

function cap(geometry, end, center, ring, tangent) {
  const normal = tangent.clone().multiplyScalar(end ? 1 : -1);
  writeVertices(geometry, end ? SIDES + 1 : 0, [center, ...ring], Array(SIDES + 1).fill(normal));
}

function trim(part) {
  const old = part.mesh.geometry;
  const geometry = new BufferGeometry();
  const vertices = CAP_VERTICES + (part.segments + 1) * SIDES;
  for (const name of ['position', 'normal']) geometry.setAttribute(name, new BufferAttribute(old.attributes[name].array.slice(0, vertices * 3), 3));
  geometry.setIndex(new BufferAttribute(old.index.array.slice(0, old.drawRange.count), 1));
  geometry.setDrawRange(0, old.drawRange.count);
  part.mesh.geometry = geometry;
  old.dispose();
}

function taperEnd(stroke) {
  const part=stroke.parts.at(-1), geometry=part.mesh.geometry;
  const positions=geometry.attributes.position;
  const radius=stroke.style.size*.01;
  const center=new Vector3(),vertex=new Vector3(),previous=stroke.last.clone();
  let distance=0;
  for(let ring=part.segments;ring>=0;ring--) {
    const start=CAP_VERTICES+ring*SIDES;
    center.set(0,0,0);
    for(let side=0;side<SIDES;side++)center.add(vertex.fromBufferAttribute(positions,start+side));
    center.divideScalar(SIDES);
    distance+=center.distanceTo(previous);
    if(distance>=3*radius || ring===0 && stroke.parts.length>1)break;
    previous.copy(center);
    const scale=.15+.85*distance/(3*radius);
    for(let side=0;side<SIDES;side++) {
      vertex.fromBufferAttribute(positions,start+side).sub(center).multiplyScalar(scale).add(center);
      positions.setXYZ(start+side,vertex.x,vertex.y,vertex.z);
      if(ring===part.segments)positions.setXYZ(SIDES+2+side,vertex.x,vertex.y,vertex.z);
      if(ring===0)positions.setXYZ(1+side,vertex.x,vertex.y,vertex.z);
    }
    dirty(positions,start*3,SIDES*3);
  }
  dirty(positions,0,CAP_VERTICES*3);
}

export class StrokeEngine {
  constructor(onFlight, onTrail, onShape, onUnmatchedShape, onStrokeBegin) {
    this.onFlight = onFlight;
    this.onTrail = onTrail;
    this.onShape = onShape;
    this.onUnmatchedShape = onUnmatchedShape;
    this.onStrokeBegin = onStrokeBegin;
  }
  group = new Group();
  #strokes = [];
  #undone = [];
  #active = null;
  #disposed = false;
  #nextId = 1;

  get active() { return this.#active !== null; }
  #live() { if (this.#disposed) throw new Error('StrokeEngine is disposed'); }

  beginStroke(point, style) {
    this.#live();
    if (this.#active) throw new Error('End or cancel the active stroke first');
    const last = pointValue(point), validated = styleValue(style);
    checkPrecision(last, validated.size);
    this.#active = { first: last.clone(), last, style: validated, parts: [], material: null, direction: null, normal: null, ring: null, ringNormals: null,
      shapeSamples: (validated.shape3d || validated.smartDraw) ? [last.clone()] : null };
    if(this.onFlight && ['ion','aurora','ember'].includes(style?.effect))Object.assign(this.#active,{effect:style.effect,route:[last],stride:1,samples:0});
    this.onStrokeBegin?.({ style: validated });
  }

  appendPoint(point,widthScale=1) {
    this.#live();
    const stroke = this.#active;
    if (!stroke) throw new Error('No active stroke');
    const next = pointValue(point);
    if(!Number.isFinite(widthScale)||widthScale<.5||widthScale>1.5)throw new RangeError('Invalid width scale');
    checkPrecision(next, stroke.style.size*widthScale);
    if (next.distanceToSquared(stroke.last) < 1e-12 || ['x', 'y', 'z'].every(k => Math.fround(next[k]) === Math.fround(stroke.last[k]))) return false;
    const direction = next.clone().sub(stroke.last).normalize();
    let normal;
    if (stroke.direction) {
      normal = stroke.normal.clone().applyQuaternion(new Quaternion().setFromUnitVectors(stroke.direction, direction));
      normal.addScaledVector(direction, -normal.dot(direction)).normalize();
    } else {
      normal = Math.abs(direction.y) < .9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
      normal.addScaledVector(direction, -normal.dot(direction)).normalize();
    }
    const side = new Vector3().crossVectors(direction, normal).normalize();
    const radius = stroke.style.size * .01*widthScale;
    const ringNormals = angles.map(([c, s]) => normal.clone().multiplyScalar(c).addScaledVector(side, s));
    const ring = ringNormals.map(n => next.clone().addScaledVector(n, radius));
    if (!stroke.ring) {
      stroke.ringNormals = ringNormals;
      stroke.ring = ringNormals.map(n => stroke.last.clone().addScaledVector(n, stroke.style.mineral?radius*.28:radius));
    }
    let part = stroke.parts.at(-1);
    if (!part || part.segments === SEGMENTS) {
      stroke.material ||= brushMaterial(stroke.style);
      part = chunk(stroke.material);
      stroke.parts.push(part);
      this.group.add(part.mesh);
      writeVertices(part.mesh.geometry, CAP_VERTICES, stroke.ring, stroke.ringNormals);
      cap(part.mesh.geometry, false, stroke.last, stroke.ring, stroke.direction || direction);
    }
    writeVertices(part.mesh.geometry, CAP_VERTICES + (part.segments + 1) * SIDES, ring, ringNormals);
    cap(part.mesh.geometry, true, next, ring, direction);
    part.segments++;
    part.mesh.geometry.setDrawRange(0, 6 * SIDES * (part.segments + 1));
    if(stroke.effect)this.onTrail?.(stroke.last,next,stroke.effect,stroke.style.size,stroke.parts[0].mesh);
    stroke.last = next;
    if(stroke.shapeSamples){
      stroke.shapeSamples.push(next.clone());
      if(stroke.shapeSamples.length>=2048){
        stroke.shapeSamples=stroke.shapeSamples.filter((_,index,arr)=>index%2===0||index===arr.length-1);
      }
    }
    if(stroke.route && ++stroke.samples%stroke.stride===0){
      stroke.route.push(next);
      if(stroke.route.length>=1024){stroke.route=stroke.route.filter((_,index)=>index%2===0);stroke.stride*=2;}
    }
    stroke.direction = direction;
    stroke.normal = normal;
    stroke.ring = ring;
    stroke.ringNormals = ringNormals;
    return true;
  }

  #buildTubeFromPoints(points, style, effectName) {
    const clean = [];
    for (const p of points) {
      const v = pointValue(p);
      if (!clean.length || v.distanceToSquared(clean[clean.length - 1]) >= 1e-8) clean.push(v);
    }
    if (clean.length < 2) return null;
    const stroke = {
      last: clean[0],
      style,
      parts: [],
      material: null,
      direction: null,
      normal: null,
      ring: null,
      ringNormals: null,
      route: effectName ? [clean[0]] : null,
    };
    const radius = style.size * 0.01;
    for (let i = 1; i < clean.length; i++) {
      const next = clean[i];
      const direction = next.clone().sub(stroke.last).normalize();
      let normal;
      if (stroke.direction) {
        if (stroke.direction.dot(direction) < -0.999) {
          normal = stroke.normal.clone();
        } else {
          normal = stroke.normal.clone().applyQuaternion(new Quaternion().setFromUnitVectors(stroke.direction, direction));
        }
        normal.addScaledVector(direction, -normal.dot(direction)).normalize();
      } else {
        normal = Math.abs(direction.y) < .9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
        normal.addScaledVector(direction, -normal.dot(direction)).normalize();
      }
      const side = new Vector3().crossVectors(direction, normal).normalize();
      const ringNormals = angles.map(([c, s]) => normal.clone().multiplyScalar(c).addScaledVector(side, s));
      const ring = ringNormals.map(n => next.clone().addScaledVector(n, radius));
      if (!stroke.ring) {
        stroke.ringNormals = ringNormals;
        stroke.ring = ringNormals.map(n => stroke.last.clone().addScaledVector(n, style.mineral ? radius * .28 : radius));
      }
      let part = stroke.parts.at(-1);
      if (!part || part.segments === SEGMENTS) {
        stroke.material ||= brushMaterial(style);
        part = chunk(stroke.material);
        stroke.parts.push(part);
        this.group.add(part.mesh);
        writeVertices(part.mesh.geometry, CAP_VERTICES, stroke.ring, stroke.ringNormals);
        cap(part.mesh.geometry, false, stroke.last, stroke.ring, stroke.direction || direction);
      }
      writeVertices(part.mesh.geometry, CAP_VERTICES + (part.segments + 1) * SIDES, ring, ringNormals);
      cap(part.mesh.geometry, true, next, ring, direction);
      part.segments++;
      part.mesh.geometry.setDrawRange(0, 6 * SIDES * (part.segments + 1));
      stroke.last = next;
      if (stroke.route) stroke.route.push(next);
      stroke.direction = direction;
      stroke.normal = normal;
      stroke.ring = ring;
      stroke.ringNormals = ringNormals;
    }
    if (!stroke.parts.length) return null;
    taperEnd(stroke);
    const last = stroke.parts.at(-1);
    if (last.segments < SEGMENTS) trim(last);
    return stroke;
  }

  #collectVisibleEndpoints() {
    const out = [];
    for (const stroke of this.#strokes) {
      if (Array.isArray(stroke.endpoints)) out.push(...stroke.endpoints);
    }
    return out;
  }

  #snapEndpoint(point, candidates, threshold = 0.28) {
    let best = null, bestDist = threshold;
    for (const c of candidates) {
      const d = Math.hypot(point.x - c.x, point.y - c.y, point.z - c.z);
      if (d > 1e-6 && d <= bestDist) {
        bestDist = d;
        best = { x: c.x, y: c.y, z: c.z };
      }
    }
    return best;
  }

  #snapRegularizedLine(points) {
    const endpoints = this.#collectVisibleEndpoints();
    if (!endpoints.length || points.length < 2) return points;
    const p0 = points[0], p1 = points[points.length - 1];
    const s0 = this.#snapEndpoint(p0, endpoints, 0.28) || p0;
    const s1 = this.#snapEndpoint(p1, endpoints, 0.28) || p1;
    if (s0 === p0 && s1 === p1) return points;
    const len = Math.hypot(s1.x - s0.x, s1.y - s0.y, s1.z - s0.z);
    if (len < 0.08) return points;
    const steps = Math.max(12, Math.ceil(len / 0.075));
    const out = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      out.push({ x: s0.x + (s1.x - s0.x) * t, y: s0.y + (s1.y - s0.y) * t, z: s0.z + (s1.z - s0.z) * t });
    }
    return out;
  }

  endStroke() {
    this.#live();
    if (!this.#active) return false;
    const stroke = this.#active;
    if (stroke.parts.length) {
      this.#undone.forEach(item=>this.#release(item));this.#undone=[];
      const id = this.#nextId++;
      const reg = stroke.style.smartDraw && Array.isArray(stroke.shapeSamples) && stroke.shapeSamples.length >= 4
        ? regularizeStroke(stroke.shapeSamples) : null;
      const closedReg = reg && (reg.kind === 'circle' || reg.kind === 'rectangle' || reg.kind === 'triangle');
      const rawRecognized = stroke.style.shape3d && Array.isArray(stroke.shapeSamples) && stroke.shapeSamples.length >= 8
        ? recognizeShape3D(stroke.shapeSamples) : null;
      const regRecognized = !rawRecognized && closedReg && stroke.style.shape3d
        ? recognizeShape3D(reg.points) : null;
      const recognized = rawRecognized || regRecognized;
      if (recognized) {
        this.#release(stroke);
        const mesh = createShape3DMesh(recognized, stroke.style);
        this.group.add(mesh);
        this.#strokes.push({ id, parts: [{ mesh, segments: 0 }], shape: recognized });
        this.onShape?.(recognized, mesh);
      } else {
        if (reg && reg.points.length >= 2) {
          const regPoints = reg.kind === 'line' ? this.#snapRegularizedLine(reg.points) : reg.points;
          this.#release(stroke);
          const rebuilt = this.#buildTubeFromPoints(regPoints, stroke.style, stroke.effect);
          if (rebuilt) {
            this.#strokes.push({
              id,
              parts: rebuilt.parts, material: rebuilt.material, regularKind: reg.kind,
              endpoints: [pointValue(regPoints[0]), pointValue(regPoints[regPoints.length - 1])],
            });
            if (rebuilt.route && this.onFlight) {
              this.onFlight(rebuilt.route, stroke.effect, stroke.style.size, rebuilt.parts[0].mesh);
            }
          }
        } else {
          taperEnd(stroke);
          const last = stroke.parts.at(-1);
          if (last.segments < SEGMENTS) trim(last);
          this.#strokes.push({
            id,
            parts: stroke.parts, material: stroke.material,
            endpoints: [stroke.first.clone(), stroke.last.clone()],
          });
          if(stroke.route){
            if(stroke.route.at(-1)!==stroke.last)stroke.route.push(stroke.last);
            this.onFlight(stroke.route,stroke.effect,stroke.style.size,stroke.parts[0].mesh);
          }
        }
        // Always feed raw stroke samples to the ONNX classifier so smartDraw curves/polylines
        // preserve sharp letter and crescent features.
        if (stroke.style.shape3d && Array.isArray(stroke.shapeSamples) && stroke.shapeSamples.length >= 4) {
          this.onUnmatchedShape?.({ id, samples: stroke.shapeSamples, style: { ...stroke.style } });
        }
      }
    }
    this.#active = null;
    return true;
  }

  hasStroke(id) {
    return this.#strokes.some(s => s.id === id);
  }

  replaceStrokesWithShape(strokeIds, shapeDescriptor, style = {}) {
    this.#live();
    if (!Array.isArray(strokeIds) || !strokeIds.length || !shapeDescriptor) return null;
    const idSet = new Set(strokeIds);
    const matchedIndices = [];
    for (let i = 0; i < this.#strokes.length; i++) {
      if (idSet.has(this.#strokes[i].id)) matchedIndices.push(i);
    }
    if (matchedIndices.length !== idSet.size) return null;

    const insertAt = matchedIndices[0];
    const kept = [];
    for (let i = 0; i < this.#strokes.length; i++) {
      const item = this.#strokes[i];
      if (idSet.has(item.id)) {
        this.#release(item);
      } else {
        kept.push(item);
      }
    }
    const mesh = createShape3DMesh(shapeDescriptor, style);
    this.group.add(mesh);
    const record = { id: this.#nextId++, parts: [{ mesh, segments: 0 }], shape: shapeDescriptor };
    const finalIndex = Math.min(insertAt, kept.length);
    kept.splice(finalIndex, 0, record);
    this.#strokes = kept;
    this.onShape?.(shapeDescriptor, mesh);
    return mesh;
  }

  #release(stroke) {
    const materials = new Set();
    if (stroke.material) materials.add(stroke.material);
    for (const { mesh } of stroke.parts) {
      this.group.remove(mesh);
      mesh.traverse(obj => {
        obj.geometry?.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach(mat => { if (mat) materials.add(mat); });
      });
    }
    materials.forEach(mat => mat.dispose());
  }

  undo(){
    if(this.active || !this.#strokes.length)return false;
    const stroke=this.#strokes.pop();
    for(const {mesh} of stroke.parts)this.group.remove(mesh);
    this.#undone.push(stroke);return true;
  }
  redo(){
    if(this.active || !this.#undone.length)return false;
    const stroke=this.#undone.pop();
    for(const {mesh} of stroke.parts)this.group.add(mesh);
    this.#strokes.push(stroke);return true;
  }
  get canRedo(){return !this.active && this.#undone.length>0;}

  cancelStroke() {
    this.#live();
    if (!this.#active) return false;
    this.#release(this.#active);
    this.#active = null;
    return true;
  }

  clear() {
    this.#live();
    this.cancelStroke();
    this.#strokes.forEach(stroke => this.#release(stroke));
    this.#undone.forEach(stroke=>this.#release(stroke));this.#undone=[];
    this.#strokes = [];
  }

  get shapes() {
    return this.group.children.filter(mesh => mesh.userData?.shape3d);
  }

  get stats() {
    const parts = this.group.children;
    const tubeParts = parts.filter(mesh => !mesh.userData?.shape3d);
    let geometryBytes = 0;
    this.group.traverse(obj => {
      const g = obj.geometry;
      if (!g) return;
      geometryBytes += (g.index ? g.index.array.byteLength : 0)
        + Object.values(g.attributes).reduce((n, a) => n + a.array.byteLength, 0);
    });
    return { strokes: this.#strokes.length, active: this.active, chunks: parts.length,
      shapes: parts.length - tubeParts.length,
      segments: tubeParts.reduce((sum, mesh) => sum + mesh.geometry.drawRange.count / (6 * SIDES) - 1, 0),
      geometryBytes };
  }

  dispose() {
    if (this.#disposed) return;
    this.clear();
    this.group.removeFromParent();
    this.#disposed = true;
  }
}
