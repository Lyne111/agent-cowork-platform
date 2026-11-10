import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '../../packages/core/src/index.js';
import type { Task, Run } from '../../packages/protocol/src/index.js';

function fixture(t: test.TestContext) {
  const dir=mkdtempSync(join(tmpdir(),'agent-cowork-core-'));let core=new Core(join(dir,'state.sqlite'));
  t.after(()=>{core.close();rmSync(dir,{recursive:true,force:true});});
  const project=core.addProject({name:'Example',path:join(dir,'repo'),baseCommit:'a'.repeat(40)});
  let n=0;const req=()=>`request-${++n}`;
  const task=(reviewerIds:string[]=[])=>core.createTask({requestId:req(),projectId:project.id,title:'Export CSV',goal:'Add CSV export',criteria:'Unicode and filter tests pass',ownerId:'codex-implementer',reviewerIds});
  const queue=(task:Task,path=join(dir,task.id))=>core.enqueueTask({requestId:req(),taskId:task.id,expectedVersion:core.getTask(task.id).version,workspacePath:path});
  const finish=(run:Run)=>core.confirmResult({runId:run.id,status:'succeeded',evidence:'Native turn completed normally; captured transport result.'});
  const artifact=(run:Run)=>core.addArtifact({runId:run.id,path:join(dir,'artifacts',run.id),hash:'b'.repeat(64),files:[{path:'export.ts',sha256:'c'.repeat(64),size:100}],summary:'CSV export implementation',diff:'+export function csv() {}',baseCommit:project.baseCommit});
  return {get core(){return core;},dir,project,req,task,queue,finish,artifact,restart(){core.close();core=new Core(join(dir,'state.sqlite'));return core;}};
}

test('stable requests deduplicate across restart and reject payload reuse; invalid command rolls back',t=>{
  const f=fixture(t);const input={requestId:f.req(),projectId:f.project.id,title:'One',goal:'Goal',criteria:'Criteria',ownerId:'codex-implementer'};
  const first=f.core.createTask(input);f.restart();assert.deepEqual(f.core.createTask(input),first);
  assert.throws(()=>f.core.createTask({...input,title:'Changed'}),{code:'REQUEST_CONFLICT'});
  assert.throws(()=>f.core.createTask({...input,requestId:f.req(),ownerId:'missing'}),{code:'NOT_FOUND'});
  assert.equal(f.core.snapshot().tasks.length,1);assert.equal(f.core.snapshot().commands.length,1);
});

test('dispatch outbox and run survive restart; uncertain send is never repeated',t=>{
  const f=fixture(t);const task=f.task();const run=f.queue(task);
  assert.equal(f.core.snapshot().commands.find(c=>c.runId===run.id)?.status,'pending');
  f.restart();assert.equal(f.core.getRun(run.id).status,'queued');assert.equal(f.core.claimNext()?.id,run.id);
  f.restart();assert.equal(f.core.getRun(run.id).status,'unverified');assert.equal(f.core.getTask(task.id).frozen,true);
  assert.equal(f.core.claimNext(),null);assert.equal(f.core.snapshot().commands.find(c=>c.runId===run.id)?.status,'unverified');
  assert.throws(()=>f.core.reworkTask({requestId:f.req(),taskId:task.id,expectedVersion:f.core.getTask(task.id).version}),{code:'RUN_ACTIVE'});
});

test('one writer per task and per workspace, including unverified execution',t=>{
  const f=fixture(t);const task=f.task();const run=f.queue(task,join(f.dir,'shared'));
  assert.throws(()=>f.queue(task),{code:'FLOW_LIMIT'});
  assert.throws(()=>f.queue(f.task(),run.workspacePath),{code:'WORKSPACE_BUSY'});
  f.core.claimNext();f.restart();assert.throws(()=>f.queue(f.task(),run.workspacePath),{code:'WORKSPACE_BUSY'});
});

