// Extra skill inputs; native commands take priority.
const BUTTONS={LB:4,RB:5,X:2,Y:3};
export class ManagedBindings {
 constructor(){this.signature='';this.entries={};this.reset();}
 reset(){this.armed=false;this.previous=new Set();this.lastPoll=null;}
 configure(entries,context){
  const signature=JSON.stringify([context,entries]);if(signature===this.signature)return false;
  this.signature=signature;this.entries=entries||{};this.reset();return true;
 }
 keyboard(code){return Object.entries(this.entries).find(([,entry])=>entry.bindings.keyboard.some(b=>b.code===code))?.[0]||null;}
 poll(pad,now,active,suppressed=false){
  const gap=this.lastPoll!==null&&now-this.lastPoll>150;this.lastPoll=now;
  if(!active||gap||!pad?.connected||pad.mapping!=='standard'){this.armed=false;this.previous.clear();return null;}
  const down=new Set(Array.from(pad.buttons||[],(b,i)=>b?.pressed||b?.value>.5?i:-1).filter(i=>i>=0));
  const neutral=down.size===0&&Array.from(pad.axes||[]).every(v=>Number.isFinite(v)&&Math.abs(v)<.1);
  if(!this.armed){if(neutral)this.armed=true;this.previous=down;return null;}
  let found=null;
  if(!suppressed&&!down.has(1)&&!down.has(8)&&!down.has(9))for(const [name,entry] of Object.entries(this.entries)){
   const match=entry.bindings.browser_gamepad.some(b=>{const indices=b.buttons.map(key=>BUTTONS[key]);return indices.length===down.size&&indices.every(i=>down.has(i))&&!indices.every(i=>this.previous.has(i));});
   if(match){found=name;break;}
  }
  this.previous=down;return found;
 }
}
