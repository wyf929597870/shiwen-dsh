import {z} from 'zod';
export const permissions=['create','read','update','delete'];
export const kinds=['journal','freewrite','idea','web','ai','reference','article'];
export const origins=['personal','external','ai','translation','unknown'];
const text=(max)=>z.string().max(max),id=z.string().min(1).max(100),revision=z.number().int().positive();
const source=z.object({sessionId:text(500).optional(),messageId:text(500).optional(),file:text(4096).optional()}).strict().optional();
const requestId=id.describe('Unique request ID. Reuse with identical arguments after a timeout; never reuse for a different action.');
const day=text(10).nullable().optional().describe('Content date YYYY-MM-DD; null means unknown, never invent a date.');
const url=z.union([z.literal(''),z.url({protocol:/^https?$/}).max(2048)]);
const schema=shape=>z.object(shape).strict();
const mutation={requestId,source};
const create={...mutation,kind:z.enum(kinds),origin:z.enum(origins).describe('Actual author/source, independent of the client saving it.'),title:text(200).optional(),body:text(1000000).min(1),day,url:url.optional(),annotation:text(10000).optional()};
export const definitions={
 shiwen_save:{permission:'create',description:'Create a Shiwen record from external content. State the actual author origin. Channel/client identity is recorded separately. Markdown is preserved; this does not read a DSH session. Reuse requestId on retries.',schema:schema(create)},
 shiwen_collect:{permission:'create',description:'Save already fetched original web content as web/external with its URL. Does not fetch URLs. Save AI summaries separately.',schema:schema({...mutation,title:text(200).optional(),body:text(1000000).min(1),url:z.url({protocol:/^https?$/}).max(2048),day})},
 shiwen_search:{permission:'read',description:'Search records by keywords, type and content date. Deleted records are excluded.',schema:schema({query:text(100).optional(),kind:z.enum(kinds).optional(),start:text(10).optional(),end:text(10).optional(),offset:z.number().int().min(0).optional()})},
 shiwen_read:{permission:'read',description:'Read Markdown and provenance in pages. Read before updating; pass revision on subsequent pages to detect changes.',schema:schema({id,revision:revision.optional(),offset:z.number().int().min(0).optional()})},
 shiwen_update:{permission:'update',description:'Update only specified fields using the latest revision. origin corrects authorship only when requested. New AI-written text remains attributed to AI. body replaces the complete Markdown, so read all pages first. Cannot convert materials to/from articles.',schema:schema({...mutation,id,revision,kind:z.enum(kinds).optional(),origin:z.enum(origins).optional(),title:text(200).optional(),body:text(1000000).optional(),day,url:url.optional(),annotation:text(10000).optional(),stage:z.enum(['idea','draft','revision','final']).optional(),sourceIds:z.array(id).max(1000).optional()})},
 shiwen_delete:{permission:'delete',description:'Soft-delete a record explicitly requested by the user. Return the revision required for restore.',schema:schema({...mutation,id,revision})},
 shiwen_restore:{permission:'delete',description:'Undo deletion with the revision returned by shiwen_delete.',schema:schema({...mutation,id,revision})},
 shiwen_review:{permission:'read',description:'Get writing and collection statistics for a date period, not record bodies.',schema:schema({period:z.enum(['1','7','14','30','month']),month:text(7).optional()})}
};
export function catalog(scopes){return Object.entries(definitions).filter(([,d])=>scopes.includes(d.permission)).map(([name,d])=>({name,description:d.description,inputSchema:z.toJSONSchema(d.schema),annotations:{readOnlyHint:d.permission==='read',destructiveHint:['update','delete'].includes(d.permission),idempotentHint:true,openWorldHint:false}}));}
export function parseCall(name,args){const definition=definitions[name];if(!definition)throw new Error('未知工具');return definition.schema.parse(args);}
