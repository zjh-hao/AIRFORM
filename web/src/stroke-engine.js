import { BufferAttribute, BufferGeometry, DynamicDrawUsage, Group, Mesh, MeshStandardMaterial, Quaternion, Vector3 } from 'three';

const SIDES = 12, SEGMENTS = 128, CAP_VERTICES = 2 * (SIDES + 1);
const angles = Array.from({ length: SIDES }, (_, i) => [Math.cos(i * 2 * Math.PI / SIDES), Math.sin(i * 2 * Math.PI / SIDES)]);

function pointValue(point) {
  if (!point || !['x', 'y', 'z'].every(k => typeof point[k] === 'number' && Number.isFinite(point[k]))) throw new TypeError('Expected finite x, y, z');
  if (['x', 'y', 'z'].some(k => Math.abs(point[k]) > 10000)) throw new RangeError('Coordinates must be within ±10000 scene units');
  return new Vector3(point.x, point.y, point.z);
}

function styleValue({ color = '#35bfff', size = 3, mineral=false } = {}) {
  if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) throw new TypeError('Expected #RRGGBB color');
  if (!Number.isFinite(size) || size < .1 || size > 100) throw new RangeError('Size must be between 0.1 and 100');
  return { color, size, mineral };
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
  constructor(onFlight,onTrail){this.onFlight=onFlight;this.onTrail=onTrail;}
  group = new Group();
  #strokes = [];
  #undone = [];
  #active = null;
  #disposed = false;

  get active() { return this.#active !== null; }
  #live() { if (this.#disposed) throw new Error('StrokeEngine is disposed'); }

  beginStroke(point, style) {
    this.#live();
    if (this.#active) throw new Error('End or cancel the active stroke first');
    const last = pointValue(point), validated = styleValue(style);
    checkPrecision(last, validated.size);
    this.#active = { last, style: validated, parts: [], material: null, direction: null, normal: null, ring: null, ringNormals: null };
    if(this.onFlight && ['ion','aurora','ember'].includes(style?.effect))Object.assign(this.#active,{effect:style.effect,route:[last],stride:1,samples:0});
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

  endStroke() {
    this.#live();
    if (!this.#active) return false;
    const stroke = this.#active;
    if (stroke.parts.length) {
      this.#undone.forEach(item=>this.#release(item));this.#undone=[];
      taperEnd(stroke);
      const last = stroke.parts.at(-1);
      if (last.segments < SEGMENTS) trim(last);
      this.#strokes.push({ parts: stroke.parts, material: stroke.material });
      if(stroke.route){
        if(stroke.route.at(-1)!==stroke.last)stroke.route.push(stroke.last);
        this.onFlight(stroke.route,stroke.effect,stroke.style.size,stroke.parts[0].mesh);
      }
    }
    this.#active = null;
    return true;
  }

  #release(stroke) {
    for (const { mesh } of stroke.parts) { this.group.remove(mesh); mesh.geometry.dispose(); }
    stroke.material?.dispose();
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

  get stats() {
    const parts = this.group.children;
    return { strokes: this.#strokes.length, active: this.active, chunks: parts.length,
      segments: parts.reduce((sum, mesh) => sum + mesh.geometry.drawRange.count / (6 * SIDES) - 1, 0),
      geometryBytes: parts.reduce((sum, { geometry: g }) => sum + g.index.array.byteLength + Object.values(g.attributes).reduce((n, a) => n + a.array.byteLength, 0), 0) };
  }

  dispose() {
    if (this.#disposed) return;
    this.clear();
    this.group.removeFromParent();
    this.#disposed = true;
  }
}