test('pause persists; disabling a profile blocks queued sends without rewriting its snapshot',t=>{
  const f=fixture(t);const run=f.queue(f.task());f.core.setPaused(true);f.restart();assert.equal(f.core.claimNext(),null);
  const profile=f.core.getProfile(run.profileId);f.core.saveProfile({...profile,enabled:false,expectedVersion:profile.version});f.core.setPaused(false);assert.equal(f.core.claimNext(),null);
  const disabled=f.core.getProfile(run.profileId);f.core.saveProfile({...disabled,enabled:true,model:'new-model',expectedVersion:disabled.version});
  const claimed=f.core.claimNext()!;assert.equal(claimed.context.profile.model,null);assert.equal(claimed.profileVersion,1);assert.equal(claimed.model,null);
});

test('two dispatchers cannot claim a run twice, and paused commands stay queued',t=>{
  const f=fixture(t);const run=f.queue(f.task());const second=new Core(join(f.dir,'state.sqlite'),{recover:false});
  try { assert.equal(f.core.claimNext()?.id,run.id);assert.equal(second.claimNext(),null);f.core.setPaused(true);const later=f.queue(f.task());assert.equal(second.claimNext(),null);assert.equal(second.getRun(later.id).status,'queued'); }
  finally {second.close();}
});

test('AI statements cannot assert tool success; terminal state and events are monotonic',t=>{
  const f=fixture(t);const task=f.task();const run=f.queue(task);f.core.claimNext();
  assert.throws(()=>f.core.recordEvent({id:'fake',runId:run.id,type:'result',source:'agent',text:'done',status:'succeeded',evidence:'I say done'}),{code:'INVALID_SOURCE'});
  assert.equal(f.core.eventsAfter(0).some(e=>e.id==='fake'),false);
  assert.throws(()=>f.core.recordEvent({id:'no-evidence',runId:run.id,type:'result',source:'tool',text:'done',status:'succeeded'}),{code:'EVIDENCE_REQUIRED'});
  f.finish(run);assert.equal(f.core.getTask(task.id).status,'blocked'); // A normal end is not an artifact.
  const event={id:'late',runId:run.id,type:'progress',source:'tool' as const,text:'Late progress',status:'running' as const};
  const stored=f.core.recordEvent(event);assert.deepEqual(f.core.recordEvent(event),stored);assert.equal(f.core.getRun(run.id).status,'succeeded');
  assert.throws(()=>f.core.recordEvent({...event,text:'Changed'}),{code:'EVENT_CONFLICT'});
});

test('stop freezes dispatch, retains locks until tool confirmation, and prevents late artifacts',t=>{
  const f=fixture(t);const task=f.task();const run=f.queue(task,join(f.dir,'shared'));f.core.claimNext();
  const approval=f.core.addApproval({runId:run.id,nativeId:'permission-1',kind:'command',prompt:'Run tests?',options:['allow','deny']});
  assert.equal(f.core.requestStop(task.id).length,1);assert.equal(f.core.getRun(run.id).status,'stopping');
  assert.equal(f.core.snapshot().approvals.find(a=>a.id===approval.id)?.status,'expired');
  assert.throws(()=>f.core.answerApproval(approval.id,'allow'),{code:'REQUEST_EXPIRED'});
  assert.throws(()=>f.queue(f.task(),run.workspacePath),{code:'WORKSPACE_BUSY'});
  f.core.confirmResult({runId:run.id,status:'stopped',evidence:'Native interrupt completed; descendants ended.'});
  assert.equal(f.core.getTask(task.id).status,'blocked');f.queue(f.task(),run.workspacePath);
  const lateTask=f.task();const lateRun=f.queue(lateTask);f.core.claimNext();f.core.claimNext();
  f.core.requestStop(lateTask.id);f.finish(lateRun);assert.throws(()=>f.artifact(lateRun),{code:'STALE_RUN'});
});

