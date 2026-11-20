// A storage cap is an incomplete observation, not an instruction to make the
// operator repeat the entire group. Keep the evidence and mark missing coverage.
export function captureOutcome({started,aborted,reason,files}) {
  if(!started)return {advance:false,complete:false,files:[],status:'not-recorded'};
  const hasJson=files.some(name=>name.endsWith('.json'));
  const hasVideo=files.some(name=>name.endsWith('.webm'));
  const advance=!aborted&&hasJson&&hasVideo&&['duration','recorder-limit'].includes(reason);
  return {advance,complete:advance&&reason==='duration',files,
    status:aborted?'aborted':!hasJson||!hasVideo?'export-incomplete':reason==='recorder-limit'?'partial-at-limit':'recorded',
    missingScreenshot:!files.some(name=>name.endsWith('.png'))};
}

export class CaptureArming {
  constructor() {this.reset();}
  reset() {this.anchor=null;this.since=null;}
  update(sample,now) {
    const p=sample?.position;
    if(sample?.source!=='摄像头'||sample.state!=='Pinching'||!p
      ||![p.x,p.y,sample.timestamp,now].every(Number.isFinite)||now-sample.timestamp>250) {
      this.reset();return false;
    }
    if(!this.anchor||Math.hypot(p.x-this.anchor.x,p.y-this.anchor.y)>.12) {
      this.anchor={...p};this.since=now;return false;
    }
    return now-this.since>=1000;
  }
}
