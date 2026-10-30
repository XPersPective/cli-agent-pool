import test from 'node:test';
import assert from 'node:assert/strict';
import { dismissOnBackdrop } from '../web/dialogs.js';
import { rejectionReason, noRouteMessage } from '../src/routing.js';

test('backdrop dismissal ignores clicks and drags originating inside the dialog',()=>{
 class Dialog extends EventTarget { closed=0; getBoundingClientRect(){return {left:100,top:100,right:300,bottom:300};}close(){this.closed++;this.dispatchEvent(new Event('close'));} }
 const dialog=new Dialog();dismissOnBackdrop(dialog);
 const send=(type,x,y)=>{const event=new Event(type);Object.assign(event,{clientX:x,clientY:y,button:0});dialog.dispatchEvent(event);};
 send('pointerdown',150,150);send('click',150,150);assert.equal(dialog.closed,0);
 send('pointerdown',150,150);send('click',20,20);assert.equal(dialog.closed,0);
 send('pointerdown',20,20);send('click',20,20);assert.equal(dialog.closed,1);
 send('click',20,20);assert.equal(dialog.closed,1);
});

test('routing explains kind, quota, fixed effort and policy rejection without relaxing admission',()=>{
 const route={adapter:'codex',billing:'subscription',minRemainingPercent:10};
 const model={enabled:true,billing:'subscription',autoSelect:true,kinds:['text','read'],efforts:['high'],fixedEffort:'high',id:'model'};
 assert.equal(rejectionReason(model,route,null,{kind:'write',mode:'execute'}),'KIND_UNSUPPORTED');
 assert.equal(rejectionReason(model,route,null,{kind:'read',effort:'low'}),'FIXED_EFFORT');
 assert.equal(rejectionReason(model,route,{status:'available',observedAt:new Date().toISOString(),windows:[{remainingPercent:5}]},{kind:'read'}),'QUOTA_RESERVE');
 assert.equal(rejectionReason({...model,autoSelect:false},route,null,{kind:'read'}),'AUTOSELECT_DISABLED');
 assert.equal(rejectionReason({...model,autoSelect:false},route,null,{kind:'read',routeId:'explicit'}),null);
 assert.match(noRouteMessage({group:'low',mode:'execute'},new Map([['KIND_UNSUPPORTED',3]])),/low.*yazma yeteneği yok/);
 assert.match(noRouteMessage({group:'medium'},new Map()),/üyeliği bulunamadı/);
});