test('cancel intent stays blocked until original execution ends; unsent runs cancel immediately',t=>{
  const f=fixture(t);const task=f.task();const run=f.queue(task);f.core.claimNext();f.core.requestStop(task.id,true);
  assert.equal(f.core.getTask(task.id).status,'blocked');f.core.confirmResult({runId:run.id,status:'stopped',evidence:'Confirmed process exit'});assert.equal(f.core.getTask(task.id).status,'cancelled');
  const queuedTask=f.task();const queued=f.queue(queuedTask);f.core.requestStop(queuedTask.id,true);assert.equal(f.core.getRun(queued.id).status,'stopped');assert.equal(f.core.getTask(queuedTask.id).status,'cancelled');
});

test('fixed artifact reviews lead to user-only acceptance; model objections are preserved',t=>{
  const f=fixture(t);const task=f.task(['harness-reviewer','antigravity-checker']);const run=f.queue(task);f.core.claimNext();f.finish(run);const artifact=f.artifact(run);
  assert.equal(f.core.getTask(task.id).status,'running');
  for(const profileId of task.reviewerIds) {
    const review=f.core.enqueueReview({requestId:f.req(),taskId:task.id,profileId,artifactId:artifact.id,workspacePath:join(f.dir,profileId)});assert.equal(review.context.artifactId,artifact.id);assert.equal(review.context.decisions.length,0);f.core.claimNext();f.finish(review);
    f.core.addReview({runId:review.id,artifactId:artifact.id,verdict:'changes_requested',text:'Check quoted fields before accepting.'});
  }
  const ready=f.core.getTask(task.id);assert.equal(ready.status,'awaiting_acceptance');
  const input={requestId:f.req(),taskId:task.id,artifactId:artifact.id,expectedVersion:ready.version};
  assert.throws(()=>f.core.acceptTask(input,'agent'),{code:'FORBIDDEN'});
  const accepted=f.core.acceptTask(input);assert.deepEqual(f.core.acceptTask(input),accepted);assert.equal(f.core.getTask(task.id).status,'completed');assert.equal(f.core.snapshot().reviews.length,2);
});

test('rework invalidates old pages and events; review skips require an explicit user record',t=>{
  const f=fixture(t);const task=f.task(['harness-reviewer']);const run=f.queue(task);f.core.claimNext();f.finish(run);const oldArtifact=f.artifact(run);
  f.core.skipReview({taskId:task.id,profileId:'harness-reviewer',artifactId:oldArtifact.id,reason:'Manual review performed separately',expectedVersion:f.core.getTask(task.id).version});
  const oldPage=f.core.getTask(task.id);assert.equal(oldPage.status,'awaiting_acceptance');
  const rework=f.core.reworkTask({requestId:f.req(),taskId:task.id,expectedVersion:oldPage.version});const next=f.queue(rework);f.core.claimNext();
  f.core.recordEvent({id:'stale-success',runId:run.id,type:'result',source:'tool',text:'old completed',status:'succeeded',evidence:'old native end'});
  assert.equal(f.core.getTask(task.id).status,'running');assert.equal(f.core.getRun(next.id).status,'sending');
  assert.throws(()=>f.core.acceptTask({requestId:f.req(),taskId:task.id,artifactId:oldArtifact.id,expectedVersion:oldPage.version}),{code:'STALE_VERSION'});
  assert.equal(f.core.snapshot().reviews[0]?.skipped,true);
});

