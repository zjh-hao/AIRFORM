import test from 'node:test';
import assert from 'node:assert/strict';
import {PalmFollow} from '../src/palm-follow.js';

const hand={x:180,y:260,radius:60,label:'Left',measured:true};
function start(){const follow=new PalmFollow();follow.observe([hand],0,480);return follow;}

test('subthreshold drift and a single depth/identity outlier leave the map stationary',()=>{
  const follow=start(),first={...follow.frame(0)};
  for(let index=1;index<=30;index++){
    const sample=index===15?{x:500,y:395,radius:160,label:'Right'}:{...hand,x:hand.x+6*Math.sin(index),radius:hand.radius+1};
    follow.observe([sample],index*20,480);const pose=follow.frame(index*20);
    for(const key of ['x','y','radius'])assert.equal(pose[key],first[key]);
  }
});

test('sudden approach or recession scales at constant bounded speed, around a fixed center',()=>{
  for(const target of [20,150]){
    const follow=start(),first={...follow.frame(0)};let previous=first.radius;
    for(let tick=1;tick<=200;tick++){
      const now=tick*16;if(tick%3===1)follow.observe([{...hand,radius:target,measured:false}],now,480);
      const pose=follow.frame(now),step=Math.abs(pose.radius-previous);
      assert.ok(step<=480*.07*.016+1e-8);
      if(tick>=4 && Math.abs(previous-target)>.54)assert.ok(Math.abs(step-.5376)<1e-8);
      assert.equal(pose.x,first.x);assert.equal(pose.y,first.y);previous=pose.radius;
    }
    assert.equal(previous,target);
  }
});

test('slow accumulated movement crosses the deadband; reacquisition cannot teleport',()=>{
  const follow=start();for(let index=1;index<=12;index++){
    follow.observe([{...hand,x:hand.x+index}],index*20,480);follow.frame(index*20);
  }
  assert.ok(follow.pose.x>hand.x && follow.pose.x<hand.x+12);
  follow.frame(1110);const held={...follow.pose};assert.equal(held.alpha,0);
  for(const now of [1120,1150])follow.observe([{...hand,x:420,y:130,radius:120,label:'Right'}],now,480);
  const resumed=follow.frame(1160);assert.ok(Math.hypot(resumed.x-held.x,resumed.y-held.y)<=480*.4*.04+1e-8);
  assert.ok(Math.abs(resumed.radius-held.radius)<=480*.07*.04+1e-8);
  assert.equal(follow.frame(2300),null);
});

function moving(){
  const follow=start();
  for(let tick=1;tick<=10;tick++){
    follow.observe([{...hand,x:hand.x+4*tick,y:hand.y-3*tick}],20*tick,480);
    follow.frame(20*tick);
  }
  return follow;
}

test('a missing skeleton coasts along the observed diagonal for exactly half a second then fades in place',()=>{
  const follow=moving(),origin={...follow.pose};
  follow.observe([],220,480);
  const halfway={...follow.frame(470)};
  follow.observe([],520,480);
  const end={...follow.frame(720)},fading=follow.frame(820);
  assert.ok(halfway.x>origin.x && halfway.y<origin.y && halfway.alpha===1);
  assert.ok(end.x>halfway.x && end.x-halfway.x<halfway.x-origin.x && end.y<halfway.y);
  assert.equal(end.alpha,1);assert.equal(end.radius,origin.radius);
  assert.equal(fading.x,end.x);assert.equal(fading.y,end.y);assert.equal(fading.alpha,.5);
  assert.equal(follow.frame(920).alpha,0);
  const sparse=moving();sparse.observe([],220,480);assert.equal(sparse.frame(720).x,end.x);
});

test('stationary loss has no drift; a visible fist cancels inertia; regaining a palm does not snap',()=>{
  const still=start();still.frame(20);still.observe([],40,480);
  assert.equal(still.frame(320).x,hand.x);
  const follow=moving();follow.observe([],220,480);const mid={...follow.frame(340)};
  follow.observe([],350,480,false);assert.equal(follow.frame(400).x,mid.x);
  follow.observe([{...hand,x:80}],420,480);const back=follow.frame(430);
  assert.ok(back.x<mid.x && mid.x-back.x<=480*.4*.03+1e-8);
  follow.reset();assert.equal(follow.frame(440),null);
});

test('partial skeletons and empty frames share one brightness deadline, independent of movement',()=>{
  for(const firstMissing of [true,false]){
    const follow=start(),brightness=follow.frame(40).alpha;
    assert.ok(brightness>0 && brightness<1);
    follow.observe([],60,480,firstMissing);
    for(const now of [90,240,380,559,560]){
      follow.observe([],now,480,now%3===0);
      assert.equal(follow.frame(now).alpha,brightness);
    }
    assert.ok(Math.abs(follow.frame(660).alpha-brightness/2)<1e-9);
    assert.equal(follow.frame(760).alpha,0);
  }
});

test('a late first missing packet holds for 500 ms from the detected loss',()=>{
  const follow=moving(),brightness=follow.pose.alpha;
  follow.observe([],800,480);
  assert.equal(follow.frame(1300).alpha,brightness);
  assert.equal(follow.frame(1400).alpha,brightness/2);
  follow.observe([hand],1410,480);assert.ok(follow.frame(1420).alpha>brightness/2);
});
