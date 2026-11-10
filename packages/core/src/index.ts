import { randomUUID } from 'node:crypto';
import type { Acceptance, Approval, Artifact, ArtifactFile, Command, ContextSnapshot, Event, Project, Provider, Question, Review, RoleProfile, RuleRevision, Run, RunEventInput, RunRole, RunStatus, Snapshot, Task } from '../../protocol/src/index.js';
import { Store } from './store.js';
import { assert, DomainError, hash, terminal, text, transitions } from './guards.js';
export { DomainError } from './guards.js';
export type * from '../../protocol/src/index.js';
const now = () => new Date().toISOString();
const id = () => randomUUID();
const providers: Provider[] = ['codex','antigravity','deepseek-harness'];

export class Core {
  private readonly store: Store;
  constructor(path: string, options: { recover?: boolean } = {}) {
    this.store = new Store(path);
    this.seedProfiles();
    if (options.recover !== false) this.recover();
  }
  close(): void { this.store.close(); }
  snapshot(): Snapshot {
    return { projects:this.store.all('projects'),profiles:this.store.all('profiles'),rules:this.store.all('rules'),tasks:this.store.all('tasks'),runs:this.store.all('runs'),commands:this.store.all('commands'),events:this.store.eventsAfter(0),artifacts:this.store.all('artifacts'),reviews:this.store.all('reviews'),approvals:this.store.all('approvals'),questions:this.store.all('questions'),acceptances:this.store.all('acceptances'),paused:this.store.setting('paused',false) };
  }
  getTask(taskId: string): Task { return this.required<Task>('tasks',taskId); }
  getRun(runId: string): Run { return this.required<Run>('runs',runId); }
  getProject(projectId: string): Project { return this.required<Project>('projects',projectId); }
  getProfile(profileId: string): RoleProfile { return this.required<RoleProfile>('profiles',profileId); }
  getArtifact(artifactId: string): Artifact { return this.required<Artifact>('artifacts',artifactId); }
  eventsAfter(seq: number): Event[] { assert(Number.isSafeInteger(seq)&&seq>=0,'INVALID_INPUT','Invalid event sequence.',400); return this.store.eventsAfter(seq); }

