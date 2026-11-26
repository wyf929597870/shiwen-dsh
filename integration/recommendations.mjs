import {z} from 'zod';
const id=z.string().min(1).max(128), rev=z.number().int().positive(), cursor=z.number().int().nonnegative().optional();
const text=z.string().trim().min(1).max(200);
const scope={expectedLibraryId:id}, write={...scope,requestId:id};
const ref={...write,cardId:id.optional(),cardRevision:rev.optional(),resultId:id.optional(),resultVersion:rev.optional()};
const quotes=z.array(id).min(1).max(12);
const scene=z.enum(['experience','reading','writing']);
const tool=(permission,description,fields)=>({permission,requiresRead:permission!=='read',description,schema:z.object(fields).strict(),assist:true});
const refTool=(permission,description,fields)=>{const t=tool(permission,description,{...ref,...fields});t.schema=t.schema.refine(a=>a.cardId?!!a.cardRevision&&!a.resultId&&!a.resultVersion:!!a.resultId&&!!a.resultVersion&&!a.cardRevision,{message:'Select exactly one versioned card or result'});return t;};
export const assistTools={
 shiwen_assist_analyze:tool('read','Search or analyze dated source passages. Poll jobId with shiwen_assist_result.',{...scope,callId:id,scene,mode:z.enum(['search','analyze']).default('analyze'),question:z.string().max(1000).default(''),selection:z.object({recordId:id,sourceRevision:rev,text:z.string().max(1000)}).strict().optional()}),
 shiwen_assist_result:tool('read','Read the status and evidence of your analysis or refresh job. During refresh, progress.checked and total count candidate records. Read the week list when progress.version increases.',{jobId:id}),
 shiwen_recommendation_list:tool('read','Read weekly cards, daily picks, actual changes for today, or saved cards. Listing never generates recommendations.',{view:z.enum(['week','daily','today','later']).default('week'),cursor,includeDetails:z.boolean().optional()}),
 shiwen_recommendation_read:tool('read','Read one card, its verified quotes, relations and saved targets.',{...scope,cardId:id}),
 shiwen_recommendation_settings:tool('read','Read weekly settings. Changing enabled requires update, requestId, expectedLibraryId and revision.',{enabled:z.boolean().optional(),expectedLibraryId:id.optional(),requestId:id.optional(),revision:rev.optional()}),
 shiwen_recommendation_refresh:tool('update','Arrange accepted exploration questions for the current day and week. Poll jobId for completion.',write),
 shiwen_recommendation_feedback:tool('update','Save for later, skip a question, reject one relationship, or undo one feedback event.',{...write,cardId:id,cardRevision:rev,action:z.enum(['save_later','remove_later','skip','reject_relation','undo']),relationId:id.optional(),quoteIds:quotes.optional(),reason:text.optional(),feedbackId:id.optional()}),
 shiwen_recommendation_feedback_list:tool('read','Find feedback on hidden or older cards, including IDs usable for undo.',{...scope,cursor,action:z.enum(['skip','reject_relation']).optional(),cardId:id.optional()}),
 shiwen_assist_save_decision:refTool('create','Save only the confirmed personal wording of a decision.',{body:z.string().trim().min(1).max(100000),day:z.iso.date()}),
 shiwen_assist_create_draft:refTool('create','Create a source-linked article draft or return existing draft targets.',{title:text,mode:z.enum(['first','another']),quoteIds:quotes}),
 shiwen_assist_add_to_theme:refTool('update','Attach selected quotes and record the outcome per quote. New themes also require create.',{themeId:id.optional(),themeRevision:rev.optional(),newThemeTitle:text.optional(),quoteIds:quotes}),
 shiwen_theme_read:tool('read','Read a theme and its source members in pages.',{...scope,themeId:id,cursor})
};
