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
const imageIds=z.array(z.uuid()).max(20).optional();
const create={...mutation,kind:z.enum(kinds),origin:z.enum(origins).describe('Actual author/source, independent of the client saving it.'),title:text(200).optional(),body:text(1000000).min(1),day,url:url.optional(),annotation:text(10000).optional(),imageIds};
export const definitions={
 shiwen_image_begin:{permission:'upload',description:'Prepare an image for a subsequent create or update. Use the returned attachment ID in Markdown.',schema:schema({uploadId:z.uuid(),purpose:z.enum(['create','update']),recordId:id.optional(),name:text(200).min(1),byteLength:z.number().int().min(1).max(8*1024*1024),digest:z.string().regex(/^[a-f0-9]{64}$/)})},
 shiwen_image_part:{permission:'upload',description:'Upload an image chunk as canonical base64. Repeating the same part is safe.',schema:schema({uploadId:z.uuid(),part:z.number().int().min(0).max(19),dataBase64:text(699052).min(1)})},
 shiwen_image_status:{permission:'upload',description:'Check the received image chunks and integrity before saving.',schema:schema({uploadId:z.uuid()})},
 shiwen_image_read:{permission:'read',description:'Read a record attachment in bounded base64 chunks.',schema:schema({id,attachmentId:z.uuid(),offset:z.number().int().min(0).optional()})},
 shiwen_save:{permission:'create',description:'Create a Shiwen record from external content. State the actual author origin. Channel/client identity is recorded separately. Markdown is preserved. journal appends to the single diary for day (defaults to today); use shiwen_update to replace its full body. This does not read a DSH session. Reuse requestId on retries.',schema:schema(create)},
 shiwen_collect:{permission:'create',description:'Save already fetched original web content as web/external with its URL. Does not fetch URLs. Save AI summaries separately.',schema:schema({...mutation,title:text(200).optional(),body:text(1000000).min(1),url:z.url({protocol:/^https?$/}).max(2048),day,imageIds})},
 shiwen_search:{permission:'read',description:'Search records by keywords, type and content date. Deleted records are excluded.',schema:schema({query:text(100).optional(),kind:z.enum(kinds).optional(),start:text(10).optional(),end:text(10).optional(),offset:z.number().int().min(0).optional()})},
 shiwen_read:{permission:'read',description:'Read Markdown and provenance in pages. Read before updating; pass revision on subsequent pages to detect changes.',schema:schema({id,revision:revision.optional(),offset:z.number().int().min(0).optional()})},
 shiwen_update:{permission:'update',description:'Update only specified fields using the latest revision. Use the annotation tools for AI commentary and rewrites. body replaces the complete Markdown, so read all pages first. Cannot convert materials to/from articles.',schema:schema({...mutation,id,revision,kind:z.enum(kinds).optional(),title:text(200).optional(),body:text(1000000).optional(),day,url:url.optional(),annotation:text(10000).optional(),stage:z.enum(['idea','draft','revision','final']).optional(),sourceIds:z.array(id).max(1000).optional(),imageIds})},
 shiwen_original_version:{permission:'read',description:'Get the immutable version ID and content hash of an original before creating an AI annotation.',schema:schema({id})},
 shiwen_annotation_list:{permission:'read',description:'List AI annotations for an original record. Set deleted to true to list deleted annotations for restoration.',schema:schema({originalId:id,deleted:z.boolean().optional()})},
 shiwen_annotation_read:{permission:'read',description:'Read a separate AI annotation in pages; use revision to detect changes.',schema:schema({id,revision:revision.optional(),offset:z.number().int().min(0).optional()})},
 shiwen_annotation_create:{permission:'create',description:'Create separate AI commentary or a rewrite anchored to an immutable original version. Never replace the original.',schema:schema({...mutation,originalId:id,originalVersionId:z.uuid(),originalContentHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),title:text(200).optional(),body:text(1000000).min(1),imageIds})},
 shiwen_annotation_update:{permission:'update',description:'Update a separate AI annotation using its own revision.',schema:schema({...mutation,id,revision,title:text(200).optional(),body:text(1000000),imageIds})},
 shiwen_annotation_delete:{permission:'delete',description:'Soft-delete an AI annotation.',schema:schema({...mutation,id,revision})},
 shiwen_annotation_restore:{permission:'delete',description:'Restore a deleted AI annotation.',schema:schema({...mutation,id,revision})},
 shiwen_correct_origin:{permission:'update',description:'Explicitly correct a record’s authorship/source provenance when requested by the user.',schema:schema({...mutation,id,revision,origin:z.enum(origins)})},
 shiwen_delete:{permission:'delete',description:'Soft-delete a record explicitly requested by the user. Return the revision required for restore.',schema:schema({...mutation,id,revision})},
 shiwen_restore:{permission:'delete',description:'Undo deletion with the revision returned by shiwen_delete.',schema:schema({...mutation,id,revision})},
 shiwen_review:{permission:'read',description:'Get writing and collection statistics for a date period, not record bodies.',schema:schema({period:z.enum(['1','7','14','30','month']),month:text(7).optional()})}
};
export function catalog(scopes){return Object.entries(definitions).filter(([,d])=>d.permission==='upload'?scopes.some(s=>s==='create'||s==='update'):scopes.includes(d.permission)).map(([name,d])=>({name,description:d.description,inputSchema:z.toJSONSchema(d.schema),annotations:{readOnlyHint:d.permission==='read',destructiveHint:['update','delete'].includes(d.permission),idempotentHint:true,openWorldHint:false}}));}
export function parseCall(name,args){const definition=definitions[name];if(!definition)throw new Error('未知工具');return definition.schema.parse(args);}
