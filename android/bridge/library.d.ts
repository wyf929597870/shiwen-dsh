export interface LibraryContext { libraryId: string; pageGeneration: number; role: 'standalone'|'coordinated'|'paused'|'rebind-required'; integrity?: 'initializing'|'complete'|'incomplete'; probe?: boolean }
export interface Draft { requestId: string; title: string; markdown: string; kind: 'journal'|'idea'|'freewrite'; localGeneration: number }
export interface RecordSummary { id: string; title: string; kind: string; createdAt: string; origin: 'personal'; state: 'local-only' }
export type Receipt = {status:'unknown'} | {status:'applied'; recordId:string};
export interface AgentConversation { id:string; title:string; model:string; modelRevision?:string; archived:boolean; readOnly?:boolean; running?:boolean; updatedAt:string }
export interface AgentConversationSnapshot { items:AgentConversation[]; activeId:string|null }
export interface AgentTask { id:string; conversationId:string; input:string; output:string; status:'admitted'|'running'|'succeeded'|'failed'|'interrupted'|'cancelled'; error?:string; model:string; updatedAt:string; recordId?:string; contextTurns:number; omittedTurns:number }
export type ModelConfig = {configured:false} | {configured:true; name:string; baseUrl:string; model:string; revision:string};
export interface Methods {
  libraryList: {args:Record<string,never>; result:LibraryRegistry};
  libraryCreate: {args:{name:string}; result:LibraryContext};
  librarySelect: {args:{libraryId:string}; result:LibraryContext};
  libraryConnect: {args:{nodeId:string}; result:{libraryId:string;state:string;integrity?:string;operationId:string}};
  recordList: {args:{libraryId:string; query?:string; kind?:MobileRecordKind; excludeKind?:MobileRecordKind; cursor?:string|null; limit?:number; deleted?:boolean}; result:RecordPage};
  recordRead: {args:{libraryId:string; id:string}; result:MobileRecord};
  recordCreate: {args:{libraryId:string; requestId:string; localGeneration:number; record:MobileRecordInput}; result:RecordMutationResult};
  recordUpdate: {args:{libraryId:string; id:string; expectedRevision:number; requestId:string; localGeneration:number; patch:Partial<MobileRecordInput>}; result:RecordMutationResult};
  recordDelete: {args:{libraryId:string; id:string; expectedRevision:number; requestId:string}; result:RecordMutationResult};
  recordRestore: {args:{libraryId:string; id:string; expectedRevision:number; requestId:string}; result:RecordMutationResult};
  recordVersions: {args:{libraryId:string; id:string; cursor?:string|null; limit?:number}; result:RecordVersionPage};
  recordDraftRead: {args:{libraryId:string;slot:'composer'|'materials'|'articles'};result:{draft:null|RecordEditorDraft;nextGeneration:number}};
  recordDraftSave: {args:{libraryId:string;slot:'composer'|'materials'|'articles';requestId:string;localGeneration:number;content:Record<string,unknown>;pendingMutation?:PendingRecordMutation|null};result:{saved:true}};
  recordDraftAcknowledge: {args:{libraryId:string;slot:'composer'|'materials'|'articles';requestId:string;localGeneration:number};result:{cleared:boolean}};
  projectList: {args:{libraryId:string; query?:string; stage?:ArticleStage; cursor?:string|null; limit?:number}; result:RecordPage};
  projectCreate: {args:{libraryId:string; requestId:string; localGeneration:number; record:MobileRecordInput & {kind:'article'}}; result:RecordMutationResult};
  projectUpdate: {args:{libraryId:string; id:string; expectedRevision:number; requestId:string; localGeneration:number; patch:Partial<MobileRecordInput>}; result:RecordMutationResult};
  review: {args:{libraryId:string; period:'1'|'7'|'14'|'30'|'month'; month?:string}; result:ReviewReport};
  syncStatus: {args:{libraryId:string}; result:LibrarySyncStatus};
  syncNow: {args:{mode:'manual'|'auto'}; result:{operationId:string;state:string}};
  syncProgress: {args:{boundLibraryId:string;pageGeneration:number;targetLibraryId?:string;operationId:string}; result:SyncProgress};
  syncConflicts: {args:{libraryId:string;cursor?:string|null;limit?:number}; result:{items:SyncConflictSummary[];nextCursor?:string|null}};
  syncConflictRead: {args:{libraryId:string;conflictId:string}; result:{conflict:SyncConflict}};
  syncConflictResolve: {args:{libraryId:string;conflictId:string;expectedRemoteRevision?:number;resolution:ConflictResolution;requestId:string}; result:RecordMutationResult};
  settingsGet: {args:Record<string,never>;result:{theme:'system'|'light'|'dark';language:'zh-CN'|'en'|string;systemDark:boolean}};
  settingsUpdate: {args:{theme?:'system'|'light'|'dark';language?:'zh-CN'|'en'|string};result:{theme:'system'|'light'|'dark';language:string;systemDark:boolean}};
  librarySettingsGet: {args:{libraryId:string};result:LibrarySyncPreferences};
  librarySettingsUpdate: {args:{libraryId:string;autoSync?:boolean;backgroundSync?:boolean;conditions?:Record<string,unknown>};result:LibrarySyncPreferences};
  storageInfo: {args:Record<string,never>;result:StorageInfo};
  storageClearTemporary: {args:Record<string,never>;result:{removedBytes:number;removedFiles:number}};
  libraryRename: {args:{name:string};result:{libraryId:string;name:string}};
  modelConfig: {args:Record<string,never>; result:ModelConfig};
  configureModel: {args:Record<string,never>; result:{closed:true}};
  agentConversations: {args:Record<string,never>; result:AgentConversationSnapshot};
  agentCreateConversation: {args:{id:string}; result:AgentConversationSnapshot};
  agentSelectConversation: {args:{id:string}; result:AgentConversationSnapshot};
  agentRecent: {args:{conversationId:string; offset?:number}; result:{items:AgentTask[]; nextOffset?:number|null}};
  agentStatus: {args:{conversationId:string; id:string}; result:AgentTask|{status:'unknown'}};
  agentSend: {args:{conversationId:string; id:string; input:string; saveOriginal:boolean; kind:'journal'|'idea'|'freewrite'; localGeneration:number; revision:string}; result:AgentTask};
  agentReadDraft: {args:{conversationId:string}; result:{draft?:AgentDraft|null}};
  agentSaveDraft: {args:AgentDraft; result:{saved:true}};
  agentAcknowledge: {args:{conversationId:string; id:string; localGeneration:number}; result:{saved:true}};
  agentCancel: {args:{conversationId:string; id:string}; result:AgentTask};
  nodeList: {args:Record<string,never>; result:NodeSnapshot};
  configureNode: {args:{id?:string}; result:{closed:true;connected?:boolean;sync?:{libraryId:string;operationId:string;state:string;integrity?:string};syncError?:string}};
  nodeSelect: {args:{id:string}; result:NodeSnapshot};
  nodeCheck: {args:{id:string}; result:NodeSnapshot&{connected?:boolean;sync?:{libraryId:string;operationId:string;state:string;integrity?:string};syncError?:string}};
  nodeRemove: {args:{id:string}; result:NodeSnapshot};
  nodeAgentState: {args:{id:string}; result:NodeAgentState};
  nodeAgentDocumentSave: {args:{id:string; name:'IDENTITY.md'|'SOUL.md'; body:string; revision:number}; result:NodeWriteResult};
  nodeMemorySave: {args:{id:string; memoryId?:string; body:string; category:'user'|'memory'; revision?:number}; result:NodeWriteResult};
  nodeMemoryDecide: {args:{id:string; memoryId:string; revision:number; accept:boolean}; result:NodeWriteResult};
  nodeMemoryDelete: {args:{id:string; memoryId:string; revision:number}; result:NodeWriteResult};
  nodeManagement: {args:{id:string; action:string; args?:Record<string,unknown>}; result:{action:string; data:unknown; nodeChanged?:boolean}};
  nodeExternalStatus: {args:{id:string}; result:ExternalAccessStatus};
  configureExternalClient: {args:{id:string; name:string; scopes:ExternalPermission[]}; result:ExternalClientMetadata & {nodeChanged?:boolean;credentialDisplayed:boolean}};
  nodeExternalRevoke: {args:{id:string; clientId:string}; result:{revoked:true;nodeChanged?:boolean}};
  recoveryInspect: {args:{libraryId:string;nodeId:string;configRevision:number};result:RecoveryInspection};
  recoveryStart: {args:{libraryId:string;nodeId:string;configRevision:number;mode:RecoveryMode;expectedTarget:RecoveryTarget};result:RecoveryTask};
  recoveryProgress: {args:{libraryId:string;nodeId:string;configRevision:number;taskId:string};result:RecoveryProgress};
  recoveryCandidates: {args:{libraryId:string;nodeId:string;configRevision:number;taskId:string;cursor?:string;limit?:number};result:{items:RecoveryCandidate[];nextCursor?:string|null}};
  recoveryBranchRead: {args:{libraryId:string;nodeId:string;configRevision:number;taskId:string;branchId:string};result:RecoveryBranch};
  recoveryDecide: {args:{libraryId:string;nodeId:string;configRevision:number;taskId:string;branchId:string;resolution:'retain-branch'|'use-branch'|'discard';expectedTargetHead:RecoveryHead|null};result:{state:string}};
  recoveryComplete: {args:{libraryId:string;nodeId:string;configRevision:number;taskId:string};result:RecoveryProgress};
  markdownImport: {args:{libraryId:string};result:{cancelled?:boolean;imported:number;skipped:number;records:Array<{id:string;title:string;contentDay:string|null}>;failures?:Array<{index:number;code:string}>}};
  recordExport: {args:{libraryId:string;id:string};result:{cancelled?:boolean;exported:boolean;encrypted?:boolean}};
  libraryBackupExport: {args:{libraryId:string;includeConversations?:boolean};result:{cancelled?:boolean;exported:boolean;encrypted?:boolean}};
  libraryBackupRestore: {args:{libraryId:string;name?:string;asNewLibrary?:boolean;requestId:string};result:{cancelled?:boolean;restored:boolean;requestId?:string;libraryId?:string;name?:string;recordCount?:number;attachments?:number;sourceLibraryId?:string|null;role?:string;integrity?:string}};
  recordCopy: {args:{libraryId:string;id:string;targetLibraryId:string;requestId:string};result:RecordMutationResult};
  recordShare: {args:{libraryId:string;id:string};result:{shared:boolean}};
  recordAttachments: {args:{libraryId:string;recordId:string};result:{items:AttachmentDescriptor[]}};
  attachmentOpen: {args:{recordId:string;attachmentId:string};result:{opened:boolean}};
  attachmentShare: {args:{recordId:string;attachmentId:string};result:{shared:boolean}};
  shareInboxList: {args:Record<string,never>;result:{items:ShareInboxItem[]}};
  shareInboxSave: {args:{id:string;targetLibraryId:string;record:ShareInboxRecord};result:RecordMutationResult&{libraryId:string}};
  shareInboxDismiss: {args:{id:string};result:{dismissed:true}};
  list: {args:{offset?:number}; result:{items:RecordSummary[]; nextOffset?:number|null}};
  read: {args:{id:string}; result:RecordSummary & {markdown:string}};
  save: {args:Draft; result:RecordSummary};
  receipt: {args:{requestId:string}; result:Receipt};
  saveDraft: {args:Draft; result:{saved:true}};
  readDraft: {args:Record<string,never>; result:{draft?:Draft|null}};
}
export const isNative: boolean;
export interface AgentDraft {conversationId:string; id:string; input:string; saveOriginal:boolean; kind:'journal'|'idea'|'freewrite'; localGeneration:number}
export interface ServiceNode {id:string; name:string; baseUrl:string; allowPrivateHttp:boolean; authenticated:boolean; configRevision:number; refreshing?:boolean; lastCheckedAt?:string|null; profileSyncStatus?:'synced'|'cached'|'not-synced'|string|null; profileRevision?:string|null; profileUpdatedAt?:string|null; profileMemoryCount?:number|null}
export interface NodeSnapshot {items:ServiceNode[]; activeId:string|null}
export interface AgentProfileDocument {body:string; revision:number}
export interface AgentMemory {id:string; body:string; category:'user'|'memory'; status:'active'|'pending'; revision:number; evidence?:string; updated?:string}
export interface NodeAgentState {identity:AgentProfileDocument; soul:AgentProfileDocument; memories:AgentMemory[]}
export interface NodeProfileWriteItem {name:'IDENTITY.md'|'SOUL.md'; body:string; revision:number}
export interface NodeMemoryWriteItem {id:string; body?:string; category?:'user'|'memory'; status?:'active'|'pending'|'rejected'|'deleted'; revision?:number; evidence?:string; updated?:string}
export interface NodeWriteResult {saved:true; nodeChanged?:boolean; profileSynced:boolean; profileRevision?:string; syncError?:string; item?:NodeMemoryWriteItem|NodeProfileWriteItem}
export type ExternalPermission='create'|'read'|'update'|'delete';
export interface ExternalClientMetadata {id:string;name:string;scopes:ExternalPermission[];created:string}
export interface ExternalAccessClient extends ExternalClientMetadata {revoked:string|null;last_used:string|null}
export interface ExternalAccessStatus {running:boolean;endpoint:string|null;clients:ExternalAccessClient[];nodeChanged?:boolean}
export function bootstrap(): Promise<LibraryContext>;
export function call<M extends keyof Methods>(method:M,args?:Methods[M]['args']): Promise<Methods[M]['result']>;

