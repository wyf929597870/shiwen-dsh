export const library = {libraryId:'preview-library',pageGeneration:1,name:'示例资料库',role:'standalone',integrity:'complete'};
const material = (i, kind='journal') => ({id:`preview-${kind}-${i}`,title:i===0?'一段用于检查换行的示例标题与记录':`示例${kind==='article'?'文章':'素材'} ${i+1}`,kind,origin:'personal',processing:'original',contentDay:'2026-11-01',createdAt:'2026-11-01T08:00:00Z',markdown:'# 示例标题\n\n这是用于布局预览的虚构正文。',sourceIds:[],sources:[],stage:'draft',revision:1,deleted:false});
export const records = [...Array.from({length:120},(_,i)=>material(i)),...Array.from({length:4},(_,i)=>material(i,'article'))];
