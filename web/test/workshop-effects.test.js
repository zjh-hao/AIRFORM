import test from 'node:test';
import assert from 'node:assert/strict';
import {Group,Vector3} from 'three';
import {StrokeEngine} from '../src/stroke-engine.js';
import {FlightPath,cometFlights} from '../src/comet.js';
import {palmPose} from '../src/palm-map.js';
import {PalmFollow} from '../src/palm-follow.js';
import {worldHand} from '../test-support/world-hand.js';
import {rgbdHand} from '../test-support/rgbd-hand.js';

test('both palms, distance scaling, palm hovering, translation and a closed hand',()=>{
  for(const label of ['Left','Right']){
    const packet=worldHand({label}), pose=palmPose(packet,0,640,480);
    const follow=new PalmFollow();follow.observe([pose],0,480);
    assert.equal(pose.label,label);assert.equal(pose.measured,false);assert.ok(follow.frame(16).y<packet.landmarks[0][9].y*480);
    assert.ok(palmPose(worldHand({label,root:1}),0,640,480).radius<pose.radius);
    assert.ok(palmPose(worldHand({label,shiftX:.05}),0,640,480).x>pose.x+30);
    for(const tip of [8,12,16,20])packet.worldLandmarks[0][tip]=packet.worldLandmarks[0][tip-3];
    assert.equal(palmPose(packet,0,640,480),null);
  }
});
test('registered palm depth scales the star chart and holes fall back to bones',()=>{
  const pose=(root,mode)=>{const {frame,hand}=rgbdHand({root,mode,ratio:.65});return palmPose({landmarks:[hand],depthFrame:frame},0,640,480);};
  assert.equal(pose(1,'none').measured,false);assert.equal(pose(1,'background').measured,false);assert.equal(pose(1,'palm').measured,true);assert.ok(pose(.8,'palm').radius>pose(1,'palm').radius);
});
test('three comet types follow sampled XYZ by distance and release transient geometry on undo',()=>{
  const points=[new Vector3(),new Vector3(0,0,1),new Vector3(0,3,1)];
  assert.deepEqual(new FlightPath(points).at(.5,new Vector3()).toArray(),[0,1,1]);
  for(const effect of ['ion','aurora','ember']){
    const scene=new Group(),flights=cometFlights(scene),engine=new StrokeEngine(flights.launch,flights.trace);
    engine.beginStroke(points[0],{effect});points.slice(1).forEach(point=>engine.appendPoint(point));
    assert.ok(flights.update(performance.now(),100));assert.equal(scene.children[0].children[0].geometry.attributes.position.getY(0),3);engine.endStroke();
    assert.equal(scene.children.length,1);assert.equal(scene.children[0].children.length,effect==='aurora'?3:1);
    flights.update(performance.now()+600,100);assert.ok(scene.children[0].children[0].geometry.attributes.position.getZ(0)>0);
    engine.undo();flights.update(performance.now()+700,100);assert.equal(scene.children.length,0);assert.ok(engine.redo());engine.dispose();
  }
});
