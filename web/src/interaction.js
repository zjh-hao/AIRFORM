// P0-A geometry and thresholds; pixel aspect ratio matters for distances.
import { GestureScale, BOUNDARY, inImage } from './gesture-scale.js';
import { STROKE_CONTINUITY } from './stroke-continuity.js';
import { HandGesture, HandIdentity, HAND_GEOMETRY } from './hand-geometry.js';
export const PINCH = Object.freeze({ enter: 0.30, release: 0.45, confirmMs: 80, releaseConfirmMs: 40, handConfirmMs: 80, maxGapMs: 250 });
export const PLANE = Object.freeze({ width: 6, height: 4.5, z: 0 });

export function pinchRatio(points, width, height) {
  if (!(width > 0 && height > 0) || ![width, height].every(Number.isFinite)
    || ![0, 4, 8, 9].every(i => Number.isFinite(points?.[i]?.x) && Number.isFinite(points[i].y))) return null;
  const distance = (a, b) => Math.hypot((points[a].x - points[b].x) * width, (points[a].y - points[b].y) * height);
  const palm = distance(0, 9);
  const ratio = distance(4, 8) / palm;
  return palm > 1e-6 && Number.isFinite(ratio) ? ratio : null;
}

export function mapPoint(tip) {
  if (!Number.isFinite(tip?.x) || !Number.isFinite(tip.y)) return null;
  const clamp = value => Math.max(0, Math.min(1, value));
  // Raw camera pixels stay untouched; both the preview and interaction mirror X once.
  return { x: (0.5 - clamp(tip.x)) * PLANE.width, y: (0.5 - clamp(tip.y)) * PLANE.height, z: PLANE.z };
}

export class HandInteraction {
  constructor(projectPoint = mapPoint, { gestureMode = 'world' } = {}) {
    this.projectPoint = projectPoint;
    this.gestureMode = gestureMode;
    this.gestureScale = gestureMode === 'legacy' ? new GestureScale() : new HandGesture();
    this.identity = new HandIdentity();
    this.reset();
    this.lastTimestamp = -Infinity;
  }

  reset({ allowResume = false } = {}) {
    // An interrupted pinch may restart a NEW stroke after requalification.
    // Explicit reset (startup, Stop, Clear) always requires opening first.
    this.resumeAllowed = allowResume && (this.state === 'Pinching' || this.resumeAllowed === true);
    const keepScale = this.resumeAllowed && this.lastVisible
      && this.lastTimestamp-this.lastVisible.timestamp <= STROKE_CONTINUITY.pauseMs;
    this.state = 'TrackingLost';
    this.pendingSince = null;
    this.rightSince = null;
    this.lastVisible = null;
    this.boundaryPaused = false;
    this.lossSince = null;
    if (!keepScale) { this.gestureScale.reset(); this.identity.reset(); }
    if (this.resumeAllowed && this.projectPoint.suspend) this.projectPoint.suspend(this.lastTimestamp);
    else this.projectPoint.reset?.();
  }

