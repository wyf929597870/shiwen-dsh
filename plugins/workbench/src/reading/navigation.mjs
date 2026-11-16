// Keep the list page and selected detail in sync as the filtered list changes.
export function readingPageSelection(records,page,pageSize=20){
 const pages=Math.max(1,Math.ceil(records.length/pageSize));
 const current=Math.max(1,Math.min(page,pages));
 return {page:current,cardId:records[(current-1)*pageSize]?.cardId??''};
}
export function readingSavedSelection(records,recordId,preferredCardId,pageSize=20){
 let index=records.findIndex(record=>record.id===recordId&&record.cardId===preferredCardId);
 if(index<0)index=records.findIndex(record=>record.id===recordId);
 return index<0?null:{page:Math.floor(index/pageSize)+1,cardId:records[index].cardId};
}
