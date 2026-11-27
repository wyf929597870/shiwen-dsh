import {z} from 'zod';

const id=z.string().min(1).max(128);
const revision=z.number().int().positive();
const position=z.number().int().nonnegative();
const sourceFields={
  recordId:id,revision,annotationId:id.optional(),annotationRevision:revision.optional(),originalVersionId:id.optional(),quote:z.string().min(1).max(16000).optional(),
  field:z.enum(['body','reflection','excerpt','annotation']).optional(),excerptIndex:position.optional(),
  start:position.optional(),end:position.optional()
};
const source=z.object(sourceFields).strict().refine(s=>
  ([s.annotationId,s.annotationRevision,s.originalVersionId].every(x=>x===undefined)||[s.annotationId,s.annotationRevision,s.originalVersionId].every(x=>x!==undefined)) &&
  (s.start===undefined) === (s.end===undefined) &&
  (s.start===undefined || (s.quote && s.end-s.start===s.quote.length)) &&
  (s.excerptIndex===undefined || s.field==='excerpt'),{message:'Invalid passage locator'});
const item={externalItemId:id,type:z.enum(['explore','follow_up']),text:z.string().trim().min(1).max(2000)};
const attachedSource=z.union([source,z.object({externalSourceId:id}).strict()]);
export const attachedSuggestions={
  suggestions:z.array(z.object({...item,sources:z.array(attachedSource).min(1).max(32).optional()}).strict()).max(100).optional(),
  requireSuggestions:z.boolean().optional(),expectedLibraryId:id.optional()
};
const library={expectedLibraryId:id};
const write={...library,requestId:id};
const versioned={...write,questionId:id,expectedRevision:revision};
const mappedSource=z.object({externalSourceId:id,recordId:id,revision}).strict();
const tool=(permission,description,shape)=>({permission,requiresRead:true,exploration:true,description,schema:z.object(shape).strict()});
export const explorationTools={
  shiwen_exploration_import:tool('create','Start or resume a library discovery job.',{...write,mode:z.enum(['history','incremental'])}),
  shiwen_exploration_settings:tool('read','Read discovery settings. Changes require update permission.',{...library,enabled:z.boolean().optional(),model:z.boolean().optional(),expectedRevision:revision.optional(),requestId:id.optional()}),
  shiwen_exploration_suggest:tool('create','Submit suggestions for existing versioned records to the review pool.',{
    ...write,suggestions:z.array(z.object({...item,sources:z.array(source).min(1).max(32)}).strict()).min(1).max(100)
  }),
  shiwen_exploration_list:tool('read','List exploration questions or unresolved discoveries in this library.',{
    ...library,view:z.enum(['raw','accepted','skipped','all','reviews']).default('raw'),recordId:id.optional(),
    type:z.enum(['explore','follow_up']).optional(),reason:z.enum(['source_unmapped','possible_duplicate','revised_discovery']).optional(),cursor:position.optional()
  }),
  shiwen_exploration_read:tool('read','Read a question and its currently valid evidence.',{...library,questionId:id.optional(),reviewItemId:id.optional()}),
  shiwen_exploration_review:tool('update','Apply a user decision to a versioned question.',{
    ...write,questionId:id.optional(),expectedRevision:revision.optional(),reviewItemId:id.optional(),
    expectedReviewRevision:revision.optional(),mappings:z.array(mappedSource).min(1).max(32).optional(),targetQuestionId:id.optional(),expectedTargetRevision:revision.optional(),decisionId:id.optional(),evidenceFingerprint:id.optional(),action:z.enum(['merge','undo_merge','keep_separate','resolve_source','accept','rewrite','observe','skip','restore','answered','continue','confirm_personal_context','dismiss_clue']),
    text:z.string().trim().min(1).max(2000).optional(),recordId:id.optional(),sourceRevision:revision.optional()
  }),
  shiwen_exploration_step:tool('update','Add a follow-up, judgment, trial or result, choose a branch or pause it.',{
    ...versioned,action:z.enum(['add','select','pause']),stepId:id,accept:z.literal(true).optional(),
    kind:z.enum(['ask','judgment','trial','result']).optional(),text:z.string().trim().min(1).max(10000).optional(),
    parentId:id.optional(),responseId:id.optional(),responseRevision:revision.optional(),quote:z.string().min(1).max(16000).optional(),
    observation:z.string().trim().min(1).max(2000).optional(),reviewDay:z.iso.date().optional(),takeaway:z.string().trim().min(1).max(2000).optional()
  }),
  shiwen_exploration_place:tool('update','Pin, replace or unpin a question for one day or week.',{
    ...versioned,action:z.enum(['pin','replace','unpin']),period:z.enum(['day','week']),periodKey:z.iso.date(),
    expectedPlacementRevision:position,accept:z.boolean().optional(),replaceQuestionId:id.optional()
  }),
  shiwen_exploration_respond:tool('update','Save a personal response or link an existing response to a question.',{
    ...versioned,responseRecordId:id,passage:source.optional(),body:z.string().min(1).max(100000).refine(s=>s.trim().length>0).optional(),sourceRevision:revision.optional()
  })
};

const readTool=explorationTools.shiwen_exploration_read;
readTool.schema=readTool.schema.refine(a=>Boolean(a.questionId)!==Boolean(a.reviewItemId),{message:'Select one question or review item'});
const reviewTool=explorationTools.shiwen_exploration_review;
reviewTool.schema=reviewTool.schema.refine(a=>a.action==='resolve_source'
  ? a.reviewItemId&&a.expectedReviewRevision&&a.mappings&&!a.questionId&&!a.expectedRevision
  : a.questionId&&a.expectedRevision&&!a.reviewItemId&&!a.expectedReviewRevision&&!a.mappings,
  {message:'The decision requires the matching target and expected revision'});

reviewTool.schema=reviewTool.schema.refine(a=>!['merge','undo_merge','keep_separate'].includes(a.action)||(a.targetQuestionId&&a.expectedTargetRevision&&(a.action!=='undo_merge'||a.decisionId)&&(a.action!=='keep_separate'||a.evidenceFingerprint)),{message:'Provide both question versions and the decision or match evidence'});

reviewTool.schema=reviewTool.schema.refine(a=>a.action!=='dismiss_clue'||Boolean(a.recordId&&a.sourceRevision),{message:'Provide the suggested record and revision'});

const stepTool=explorationTools.shiwen_exploration_step;
stepTool.schema=stepTool.schema.refine(a=>{
  if(a.action!=='add')return ![a.kind,a.text,a.parentId,a.responseId,a.responseRevision,a.quote,a.observation,a.reviewDay,a.takeaway,a.accept].some(v=>v!==undefined);
  return a.kind&&a.text&&Boolean(a.responseId)===Boolean(a.responseRevision)&&!(a.responseId&&a.parentId)
    &&(!a.quote||a.responseId)&&(!a.reviewDay&&!a.observation||a.kind==='trial')
    &&(!a.takeaway||a.kind==='result')&&(a.kind!=='result'||a.parentId);
},{message:'Provide the origin and fields for this exploration step'});