test('scoped rule revisions do not leak through reusable roles or mutate active contexts',t=>{
  const f=fixture(t);const other=f.core.addProject({name:'Other',path:join(f.dir,'other'),baseCommit:'d'.repeat(40)});
  f.core.saveRule({scope:'global',kind:'rule',content:'Use evidence.',confirmed:true});
  const local=f.core.saveRule({scope:'role',profileId:'codex-implementer',projectId:f.project.id,kind:'experience',content:'Private project detail.',confirmed:true});
  assert.throws(()=>f.core.saveRule({scope:'global',kind:'rule',content:'unapproved',confirmed:false}),{code:'CONFIRMATION_REQUIRED'});
  const run=f.queue(f.task());f.core.saveRule({id:local.id,expectedVersion:local.version,scope:'role',profileId:'codex-implementer',projectId:f.project.id,kind:'experience',content:'Updated project detail.',confirmed:true});
  assert.equal(f.core.getRun(run.id).context.rules.find(r=>r.id===local.id)?.content,'Private project detail.');
  const task=f.core.createTask({requestId:f.req(),projectId:other.id,title:'Other task',goal:'Goal',criteria:'Criteria',ownerId:'codex-implementer'});const another=f.queue(task);
  assert.equal(another.context.rules.length,1);assert.equal(another.context.rules[0]?.scope,'global');
});

test('native request deduplication, answer types, actor checks and stale request expiry',t=>{
  const f=fixture(t);const run=f.queue(f.task());f.core.claimNext();
  const approvalInput={runId:run.id,nativeId:'p1',kind:'file_change',prompt:'Apply patch?',options:['allow_once','deny']};const approval=f.core.addApproval(approvalInput);assert.equal(f.core.addApproval(approvalInput).id,approval.id);
  assert.throws(()=>f.core.answerApproval(approval.id,'yes'),{code:'INVALID_ANSWER'});assert.throws(()=>f.core.answerApproval(approval.id,'allow_once','agent'),{code:'FORBIDDEN'});
  f.core.answerApproval(approval.id,'deny');assert.throws(()=>f.core.answerApproval(approval.id,'allow_once'),{code:'REQUEST_EXPIRED'});
  const question=f.core.addQuestion({runId:run.id,nativeId:'q1',prompt:'Which delimiter?'});f.core.answerQuestion(question.id,'Comma');
  const pending=f.core.addQuestion({runId:run.id,nativeId:'q2',prompt:'Continue?'});f.restart();assert.equal(f.core.snapshot().questions.find(q=>q.id===pending.id)?.status,'expired');assert.throws(()=>f.core.answerQuestion(pending.id,'yes'),{code:'REQUEST_EXPIRED'});
});

test('verified recovery can track the original run while explicit stop freezes remain intact',t=>{
  const f=fixture(t);const task=f.task();const run=f.queue(task);f.core.claimNext();
  f.core.recordEvent({id:'accepted-session',runId:run.id,type:'accepted',source:'tool',text:'Native accepted',status:'accepted',nativeSessionId:'session-original'});f.restart();
  assert.throws(()=>f.core.reconcileRun({runId:run.id,status:'running',evidence:'Inspected live session',nativeSessionId:'different'}),{code:'IDENTITY_MISMATCH'});
  f.core.reconcileRun({runId:run.id,status:'running',evidence:'Inspected original live session',nativeSessionId:'session-original'});assert.equal(f.core.getTask(task.id).frozen,false);
  f.core.requestStop(task.id);f.restart();assert.equal(f.core.getRun(run.id).status,'unverified');
  f.core.reconcileRun({runId:run.id,status:'running',evidence:'Original process is still running',nativeSessionId:'session-original'});assert.equal(f.core.getTask(task.id).frozen,true);assert.equal(f.core.getTask(task.id).freezeReason,'stop');
});

test('registering a new Git baseline preserves existing project and task snapshots',t=>{
  const f=fixture(t);const task=f.task();const run=f.queue(task);
  assert.equal(f.core.addProject({name:'Same project',path:f.project.path,baseCommit:f.project.baseCommit}).id,f.project.id);
  const updated=f.core.addProject({name:'New baseline',path:f.project.path,baseCommit:'e'.repeat(40)});
  assert.notEqual(updated.id,f.project.id);assert.equal(f.core.getTask(task.id).projectId,f.project.id);assert.equal(f.core.getRun(run.id).context.project.baseCommit,'a'.repeat(40));assert.equal(f.core.snapshot().projects.length,2);
});