  update({ landmarks, worldLandmarks, handedness, timestamp, source, depthFrame, enhanced=false }, width, height) {
    // The fixture exercises inference only and must never arm live interaction.
    if (source !== '摄像头' && source !== 'stopped') return null;
    if (!Number.isFinite(timestamp) || timestamp <= this.lastTimestamp) return null;
    const gap = timestamp - this.lastTimestamp;
    this.lastTimestamp = timestamp;
    if (source === 'stopped') this.reset();
    const interrupted = gap > PINCH.maxGapMs;
    const tip = landmarks?.[0]?.[8], previous = this.lastVisible;
    const resumeNearby = enhanced && interrupted && !this.boundaryPaused && previous?.stablePinch &&
      timestamp - previous.timestamp <= STROKE_CONTINUITY.processingGapMs &&
      this.state === 'Pinching' && landmarks?.length === 1 && handedness?.[0]?.[0]?.categoryName === 'Right' &&
      tip && Math.hypot(tip.x - previous.tip.x, tip.y - previous.tip.y) < .09;
    if (interrupted && !resumeNearby) this.reset({ allowResume: source === '摄像头' });

    // Labels refer to the unmodified model input. Never infer handedness from X.
    // Ambiguous duplicate Right labels fail closed instead of switching hands.
    const selected = source === '摄像头' ? this.identity.select({ landmarks, worldLandmarks, handedness, timestamp },
      this.gestureMode !== 'legacy' && this.state === 'Pinching' && this.lastVisible?.stablePinch) : { index: null };
    const handIndex = selected.index;
    const points = handIndex === null ? null : landmarks?.[handIndex];
    let observation = points ? this.gestureScale.observe(points, width, height, timestamp, worldLandmarks?.[handIndex]) : null;
    if(resumeNearby && !(observation && observation.ratio!==null && observation.ratio<=(observation.thresholds??PINCH).enter)){
      this.reset();observation=null;
    }
    // One empty result in the middle of a confirmed pinch used to cost two
    // requalification windows. Preserve a stable pinch locally, never emit a
    // point while absent, and use the original (longer) window at the edge.
    const holdMs = this.lastVisible?.boundary ? BOUNDARY.pauseMs : this.gestureMode === 'legacy' ? 120 : 150;
    const incompleteRight = this.gestureMode !== 'legacy' && inImage(points?.[8]) && !observation;
    if (source === '摄像头' && (landmarks?.length === 0 || observation?.basis === 'unreliable' || incompleteRight) && this.state === 'Pinching'
        && (this.lastVisible?.boundary || this.lastVisible?.stablePinch)
        && timestamp-this.lastVisible.timestamp <= holdMs) {
      this.boundaryPaused = true; this.pendingSince = null;
      if (this.gestureMode !== 'legacy') this.projectPoint.suspend?.(timestamp);
      return { state: this.state, point: null, timestamp, source, ratio: null, handIndex: null,
        ...(this.gestureMode !== 'legacy' ? { cursorPoint: this.lastVisible.cursorPoint ?? null, cursorSource: 'held',
          cursorAgeMs: timestamp-this.lastVisible.timestamp, observationValid: false } : {}),
        tracking: this.lastVisible.boundary ? 'boundary-paused' : 'pinch-paused' };
    }
    if (this.boundaryPaused && observation) {
      const previous = this.lastVisible;
      const close = (a,b) => Math.hypot(a.x-b.x,a.y-b.y) <= BOUNDARY.recoveryDistance;
      if (!previous || timestamp-previous.timestamp > holdMs
          || !close(points[8],previous.tip) || !close(points[4],previous.thumb)) {
        this.reset({ allowResume: true }); observation = this.gestureScale.observe(points,width,height,timestamp,worldLandmarks?.[handIndex]);
      } else if (observation.ratio >= PINCH.release && !observation.projectedContact) {
        // Open-hand reacquisition must never add a bridging segment.
        this.state = 'Idle'; this.pendingSince = null;
      }
      this.boundaryPaused = false;
    }
    const ratio = observation?.ratio ?? null;
    const thresholds = observation?.thresholds ?? PINCH;
    // Hand identity/gesture qualification depends on the RGB landmarks. A depth
    // hole at the fingertip is not loss of the hand: keep the gesture state so
    // valid depth can start a new independent stroke without forced reopening.
    let qualified = ratio !== null;
    if (!qualified) this.rightSince = null;
    else {
      this.rightSince ??= timestamp;
      // Real left-hand re-entry produced isolated Right labels; qualify before showing a cursor.
      qualified = timestamp - this.rightSince >= PINCH.handConfirmMs;
    }
    if (!qualified) {
      this.resumeAllowed = source === '摄像头' && (this.state === 'Pinching' || this.resumeAllowed);
      if (this.resumeAllowed) this.lossSince ??= timestamp;
      else this.lossSince = null;
      this.state = 'TrackingLost'; this.pendingSince = null;
      this.lastVisible = null; this.boundaryPaused = false;
      if (ratio === null && (!this.resumeAllowed || timestamp-this.lossSince > STROKE_CONTINUITY.pauseMs)) this.gestureScale.reset();
      if (this.resumeAllowed && this.projectPoint.suspend) this.projectPoint.suspend(timestamp);
      else this.projectPoint.reset?.();
    } else {
      this.lossSince = null;
      if (this.state === 'TrackingLost') this.state = this.resumeAllowed ? 'Idle' : 'Rearming';
      if (this.state === 'Pinching') {
        // Keep the stroke through brief ratio spikes; invalid tracking still ends above.
        if (ratio < thresholds.release) this.pendingSince = null;
        else {
          this.pendingSince ??= timestamp;
          // A tilted palm can shorten the projected wrist-to-MCP distance.
          // If model-space tips still touch, require longer evidence before
          // treating this 2D excursion as a release. Never veto it indefinitely.
          const world = worldLandmarks?.[handIndex];
          const length = (a,b) => Math.hypot(...['x','y','z'].map(k=>world?.[a]?.[k]-world?.[b]?.[k]));
          const palm = length(0,9), separation = length(4,8);
          const conflicting = this.gestureMode === 'legacy' && palm > 1e-6 && separation / palm <= PINCH.enter;
          const confirmMs = observation.projectedContact ? (observation.pose === 'foreshortened'
            ? HAND_GEOMETRY.foreshortenedConflictMs : HAND_GEOMETRY.conflictConfirmMs)
            : conflicting ? 100 : PINCH.releaseConfirmMs;
          if (timestamp - this.pendingSince >= confirmMs) {
            this.state = 'Idle';
            this.pendingSince = null;
          }
        }
      } else {
        const confirmed = this.state === 'Rearming' ? ratio >= thresholds.release : ratio <= thresholds.enter;
        if (!confirmed) this.pendingSince = null;
        else {
          this.pendingSince ??= timestamp;
          if (timestamp - this.pendingSince >= PINCH.confirmMs) {
            this.state = this.state === 'Rearming' ? 'Idle' : 'Pinching';
            this.pendingSince = null;
          }
        }
      }
    }
    const point = qualified ? this.projectPoint(points[8], depthFrame, points, timestamp) : null;
    const cursorPoint = qualified ? (this.projectPoint.cursorPoint ? this.projectPoint.cursorPoint() : point) : null;
    if (qualified && (this.state === 'Pinching' || ratio >= thresholds.release)) this.resumeAllowed = false;
    if (qualified) this.lastVisible = { timestamp, tip: { ...points[8] }, thumb: { ...points[4] }, boundary: observation.boundary,
      cursorPoint: cursorPoint ? { ...cursorPoint } : null,
      pinched: this.state === 'Pinching' && ratio <= thresholds.enter,
      stablePinch: this.state === 'Pinching' && (ratio <= thresholds.enter && this.lastVisible?.pinched === true
        || observation.basis === 'world' && ratio < thresholds.release && this.lastVisible?.stablePinch === true) };
    const result = { state: this.state, point, timestamp, source, ratio: qualified ? ratio : null, handIndex: qualified ? handIndex : null };
    if(enhanced)Object.assign(result,{enhanced:true,processingResume:!!resumeNearby && qualified && this.state==='Pinching'});
    if (source === '摄像头' && this.gestureMode !== 'legacy') Object.assign(result, {
      cursorPoint, cursorSource: cursorPoint ? 'filtered' : 'missing', observationValid: qualified,
      gestureBasis: observation?.basis ?? 'missing', pose: observation?.pose ?? 'unknown', labelHeld: !!selected.held });
    if (this.state === 'Pinching' && this.pendingSince !== null) {
      result.releasePending = true;
      if (observation?.projectedContact && observation.pose === 'foreshortened' && !selected.held)
        result.retainPendingPath = true;
    }
    // Only an actual far relocation after a pause splits the pen session.
    if (point && this.projectPoint.motionStatus?.()?.relocated) result.breakStroke = true;
    if (this.resumeAllowed) result.canResume = true;
    if (this.resumeAllowed && !qualified && Number.isFinite(ratio)) result.requalifyingRight = true;
    if (qualified && observation.partial) result.tracking = 'partial-hand';
    if (qualified && observation.pose === 'foreshortened') result.tracking = 'foreshortened';
    return result;
  }
}

export function connectInteraction(target, getSize, projectPoint = mapPoint, options) {
  const interaction = new HandInteraction(projectPoint, options);
  let enabled=true;
  const receive = ({ detail }) => {
    if(!enabled)return;
    const { width, height } = getSize();
    const result = interaction.update(detail, width, height);
    if (result) target.dispatchEvent(new CustomEvent('kineglow:interaction', { detail: result }));
  };
  target.addEventListener('kineglow:hands', receive);
  const clear = () => interaction.reset();
  target.addEventListener('kineglow:clear', clear);
  const switchMode=({detail})=>{enabled=detail!=='solar';clear();};
  target.addEventListener('kineglow:effect',switchMode);
  return () => {
    target.removeEventListener('kineglow:hands', receive);
    target.removeEventListener('kineglow:clear', clear);
    target.removeEventListener('kineglow:effect',switchMode);
  };
}