  addProject(input: { name: string; path: string; baseCommit: string }): Project {
    return this.store.transaction(() => {
      const path = text(input.path,'Project path');
      const existing = this.store.all<Project>('projects').find(p=>this.workspaceKey(p.path)===this.workspaceKey(path)&&p.baseCommit===input.baseCommit);
      if (existing) return existing;
      assert(/^[a-f0-9]{40,64}$/i.test(input.baseCommit),'INVALID_BASE','A full committed Git baseline is required.',400);
      return this.store.put('projects',{id:id(),name:text(input.name,'Project name',200),path,baseCommit:input.baseCommit,createdAt:now()});
    });
  }
  saveProfile(input: { id?: string; name: string; role: RoleProfile['role']; provider: Provider; model?: string | null; instructions?: string; enabled?: boolean; expectedVersion?: number }): RoleProfile {
    return this.store.transaction(() => {
      assert(providers.includes(input.provider),'INVALID_PROVIDER','Unknown provider.',400);
      assert(['implementer','reviewer','acceptance'].includes(input.role),'INVALID_ROLE','Unknown role.',400);
      const previous = input.id ? this.required<RoleProfile>('profiles',input.id) : undefined;
      if (previous) assert(input.expectedVersion===previous.version,'STALE_VERSION','Profile changed; refresh before saving.');
      const profile: RoleProfile = {id:previous?.id??id(),version:(previous?.version??0)+1,name:text(input.name,'Profile name',100),role:input.role,provider:input.provider,model:input.model??null,instructions:input.instructions??'',enabled:input.enabled??previous?.enabled??true,createdAt:previous?.createdAt??now(),updatedAt:now()};
      assert(profile.instructions.length<=100_000,'INVALID_INPUT','Role instructions are too long.',400);
      return this.store.put('profiles',profile);
    });
  }
  saveRule(input: { id?: string; scope: RuleRevision['scope']; projectId?: string | null; profileId?: string | null; kind: RuleRevision['kind']; content: string; source?: string; confirmed: boolean; expectedVersion?: number }): RuleRevision {
    return this.store.transaction(() => {
      assert(input.confirmed===true,'CONFIRMATION_REQUIRED','Only user-confirmed rules can become active.',400);
      assert(['global','project','role'].includes(input.scope),'INVALID_SCOPE','Unknown rule scope.',400);
      assert(['rule','preference','fact','experience'].includes(input.kind),'INVALID_KIND','Unknown rule kind.',400);
      const previous = input.id ? this.store.all<RuleRevision>('rules').filter(r=>r.id===input.id).at(-1) : undefined;
      if (input.id) assert(previous,'NOT_FOUND','Rule not found.',404);
      if (previous) assert(input.expectedVersion===previous.version,'STALE_VERSION','Rule changed; refresh before saving.');
      const projectId=input.projectId??null; const profileId=input.profileId??null;
      if (projectId) this.getProject(projectId);
      if (profileId) this.getProfile(profileId);
      if(input.scope==='project') assert(projectId&&!profileId,'INVALID_SCOPE','Project rules need a project only.',400);
      if(input.scope==='role') assert(profileId,'INVALID_SCOPE','Role rules need a profile.',400);
      if(input.scope==='global') assert(!projectId&&!profileId,'INVALID_SCOPE','Global rules cannot carry project or role restrictions.',400);
      return this.store.put('rules',{id:previous?.id??id(),revisionId:id(),version:(previous?.version??0)+1,scope:input.scope,projectId,profileId,kind:input.kind,content:text(input.content,'Rule content'),source:input.source??'User entered',confirmed:true,createdAt:now()});
    });
  }
  createTask(input: { requestId: string; projectId: string; title: string; goal: string; criteria: string; ownerId: string; reviewerIds?: string[] }): Task {
    return this.command('create_task',input,()=>{
      this.getProject(input.projectId); const owner=this.getProfile(input.ownerId);
      assert(owner.enabled,'PROFILE_DISABLED','Owner profile is disabled.');
      const reviewerIds=[...new Set(input.reviewerIds??[])];
      assert(reviewerIds.length<=2&&!reviewerIds.includes(input.ownerId),'INVALID_REVIEWERS','Choose up to two distinct reviewers other than the owner.',400);
      for (const reviewer of reviewerIds) assert(this.getProfile(reviewer).enabled,'PROFILE_DISABLED','Reviewer profile is disabled.');
      const task:Task={id:id(),projectId:input.projectId,title:text(input.title,'Task title',200),goal:text(input.goal,'Goal'),criteria:text(input.criteria,'Acceptance criteria'),ownerId:input.ownerId,reviewerIds,ownerGeneration:1,version:1,flow:1,status:'pending',frozen:false,freezeReason:null,cancelRequested:false,artifactId:null,createdAt:now(),updatedAt:now()};
      this.store.put('tasks',task);this.log(task,'task.created','user',task.title);return task;
    });
  }
  enqueueTask(input: { requestId: string; taskId: string; expectedVersion: number; workspacePath: string }): Run {
    return this.command('enqueue_task',input,()=>{
      const task=this.getTask(input.taskId); this.version(task,input.expectedVersion);
      assert(!['completed','cancelled'].includes(task.status)&&!task.frozen,'TASK_FROZEN','Task cannot be dispatched.');
      assert(!this.taskRuns(task.id).some(r=>r.flow===task.flow&&r.role==='implement'),'FLOW_LIMIT','This flow already has an implementation. Explicit rework is required.');
      assert(!this.taskRuns(task.id).some(r=>!terminal(r.status)),'RUN_ACTIVE','An earlier execution is still active or unverified.');
      const run=this.newRun(task,task.ownerId,'implement',text(input.workspacePath,'Workspace path'),null);
      this.bump(task,{status:'running'});return run;
    });
  }
  enqueueReview(input: { requestId: string; taskId: string; profileId: string; artifactId: string; workspacePath: string }): Run {
    return this.command('enqueue_review',input,()=>{
      const task=this.getTask(input.taskId); const artifact=this.getArtifact(input.artifactId);
      assert(!task.frozen&&!['completed','cancelled'].includes(task.status),'TASK_FROZEN','Task cannot dispatch review.');
      assert(artifact.taskId===task.id&&task.artifactId===artifact.id,'STALE_ARTIFACT','Review must target the current fixed artifact.');
      assert(task.reviewerIds.includes(input.profileId),'NOT_ASSIGNED','Reviewer was not assigned to this task.',403);
      assert(!this.store.all<Review>('reviews').some(r=>r.artifactId===artifact.id&&r.profileId===input.profileId),'REVIEW_EXISTS','This reviewer has already reviewed or explicitly skipped this artifact.');
      assert(!this.taskRuns(task.id).some(r=>r.flow===task.flow&&r.role==='review'&&r.profileId===input.profileId),'FLOW_LIMIT','Reviewer already has an execution in this flow.');
      assert(this.taskRuns(task.id).filter(r=>r.flow===task.flow&&r.role==='review').length<2,'FLOW_LIMIT','Review limit reached.');
      return this.newRun(task,input.profileId,'review',text(input.workspacePath,'Review workspace'),artifact.id);
    });
  }
  claimNext(): Run | null {
    return this.store.transaction(()=>{
      if(this.store.setting('paused',false)) return null;
      for(const run of this.store.all<Run>('runs').filter(r=>r.status==='queued')) {
        const task=this.getTask(run.taskId); const profile=this.getProfile(run.profileId);
        if(task.frozen||task.cancelRequested||['completed','cancelled'].includes(task.status)||!profile.enabled) continue;
        if(run.flow!==task.flow||run.ownerGeneration!==task.ownerGeneration) continue;
        const claimed={...run,status:'sending' as const,updatedAt:now()};this.store.put('runs',claimed);
        this.commandStatus(run.id,'sending');this.log(task,'run.sending','system','Dispatch started.',run.id);return claimed;
      }
      return null;
    });
  }
  recordEvent(input: RunEventInput): Event {
    return this.store.transaction(()=>{
      const previous=this.store.eventById(text(input.id,'Event id',300));
      if(previous) { assert(previous.payloadHash===hash(input),'EVENT_CONFLICT','Event id was reused with different content.');return previous; }
      let run=this.getRun(input.runId); const task=this.getTask(run.taskId);
      assert(['agent','tool','system'].includes(input.source),'INVALID_SOURCE','Run events cannot impersonate the user.',403);
      const event=this.log(task,text(input.type,'Event type',200),input.source,input.text,run.id,input.id,input.nativeId??null,hash(input));
      const stale=run.flow!==task.flow||run.ownerGeneration!==task.ownerGeneration;
      if(stale||terminal(run.status)) return event; // Retain late evidence without changing current state.
      const next=input.status;
      if(next) assert(input.source==='tool'||(input.source==='system'&&next==='unverified'),'INVALID_SOURCE','Only tool evidence can advance execution status.',403);
      if(next&&next!==run.status) {
        assert(transitions[run.status].includes(next),'INVALID_TRANSITION',`Cannot move execution from ${run.status} to ${next}.`);
        if(terminal(next)) assert(input.source==='tool'&&typeof input.evidence==='string'&&input.evidence.trim().length>0,'EVIDENCE_REQUIRED','A verified tool result is required for terminal status.');
        if(run.status==='stopping'&&next!=='unverified') assert(terminal(next),'STOP_PENDING','Stop is still pending.');
      }
      if(input.usage) assert(input.source==='tool'&&[input.usage.inputTokens,input.usage.outputTokens].every(n=>n===undefined||(Number.isFinite(n)&&n>=0)),'INVALID_USAGE','Usage needs nonnegative tool-provided counts.',400);
      run={...run,status:next??run.status,nativeSessionId:input.nativeSessionId??run.nativeSessionId,nativeTurnId:input.nativeTurnId??run.nativeTurnId,evidence:input.evidence??run.evidence,usage:input.usage??run.usage,error:next==='failed'?input.text:run.error,updatedAt:now()};
      this.store.put('runs',run);
      if(['accepted','running','waiting_user'].includes(run.status)) this.commandStatus(run.id,'accepted');
      if(run.status==='unverified') {this.commandStatus(run.id,'unverified');this.bump(task,{frozen:true,freezeReason:task.freezeReason??'recovery',status:'blocked'});}
      if(terminal(run.status)) {this.commandStatus(run.id,'finished');this.expireRequests(run.id);}
      this.refreshTask(task.id);return event;
    });
  }
  confirmResult(input: { runId: string; status: 'succeeded'|'failed'|'stopped'; evidence: string; text?: string; eventId?: string }): Run {
    this.recordEvent({id:input.eventId??id(),runId:input.runId,type:'run.result',source:'tool',text:input.text??input.status,status:input.status,evidence:input.evidence});return this.getRun(input.runId);
  }
  requestStop(taskId: string, cancel=false): Run[] {
    return this.store.transaction(()=>{
      const task=this.getTask(taskId);assert(task.status!=='completed','TASK_COMPLETED','Completed task cannot be stopped.');
      this.bump(task,{frozen:true,freezeReason:'stop',cancelRequested:cancel||task.cancelRequested,status:'blocked'});
      for(const run of this.taskRuns(taskId).filter(r=>!terminal(r.status))) {
        this.expireRequests(run.id);
        if(run.status==='queued') {this.store.put('runs',{...run,status:'stopped',evidence:'Cancelled before dispatch; no native operation was sent.',updatedAt:now()});this.commandStatus(run.id,'cancelled');this.expireRequests(run.id);}
        else if(run.status!=='unverified') this.store.put('runs',{...run,status:'stopping',updatedAt:now()});
      }
      this.log(task,cancel?'task.cancel_requested':'task.stop_requested','user','Future dispatch frozen; waiting for execution stop evidence.');this.refreshTask(taskId);
      return this.taskRuns(taskId).filter(r=>!terminal(r.status));
    });
  }
  setPaused(paused: boolean): boolean { assert(typeof paused==='boolean','INVALID_INPUT','paused must be boolean.',400);return this.store.transaction(()=>{this.store.setSetting('paused',paused);return paused;}); }
  stopAll(): Run[] { return this.store.transaction(()=>{this.setPaused(true);return this.store.all<Task>('tasks').filter(t=>!['completed','cancelled'].includes(t.status)).flatMap(t=>this.requestStop(t.id));}); }
  recover(): number {
    return this.store.transaction(()=>{
      const affected=this.store.all<Run>('runs').filter(r=>!terminal(r.status)&&r.status!=='queued'&&r.status!=='unverified');
      for(const run of affected) {
        this.store.put('runs',{...run,status:'unverified',updatedAt:now()});this.commandStatus(run.id,'unverified');
        const task=this.getTask(run.taskId);this.bump(task,{frozen:true,freezeReason:task.freezeReason??'recovery',status:'blocked'});this.expireRequests(run.id);
        this.log(this.getTask(run.taskId),'run.recovery_required','system','Service restarted. Original execution must be inspected; dispatch will not be repeated.',run.id);
      }
      return affected.length;
    });
  }
  reconcileRun(input:{runId:string;status:'running'|'waiting_user'|'succeeded'|'failed'|'stopped';evidence:string;nativeSessionId?:string;nativeTurnId?:string}):Run {
    return this.store.transaction(()=>{
      const run=this.getRun(input.runId);assert(run.status==='unverified','NOT_UNVERIFIED','Only uncertain executions can be reconciled.');
      text(input.evidence,'Inspection evidence');
      if(run.nativeSessionId&&input.nativeSessionId)assert(run.nativeSessionId===input.nativeSessionId,'IDENTITY_MISMATCH','Inspection belongs to another native session.');
      if(run.nativeTurnId&&input.nativeTurnId)assert(run.nativeTurnId===input.nativeTurnId,'IDENTITY_MISMATCH','Inspection belongs to another native turn.');
      this.recordEvent({id:id(),runId:run.id,type:'run.reconciled',source:'tool',text:input.evidence,status:input.status,evidence:input.evidence,nativeSessionId:input.nativeSessionId,nativeTurnId:input.nativeTurnId});
      const task=this.getTask(run.taskId);
      if(task.freezeReason==='recovery'&&!task.cancelRequested&&!this.taskRuns(task.id).some(r=>r.status==='unverified'))this.bump(task,{frozen:false,freezeReason:null});
      this.refreshTask(task.id);return this.getRun(run.id);
    });
  }
  addArtifact(input: { runId: string; path: string; hash: string; files: ArtifactFile[]; summary: string; diff: string; baseCommit: string }): Artifact {
    return this.store.transaction(()=>{
      const run=this.getRun(input.runId); const task=this.getTask(run.taskId);
      assert(run.role==='implement'&&run.status==='succeeded','RUN_NOT_SUCCESSFUL','Only successful implementation runs can deliver an artifact.');
      assert(run.flow===task.flow&&run.ownerGeneration===task.ownerGeneration&&!task.frozen,'STALE_RUN','Execution no longer owns this task.');
      assert(!this.store.all<Artifact>('artifacts').some(a=>a.runId===run.id),'ARTIFACT_EXISTS','Artifact is already saved for this execution.');
      assert(/^[a-f0-9]{64}$/i.test(input.hash)&&input.files.length>0,'INVALID_ARTIFACT','Artifact needs a SHA-256 hash and checked files.',400);
      assert(input.files.every(file=>typeof file.path==='string'&&!/^(?:[a-z]:|[\\/])/i.test(file.path)&&!file.path.split(/[\\/]/).includes('..')&&/^[a-f0-9]{64}$/i.test(file.sha256)&&Number.isSafeInteger(file.size)&&file.size>=0),'INVALID_ARTIFACT','Artifact files need relative paths, verified hashes and sizes.',400);
      assert(input.baseCommit===run.context.project.baseCommit,'INVALID_BASE','Artifact baseline differs from the execution snapshot.');
      const artifact:Artifact={...input,id:id(),taskId:task.id,projectId:task.projectId,version:this.store.all<Artifact>('artifacts').filter(a=>a.taskId===task.id).length+1,createdAt:now()};
      this.store.put('artifacts',artifact);this.bump(task,{artifactId:artifact.id});this.log(task,'artifact.saved','tool',input.summary,run.id);this.refreshTask(task.id);return artifact;
    });
  }
  addReview(input: { runId: string; artifactId: string; verdict: Review['verdict']; text: string }): Review {
    return this.store.transaction(()=>{
      const run=this.getRun(input.runId);const task=this.getTask(run.taskId);
      assert(run.role==='review'&&run.status==='succeeded','RUN_NOT_SUCCESSFUL','Review requires a successful review execution.');
      assert(input.artifactId===run.artifactId&&task.artifactId===input.artifactId&&run.flow===task.flow&&!task.frozen,'STALE_ARTIFACT','Review does not match the active artifact.');
      assert(['pass','changes_requested'].includes(input.verdict),'INVALID_REVIEW','Unknown review verdict.',400);
      assert(!this.store.all<Review>('reviews').some(r=>r.runId===run.id),'REVIEW_EXISTS','Review was already submitted.');
      const review:Review={...input,text:text(input.text,'Review'),id:id(),taskId:task.id,profileId:run.profileId,createdAt:now()};this.store.put('reviews',review);this.log(task,'review.saved','agent',review.text,run.id);this.refreshTask(task.id);return review;
    });
  }
  skipReview(input: {taskId:string;profileId:string;artifactId:string;reason:string;expectedVersion:number},actor='user'):Review {
    return this.store.transaction(()=>{
      this.user(actor);const task=this.getTask(input.taskId);this.version(task,input.expectedVersion);
      assert(task.artifactId===input.artifactId&&task.reviewerIds.includes(input.profileId)&&!task.frozen,'STALE_ARTIFACT','Review is not current.');
      assert(!this.taskRuns(task.id).some(r=>r.profileId===input.profileId&&r.flow===task.flow&&!terminal(r.status)),'RUN_ACTIVE','Stop the review execution before skipping it.');
      assert(!this.store.all<Review>('reviews').some(r=>r.profileId===input.profileId&&r.artifactId===input.artifactId),'REVIEW_EXISTS','Review already recorded.');
      const review:Review={id:id(),taskId:task.id,runId:null,profileId:input.profileId,artifactId:input.artifactId,verdict:'changes_requested',text:text(input.reason,'Skip reason'),skipped:true,createdAt:now()};this.store.put('reviews',review);this.log(task,'review.skipped','user',review.text);this.refreshTask(task.id);return review;
    });
  }
  acceptTask(input: {requestId:string;taskId:string;artifactId:string;expectedVersion:number;comment?:string},actor='user'):Acceptance {
    this.user(actor);return this.command('accept_task',input,()=>{
      const task=this.getTask(input.taskId);this.version(task,input.expectedVersion);
      assert(task.status==='awaiting_acceptance'&&!task.frozen,'NOT_READY','Task is not awaiting user acceptance.');
      assert(task.artifactId===input.artifactId,'STALE_ARTIFACT','The page refers to an older artifact.');
      const acceptance:Acceptance={id:id(),taskId:task.id,artifactId:input.artifactId,decision:'accepted',comment:input.comment??'',createdAt:now()};this.store.put('acceptances',acceptance);this.bump(task,{status:'completed'});this.log(task,'task.accepted','user',acceptance.comment||'User accepted this artifact.');return acceptance;
    });
  }
  reworkTask(input: {requestId:string;taskId:string;expectedVersion:number;ownerId?:string;goal?:string;criteria?:string}):Task {
    return this.command('rework_task',input,()=>{
      const task=this.getTask(input.taskId);this.version(task,input.expectedVersion);
      assert(task.status!=='cancelled','TASK_CANCELLED','Create a new task after cancellation.');
      assert(!this.taskRuns(task.id).some(r=>!terminal(r.status)),'RUN_ACTIVE','All original executions must be confirmed ended before rework.');
      const ownerId=input.ownerId??task.ownerId;assert(this.getProfile(ownerId).enabled,'PROFILE_DISABLED','The selected owner is disabled.');
      assert(!task.reviewerIds.includes(ownerId),'INVALID_OWNER','Owner cannot also review their own work.');
      const result=this.bump(task,{ownerId,ownerGeneration:task.ownerGeneration+(ownerId===task.ownerId?0:1),flow:task.flow+1,status:'pending',frozen:false,freezeReason:null,cancelRequested:false,artifactId:null,goal:input.goal===undefined?task.goal:text(input.goal,'Goal'),criteria:input.criteria===undefined?task.criteria:text(input.criteria,'Criteria')});
      this.log(result,'task.rework_requested','user','User confirmed a new implementation flow.');return result;
    });
  }
  blockTask(taskId:string,reason:string):Task {
    return this.store.transaction(()=>{const task=this.getTask(taskId);assert(!['completed','cancelled'].includes(task.status),'TASK_CLOSED','Closed task cannot be blocked.');const updated=this.bump(task,{frozen:true,freezeReason:'error',status:'blocked'});this.log(updated,'task.blocked','system',text(reason,'Block reason'));return updated;});
  }
  comment(taskId:string,content:string,actor='user'):Event { this.user(actor);return this.store.transaction(()=>this.log(this.getTask(taskId),'task.comment','user',text(content,'Comment'))); }
  addApproval(input:{runId:string;nativeId:string;kind:string;prompt:string;options:string[]}):Approval {
    return this.store.transaction(()=>{
      const run=this.getRun(input.runId);this.requestable(run);
      const previous=this.store.all<Approval>('approvals').find(a=>a.runId===run.id&&a.nativeId===input.nativeId);
      if(previous) {assert(previous.kind===input.kind&&previous.prompt===input.prompt&&hash(previous.options)===hash(input.options),'REQUEST_CONFLICT','Native approval id changed content.');return previous;}
      assert(input.options.length>0&&input.options.every(o=>typeof o==='string'&&o.length>0),'INVALID_OPTIONS','Native approval options required.',400);
      const approval:Approval={id:id(),runId:run.id,taskId:run.taskId,projectId:run.projectId,nativeId:text(input.nativeId,'Native request id'),kind:text(input.kind,'Approval kind'),prompt:text(input.prompt,'Approval prompt'),options:[...input.options],status:'pending',answer:null,createdAt:now()};
      this.store.put('approvals',approval);this.store.put('runs',{...run,status:'waiting_user',updatedAt:now()});this.log(this.getTask(run.taskId),'approval.requested','tool',approval.prompt,run.id);return approval;
    });
  }
  answerApproval(approvalId:string,answer:string,actor='user'):Approval {
    return this.store.transaction(()=>{
      this.user(actor);const approval=this.required<Approval>('approvals',approvalId);const run=this.getRun(approval.runId);this.requestable(run);
      assert(approval.status==='pending','REQUEST_EXPIRED','Approval is no longer pending.');assert(approval.options.includes(answer),'INVALID_ANSWER','Answer must match a native approval option.',400);
      const result=this.store.put('approvals',{...approval,status:'answered' as const,answer});this.log(this.getTask(run.taskId),'approval.answered','user',answer,run.id);return result;
    });
  }
  addQuestion(input:{runId:string;nativeId:string;prompt:string}):Question {
    return this.store.transaction(()=>{
      const run=this.getRun(input.runId);this.requestable(run);const previous=this.store.all<Question>('questions').find(q=>q.runId===run.id&&q.nativeId===input.nativeId);
      if(previous) {assert(previous.prompt===input.prompt,'REQUEST_CONFLICT','Question id changed content.');return previous;}
      const question:Question={id:id(),runId:run.id,taskId:run.taskId,projectId:run.projectId,nativeId:text(input.nativeId,'Question id'),prompt:text(input.prompt,'Question'),status:'pending',answer:null,createdAt:now()};
      this.store.put('questions',question);this.store.put('runs',{...run,status:'waiting_user',updatedAt:now()});this.log(this.getTask(run.taskId),'question.asked','agent',question.prompt,run.id);return question;
    });
  }
  answerQuestion(questionId:string,answer:string,actor='user'):Question {
    return this.store.transaction(()=>{
      this.user(actor);const question=this.required<Question>('questions',questionId);const run=this.getRun(question.runId);this.requestable(run);assert(question.status==='pending','REQUEST_EXPIRED','Question is no longer pending.');
      const result=this.store.put('questions',{...question,status:'answered' as const,answer:text(answer,'Answer')});this.log(this.getTask(run.taskId),'question.answered','user',result.answer,run.id);return result;
    });
  }
  private required<T>(table:Parameters<Store['get']>[0],key:string):T { const entity=this.store.get<T>(table,key);assert(entity,'NOT_FOUND',`${table} record not found.`,404);return entity; }
  private version(task:Task,expected:number):void {assert(task.version===expected,'STALE_VERSION','Task changed; refresh before taking this action.');}
  private user(actor:string):void {assert(actor==='user','FORBIDDEN','This action requires the local user.',403);}
  private taskRuns(taskId:string):Run[] {return this.store.all<Run>('runs').filter(r=>r.taskId===taskId);}
  private bump(task:Task,patch:Partial<Task>):Task {return this.store.put('tasks',{...task,...patch,version:task.version+1,updatedAt:now()});}
  private log(task:Task,type:string,source:Event['source'],content:string,runId:string|null=null,eventId:string=id(),nativeId:string|null=null,payloadHash?:string):Event {
    return this.store.event({id:eventId,taskId:task.id,projectId:task.projectId,runId,source,type,payloadHash,text:content,nativeId,createdAt:now()});
  }
  private command<T extends {id:string}>(kind:string,input:{requestId:string}&Record<string,unknown>,action:()=>T):T {
    return this.store.transaction(()=>{
      const requestId=text(input.requestId,'Stable request id',300);const payloadHash=hash({kind,input});const previous=this.store.get<Command>('commands',requestId);
      if(previous) {assert(previous.payloadHash===payloadHash&&previous.kind===kind,'REQUEST_CONFLICT','Request id was reused with different content.');return previous.result as T;}
      const result=action();const value=result as T&{taskId?:string;status?:string};const runKind=kind==='enqueue_task'||kind==='enqueue_review';
      const command:Command={id:requestId,kind,payloadHash,taskId:kind==='create_task'?result.id:value.taskId??(typeof input.taskId==='string'?input.taskId:null),runId:runKind?result.id:null,status:runKind?'pending':'finished',result,createdAt:now()};this.store.put('commands',command);return result;
    });
  }
  private commandStatus(runId:string,status:Command['status']):void {for(const command of this.store.all<Command>('commands').filter(c=>c.runId===runId))this.store.put('commands',{...command,status});}
  private newRun(task:Task,profileId:string,role:RunRole,workspacePath:string,artifactId:string|null):Run {
    const profile=this.getProfile(profileId);assert(profile.enabled,'PROFILE_DISABLED','Profile is disabled.');
    if(role==='implement') assert(!this.store.all<Run>('runs').some(r=>r.role==='implement'&&!terminal(r.status)&&this.workspaceKey(r.workspacePath)===this.workspaceKey(workspacePath)),'WORKSPACE_BUSY','Another execution owns this workspace.');
    const latest=new Map<string,RuleRevision>();for(const rule of this.store.all<RuleRevision>('rules'))latest.set(rule.id,rule);
    const rules=[...latest.values()].filter(r=>r.confirmed&&(r.scope==='global'||(r.scope==='project'&&r.projectId===task.projectId)||(r.scope==='role'&&r.profileId===profileId&&(!r.projectId||r.projectId===task.projectId))));
    const partial={goal:task.goal,criteria:task.criteria,project:this.getProject(task.projectId),profile,rules,artifactId,decisions:this.store.eventsAfter(0).filter(e=>e.taskId===task.id&&e.type==='task.decision'&&e.source==='user').map(e=>e.text)};
    const context:ContextSnapshot={...partial,hash:hash(partial)};
    const run:Run={id:id(),taskId:task.id,projectId:task.projectId,profileId,profileVersion:profile.version,provider:profile.provider,model:null,role,flow:task.flow,ownerGeneration:task.ownerGeneration,status:'queued',workspacePath,artifactId,context,nativeSessionId:null,nativeTurnId:null,evidence:null,error:null,usage:null,createdAt:now(),updatedAt:now()};
    this.store.put('runs',run);this.log(task,'run.queued','system',`Queued ${role} execution.`,run.id);return run;
  }
  private workspaceKey(path:string):string {return process.platform==='win32'?path.toLowerCase():path;}
  private requestable(run:Run):void {
    const task=this.getTask(run.taskId);assert(['sending','accepted','running','waiting_user'].includes(run.status)&&!task.frozen&&run.flow===task.flow&&run.ownerGeneration===task.ownerGeneration,'REQUEST_EXPIRED','Execution no longer accepts user responses.');
  }
  private expireRequests(runId:string):void {
    for(const a of this.store.all<Approval>('approvals').filter(a=>a.runId===runId&&a.status==='pending'))this.store.put('approvals',{...a,status:'expired'});
    for(const q of this.store.all<Question>('questions').filter(q=>q.runId===runId&&q.status==='pending'))this.store.put('questions',{...q,status:'expired'});
  }
  private refreshTask(taskId:string):void {
    const task=this.getTask(taskId);if(['completed','cancelled'].includes(task.status))return;
    const runs=this.taskRuns(taskId).filter(r=>r.flow===task.flow);const active=runs.filter(r=>!terminal(r.status));let status:Task['status'];
    if(task.cancelRequested&&active.length===0)status='cancelled';
    else if(task.frozen||active.some(r=>r.status==='unverified'))status='blocked';
    else if(active.length>0)status='running';
    else if(runs.length===0)status='pending';
    else {
      const implementation=runs.find(r=>r.role==='implement');
      if(!implementation||implementation.status!=='succeeded'||!task.artifactId)status='blocked';
      else {
        const reviews=this.store.all<Review>('reviews').filter(r=>r.artifactId===task.artifactId);
        const complete=task.reviewerIds.every(profileId=>reviews.some(r=>r.profileId===profileId));
        const failedReview=runs.some(r=>r.role==='review'&&['failed','stopped'].includes(r.status)&&!reviews.some(review=>review.profileId===r.profileId&&review.skipped));
        status=complete?'awaiting_acceptance':failedReview?'blocked':'running';
      }
    }
    if(status!==task.status)this.bump(task,{status});
  }
  private seedProfiles():void {
    const defaults:[string,string,RoleProfile['role'],Provider,string][]=[
      ['codex-implementer','实现者','implementer','codex','实现用户确认的目标，提交固定成果及真实测试证据。'],
      ['harness-reviewer','代码复核者','reviewer','deepseek-harness','只读复核固定成果，列出问题、影响和证据。'],
      ['antigravity-checker','验收检查者','acceptance','antigravity','对照验收条件独立检查固定成果，不替用户验收。'],
    ];
    this.store.transaction(()=>{for(const [profileId,name,role,provider,instructions]of defaults)if(!this.store.get('profiles',profileId))this.store.put('profiles',{id:profileId,version:1,name,role,provider,model:null,instructions,enabled:true,createdAt:now(),updatedAt:now()});});
  }
}
