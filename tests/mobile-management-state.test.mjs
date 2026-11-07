import test from 'node:test';
import assert from 'node:assert/strict';
import {scheduleTiming,schedulePatch,managementOutcome,validateScheduleTiming} from '../android/web/management-state.mjs';

test('text-only edits preserve daily, cron, one-shot and unknown future schedules',()=>{
  for(const kind of ['daily','cron','at','after','every','rrule','future-kind']){
    const existing={kind,title:'Before',prompt:'Keep this instruction',scheduledAt:'2028-11-06T12:00:00Z',target:{kind:'session',sessionId:'test'}};
    assert.deepEqual(schedulePatch({title:'After',prompt:existing.prompt},existing),{title:'After'});
    assert.deepEqual(schedulePatch(existing,existing),{});
  }
});

test('explicit timing edits preserve the DSH field names and weekday values',()=>{
  assert.deepEqual(scheduleTiming({kind:'daily',time:'08:30:00.000',timeZone:'Asia/Shanghai'}),{kind:'daily',daily:{time:'08:30:00.000',time_zone:'Asia/Shanghai'}});
  const weekly={kind:'weekly',time:'09:00',timeZone:'UTC',weekdays:[1,3,5]};
  const timing=scheduleTiming(weekly);assert.deepEqual(timing.weekly.weekdays,[1,3,5]);
  timing.weekly.weekdays.push(7);assert.deepEqual(weekly.weekdays,[1,3,5]);
  assert.deepEqual(scheduleTiming({kind:'cron',expression:'0 9 * * 1',timeZone:'UTC'}),{kind:'cron',cron:{expression:'0 9 * * 1',time_zone:'UTC'}});
  assert.deepEqual(scheduleTiming({kind:'at',scheduledAt:'2028-11-06T12:00:00Z'}),{kind:'at',at:'2028-11-06T12:00:00Z'});
  const rule='DTSTART:20281106T090000Z\nRRULE:FREQ=DAILY';
  assert.deepEqual(scheduleTiming({kind:'rrule',rrule:rule}),{kind:'rrule',rrule:rule});
  const form={title:'Task',prompt:'Content'};
  assert.deepEqual(schedulePatch(form,form,{kind:'every',every_seconds:3600}),{timing:{kind:'every',every_seconds:3600}});
});

test('HTTP 200 business failures and overwritten plugin settings are not reported as applied',()=>{
  for(const value of [{code:'schedule_conflict'},{code:'schedule_not_found'},
    {code:'schedule_execution_pending'},{application:'failed',changed:true,error:{code:'incompatible-version'}},
    {application:'overridden',changed:true},{application:'cancelled'},null,{}]){
    assert.equal(managementOutcome(value).ok,false);
  }
  assert.equal(managementOutcome({application:'overridden',changed:true}).kind,'overridden');
  assert.equal(managementOutcome({application:'restart-required',restartReason:'no-hmr'}).kind,'restart-required');
  assert.equal(managementOutcome({application:'applied',changed:false}).ok,true);
  assert.equal(managementOutcome({id:'test',status:'paused'}).ok,true);
  assert.equal(managementOutcome({deleted:0}).ok,true);
  assert.equal(managementOutcome({status:'cancelled'}).kind,'success');
});

test('new timing fields reject incomplete or non-integral values before a task is created',()=>{
  for(const timing of [{kind:'every',every_seconds:NaN},{kind:'every',every_seconds:59},
    {kind:'after',after_seconds:1.5},{kind:'weekly',weekly:{time:'09:00',time_zone:'UTC',weekdays:[]}},
    {kind:'at',at:{date:'',time:'09:00',time_zone:'UTC'}},{kind:'cron',cron:{expression:'0 9 * *',time_zone:'UTC'}},
    {kind:'rrule',rrule:'RRULE:FREQ=DAILY'}])assert.throws(()=>validateScheduleTiming(timing));
  for(const timing of [{kind:'after',after_seconds:10},{kind:'every',every_seconds:90},
    {kind:'daily',daily:{time:'09:00:00.000',time_zone:'Asia/Shanghai'}},
    {kind:'at',at:'2028-11-06T09:00:00Z'},
    {kind:'weekly',weekly:{time:'09:00',time_zone:'UTC',weekdays:[1,5]}},
    {kind:'cron',cron:{expression:'0 9 * * *',time_zone:'UTC'}},
    {kind:'rrule',rrule:'DTSTART:20281106T090000Z\nRRULE:FREQ=DAILY'}])assert.equal(validateScheduleTiming(timing),timing);
});
