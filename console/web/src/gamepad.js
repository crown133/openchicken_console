export const MAPPING_VERSION='openchicken-xbox-v3';
export const DRIVE_LIMITS=Object.freeze({vx:.4,vy:.3,vyaw:1});
const ZERO=()=>({vx:0,vy:0,vyaw:0});
const HEAD=()=>({neck_pitch:0,head_pitch:0,head_yaw:0,head_roll:0});
const POSE=()=>({z:0,roll:0,pitch:0,active:false});
const SKILLS={0:'sit_toggle',13:'ground_pick',14:'kick_left',15:'kick_right',12:'roulade'};
const MODES={14:'drive',12:'head',15:'head_drive',13:'body_pose'};
export function mapAxis(value,limit=1,gain=1,deadzone=.1) {
  return !Number.isFinite(value)||Math.abs(value)<deadzone?0:Math.max(-1,Math.min(1,value*gain))*limit;
}
export function readXbox(pad) {
  if(!pad?.connected||pad.mapping!=='standard'||pad.axes.length<4||pad.buttons.length<16||
      !pad.axes.slice(0,4).every(Number.isFinite))return null;
  const buttons=pad.buttons.map(b=>b.pressed===true);
  const trigger=i=>Math.max(0,Math.min(1,Number.isFinite(pad.buttons[i].value)?pad.buttons[i].value:buttons[i]?1:0));
  const lt=trigger(6),rt=trigger(7);
  return {buttons,lt,rt,sticks:{left_x:pad.axes[0],left_y:-pad.axes[1],right_x:pad.axes[2],right_y:-pad.axes[3]},
    neutral:pad.axes.slice(0,4).every(v=>Math.abs(v)<.1)&&!buttons.some(Boolean)&&lt<=.05&&rt<=.05};
}

// No timers or command queue: only newly sampled input advances holds. A gap disarms them.
export class XboxInput {
  constructor(profile=null) {this.profile=profile;this.reset();}
  configure(profile) {
    if(profile?.sha256!==this.profile?.sha256){this.profile=profile;this.reset();}
  }
  reset() {this.key=null;this.lastPoll=null;this.armed=false;this.previous=[];this.chords={};this.holds={};this.mode='drive';this.previousRT=0;}
  hold(index,held,wasHeld,now,threshold) {
    if(held&&!wasHeld)this.holds[index]={since:now,fired:false};
    const h=this.holds[index];
    if(!h)return null;
    if(!h.fired&&now-h.since>=threshold){h.fired=true;if(!held)delete this.holds[index];return 'long';}
    if(!held){delete this.holds[index];return h.fired?null:now-h.since;}
    return null;
  }
  poll(pad,now,context,active=true,robot={}) {
    const sample=active?readXbox(pad):null;
    const result={velocity:ZERO(),commands:[],frame:null,fault:false,status:'disconnected',mode:this.mode};
    if(!sample){this.relaxHeld=false;result.fault=this.key!==null;result.status=active&&pad?'unsupported':active?'disconnected':'inactive';this.reset();return result;}
    const key=JSON.stringify([pad.index,pad.id,context]);
    const interrupted=this.key!==null&&(key!==this.key||now-this.lastPoll>150||now<this.lastPoll);
    if(key!==this.key||interrupted){this.reset();this.previous=sample.buttons;}
    this.key=key;this.lastPoll=now;
    const b=sample.buttons,was=this.previous;this.previous=b;
    // Relax is available even before neutral arming or when the mapping profile is missing.
    if(b[4]&&b[1]){
      if(!this.relaxHeld)result.commands=['relax'];
      this.relaxHeld=true;this.holds={};this.chords={};this.armed=false;
      result.status='neutral';return result;
    }
    this.relaxHeld=false;
    if(interrupted){result.fault=true;result.status='interrupted';return result;}
    if(!this.profile||this.profile.version!==MAPPING_VERSION){result.status='configuration';return result;}
    if(!this.armed){this.armed=sample.neutral;result.status=this.armed?'ready':'neutral';return result;}
    result.status='ready';
    const cfg=this.profile.parameters;
    if(b[4]) {
      this.holds={};this.previousRT=sample.rt;
      for(const [i,skill] of Object.entries(SKILLS)){
        if(b[i]&&!this.chords[i])result.commands.push(skill);
        this.chords[i]=b[i];
      }
      // Suspend head/body input without changing mode; stop a previously held sound.
      result.frame={velocity:ZERO(),head:null,pose:null,mouth:0,wheee:false,crow:false};
      return result;
    }
    this.chords={};
    for(const [i,mode] of Object.entries(MODES))if(b[i]&&!was[i])this.mode=mode;
    const start=this.hold(9,b[9],was[9],now,1500),select=this.hold(8,b[8],was[8],now,4000);
    if(select==='long')result.commands.push('shutdown');
    else if(typeof select==='number'&&select>=2000)result.commands.push('rest');
    else if(start==='long'){this.mode='drive';result.commands.push('home');}
    else if(typeof start==='number'){
      if(robot.bringup==='Limp')result.commands.push('init');
      else if(robot.bringup==='Ready')result.commands.push('toggle');
      // Unknown/Homing feedback must not be interpreted as permission to initialise.
    }
    const a=cfg.pad_axes[this.mode];
    const value=k=>{const binding=a[k];return !binding||binding.source==='none'?0:mapAxis(sample.sticks[binding.source],1,binding.gain*(binding.invert?-1:1),cfg.pad_axes.deadzone);};
    const velocity=ZERO(),head=HEAD(),pose=POSE();
    if(['drive','head_drive'].includes(this.mode))for(const k of ['vx','vy','vyaw'])velocity[k]=value(k)*DRIVE_LIMITS[k];
    if(this.mode==='head_drive')velocity.vy=0;
    if(this.mode!=='drive')for(const k of Object.keys(head))head[k]=value(k)*cfg.pad_head[k+'_max'];
    if(this.mode==='body_pose'){
      const z=value('z');pose.z=z*(z<0?-cfg.pad_body.z_min:cfg.pad_body.z_max);
      pose.pitch=value('pitch')*cfg.pad_body.pitch_max;pose.roll=value('roll')*cfg.pad_body.roll_max;pose.active=true;
    }
    this.previousRT=sample.rt;
    result.mode=this.mode;
    result.velocity=(b[9]||b[8]||result.commands.some(c=>c!=='chirp'))?ZERO():velocity;
    result.frame={velocity:result.velocity,head,pose,mouth:Math.max(sample.lt,sample.rt),wheee:sample.lt>=.3,crow:sample.rt>=.3};
    return result;
  }
}
