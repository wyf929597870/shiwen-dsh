// Advisory checks only. They cannot determine whether a text is safe or ready to publish.
export function checkArticle({title='',body='',sourceIds=[]}) {
 const text=String(body);
 return [
  {id:'title',ok:Boolean(String(title).trim())},
  {id:'body',ok:Boolean(text.trim())},
  {id:'structure',ok:/^#{1,3}\s+\S/m.test(text)},
  {id:'sources',ok:Array.isArray(sourceIds)&&sourceIds.length>0},
  {id:'private',ok:!/(?:\b1[3-9]\d{9}\b|\b\d{17}[\dXx]\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i.test(text)}
 ];
}
