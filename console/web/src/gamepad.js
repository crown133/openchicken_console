// v8 velstand manifest -> microduck_rl commit 3750776, velocity config lines 590–592.
export const DRIVE_LIMITS = Object.freeze({vx:.4, vy:.3, vyaw:1});
const DEADZONE=.12;
const ZERO=()=>({vx:0,vy:0,vyaw:0});
export function mapAxis(value, limit) {
  if (!Number.isFinite(value)) return 0;
  const magnitude=Math.min(1,Math.abs(value));
  return magnitude<=DEADZONE?0:Math.sign(value)*(magnitude-DEADZONE)/(1-DEADZONE)*limit;
}
export function readXbox(pad) {
  if (!pad?.connected || pad.mapping!=='standard' || pad.axes.length<4 || pad.buttons.length<10 ||
      !pad.axes.slice(0,4).every(Number.isFinite)) return null;
  const pressed=index=>pad.buttons[index]?.pressed===true;
  const buttons={stop:pressed(4)&&pressed(1),sit:pressed(4)&&pressed(0),left:pressed(4)&&pressed(2),right:pressed(4)&&pressed(3),start:pressed(9)};
  return {buttons, neutral:pad.axes.slice(0,4).every(v=>Math.abs(v)<=DEADZONE)&&!pad.buttons.some(b=>b.pressed),
    velocity:{vx:mapAxis(-pad.axes[1],DRIVE_LIMITS.vx),vy:mapAxis(-pad.axes[0],DRIVE_LIMITS.vy),vyaw:mapAxis(-pad.axes[2],DRIVE_LIMITS.vyaw)}};
}

// Poll freshness is separate from pad.timestamp, which can stay unchanged while a stick is held.
export class XboxInput {
  constructor() { this.reset(); }
  reset() { this.key=null;this.lastPoll=null;this.armed=false;this.previous={}; }
  poll(pad, now, context, active=true) {
    const sample=active?readXbox(pad):null;
    const result={velocity:ZERO(),command:null,fault:false,status:'disconnected'};
    if (!sample) {
      result.fault=this.key!==null;
      result.status=active&&pad?'unsupported':active?'disconnected':'inactive';
      this.reset();return result;
    }
    const key=JSON.stringify([pad.index,pad.id,context]);
    const interrupted=this.key!==null && (this.key!==key || now-this.lastPoll>150 || now<this.lastPoll);
    if (this.key!==key || interrupted) {this.armed=false;this.previous=sample.buttons;}
    this.key=key;this.lastPoll=now;
    if (interrupted) {result.fault=true;result.status='interrupted';return result;}
    if (!this.armed) {
      this.armed=sample.neutral;this.previous=sample.buttons;
      result.status=this.armed?'ready':'neutral';return result;
    }
    const rising=key=>sample.buttons[key]&&!this.previous[key];
    // Emergency chord wins even with other face buttons pressed. Other chords are exclusive.
    if (rising('stop')) result.command='relax';
    else if (!sample.buttons.stop) {
      const down=Object.keys(sample.buttons).filter(k=>sample.buttons[k]);
      if (down.length===1 && rising(down[0]) && Object.values(sample.velocity).every(v=>v===0)) result.command={start:'init',sit:'sit_toggle',left:'kick_left',right:'kick_right'}[down[0]];
    }
    this.previous=sample.buttons;
    result.velocity=pad.buttons[4].pressed || sample.buttons.start || result.command?ZERO():sample.velocity;
    result.status='ready';
    return result;
  }
}