export type MobileRecordKind='journal'|'freewrite'|'idea'|'web'|'ai'|'reference'|'article';
export type RecordOrigin='personal'|'external'|'ai'|'translation'|'unknown';
export type ArticleStage='idea'|'draft'|'revision'|'final';
export interface RecordSource {text:string;origin:RecordOrigin;sourceRef?:string}
export interface MobileRecordInput {
  id?:string;kind:MobileRecordKind;title:string;markdown:string;origin:RecordOrigin;processing:'original'|'formatting'|'ai-organized'|'translation'|'unknown';
  contentDay:string|null;dateBasis:string;url:string;annotation:string;stage:ArticleStage;sourceIds:string[];sources:RecordSource[];
  attachmentDescriptors?:Array<{id:string;hash:string;byteLength:number;name:string}>;
}
export interface MobileRecord extends MobileRecordInput {
  id:string;libraryId?:string;revision:number;versionId:string;changeId?:string;baseVersionId?:string|null;serverRevision:number|null;localGeneration:number;
  createdAt:string;updatedAt:string;deleted:boolean;createdByDevice:string|null;syncState:'synced'|'pending'|'conflict'|'local-only'|string;
}
export interface AttachmentDescriptor {id:string;name:string;createdAt?:string;hash:string;byteLength:number;available:boolean;synced?:boolean;mimeType?:string}
export interface ShareInboxRecord {title:string;markdown:string;kind:MobileRecordKind;origin:RecordOrigin;processing:string;contentDay:string|null;url:string|null}
export interface ShareInboxItem {id:string;title:string;text:string;url:string|null;receivedAt:string;pendingTargetLibraryId:string|null;pendingRecord:ShareInboxRecord|null}
export interface RecordPage {items:MobileRecord[];nextCursor?:string|null;total?:number}
export interface RecordMutationResult {record:MobileRecord;syncState:string;receipt:Receipt}
export interface RecordVersion {versionId:string;revision:number;title:string;markdown:string;reason?:string;createdAt:string}
export interface RecordVersionPage {items:RecordVersion[];nextCursor?:string|null}
export interface PendingRecordMutation {action:'create'|'update'|'delete'|'restore';requestId:string;localGeneration:number;id?:string;expectedRevision?:number;record?:MobileRecordInput;patch?:Partial<MobileRecordInput>;fingerprint?:string}
export interface RecordEditorDraft {requestId:string;localGeneration:number;content:Record<string,unknown>;pendingMutation?:PendingRecordMutation|null}
export interface LibraryDescriptor {libraryId:string;name:string;role:LibraryContext['role'];integrity:NonNullable<LibraryContext['integrity']>;identity?:{serverId:string|null;epoch:string|null;revision:number|null};connectionState?:string;pendingCount?:number|null;conflictCount?:number|null;lastSyncedAt?:string|null}
export interface LibraryRegistry {items:LibraryDescriptor[];activeId:string|null}
export interface ReviewTotals {added:number;removed:number;net:number;personalRecords:number;collected:number;web:number;ai:number;articles:number;finalized:number;reference:number;historicalChars:number;historicalRecords:number}
export interface ReviewDay {day:string;added:number;removed:number;net:number;historical:number;collected:number}
export interface ReviewReport {totals:ReviewTotals;daily:ReviewDay[];isComplete:boolean;completeThrough:string|null;localPending:number}
export interface LibrarySyncStatus {state:string;role:LibraryContext['role'];integrity:LibraryContext['integrity'];appliedCursor:number|null;completeCursor:number|null;pendingCount:number|null;rejectedCount?:number|null;rejectedOperations?:Array<{operationId:string;recordId:string;code:string}>;conflictCount:number|null;lastSyncedAt:string|null;lastError?:string|null}
export interface SyncProgress {state:string;phase?:string;completed?:number|null;total?:number|null;appliedCursor?:number|null;completeCursor?:number|null;error?:string|null}
export interface SyncConflictSummary {id:string;recordId:string;title?:string;createdAt?:string;kind?:MobileRecordKind}
export interface SyncConflict {id:string;recordId:string;base:MobileRecord|null;local:MobileRecord;remote:MobileRecord|null;[key:string]:unknown}
export type ConflictResolution={kind:'keep-local'}|{kind:'keep-remote'}|{kind:'merge';record:Pick<MobileRecordInput,'kind'|'title'|'markdown'> & {id:string}};
export interface LibrarySyncPreferences {libraryId:string;autoSync:boolean;backgroundSync:boolean;conditions?:Record<string,unknown>}
export interface StorageInfo {availableBytes:number;totalBytes:number;libraryBytes:number;attachmentBytes:number;recordCount:number;versionCount:number;expiredShareBytes:number}
export type RecoveryMode='initialize'|'coordinator-recovery'|'device-restore';
export interface RecoveryHead {recordId:string;revision:number;versionId:string|null;changeId:string|null;deleted:boolean}
export interface RecoveryTarget {libraryId:string;serverId:string;epoch:string;revision:number;integrity:'complete'|'incomplete';recordCount:number;isEmpty:boolean}
export interface RecoveryInspection {source:{libraryId:string;integrity:'complete'|'incomplete';counts:{records:number;versions:number;attachments:number};missingAttachments:number};target:RecoveryTarget;activeTask:RecoveryTask|null;allowedModes:RecoveryMode[]}
export interface RecoveryTask {taskId:string;mode:RecoveryMode;state:string}
export interface RecoveryProgress extends RecoveryTask {receivedCounts:Record<string,number>;expectedCounts:Record<string,number>;missingEntities:Array<{entity:string;received:number;expected:number;digestMatches?:boolean}>;missingAttachmentIds:string[];candidateCount:number;resolvedCount:number;resolvedCounts:{retained:number;merged:number;discarded:number;applied:number}}
export interface RecoveryCandidate {branchId:string;recordId:string;classification:string;sourceHead:RecoveryHead;targetHead:RecoveryHead|null}
export interface RecoveryBranch {branchId:string;record:MobileRecord;versions:RecordVersion[];activities:unknown[];attachments:unknown[]}
