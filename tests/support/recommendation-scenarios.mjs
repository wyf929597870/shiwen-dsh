// Each scenario gets its own temporary library. Dates describe events in the text.
const idea=(day,title,body)=>({kind:'idea',origin:'personal',day,title,body});
const book=(title,reflection,excerpts)=>({kind:'reading_note',origin:'personal',day:'2026-11-20',title,body:reflection,excerpts});
const plan=idea('2026-11-09','甲项目试用','甲项目下周先找两个人试用。');
const unrelated=idea('2026-11-21','周末日记','今天在公园看见一棵银杏树。');
export const scenarios=[
 {name:'经验·同一项目的后续',scene:'experience',question:'甲项目试用后来怎么样了？',rows:[plan,idea('2026-11-16','甲项目试用结束','甲项目试用结束，两个人都卡在导入。')],type:'outcome',wanted:['甲项目下周','甲项目试用结束']},
 {name:'经验·不同项目只能对照',scene:'experience',question:'甲项目试用后来怎么样了？',rows:[plan,idea('2026-11-16','乙项目试用结束','乙项目的试用结束，流程很顺利。')],type:'comparison',wanted:['甲项目下周','乙项目的试用']},
 {name:'经验·只有计划',scene:'experience',question:'更文计划后来怎么样了？',rows:[idea('2026-11-09','更文计划','我打算继续更文，先从每月一次开始。')],type:'intention',wanted:['我打算']},
 {name:'阅读·观察行为回答读者问题',scene:'reading',question:'怎么知道读者在哪一步放弃？',rows:[book('观察实际使用','访谈不能代替观察。',[{text:'观察人们实际使用产品时在哪一步停下来。',page:'19'}])],type:'reading',wanted:['观察人们']},
 {name:'阅读·整篇异议和两段书摘',scene:'reading',question:'如何观察读者？',rows:[book('观察读者','我不同意把读者的沉默当作认同。',[{text:'观察读者的沉默。',page:'3'},{text:'访谈后再观察读者的行为。',page:'5'}])],type:'reading',wanted:['访谈后','我不同意']},
 {name:'阅读·近似主题不足为据',scene:'reading',question:'读者在哪一步退出？',rows:[book('读者研究','',[{text:'读者群每年都有变化。',page:'2'}])],type:null,wanted:[]},
 {name:'写作·单段经历成题',scene:'writing',question:'为什么删掉文章前三段？',rows:[idea('2026-11-18','删掉文章前三段','我删掉文章前三段，因为试读者直到第四段才明白我想讲什么。')],type:'writing',wanted:['我删掉']},
 {name:'写作·区分作者和项目',scene:'writing',question:'如何改稿？',rows:[idea('2026-11-18','甲项目改稿','我为甲项目改稿，删去了开头的对话。'),idea('2026-11-20','同事为乙项目改稿','同事在乙项目增加了访谈，两篇是不同作者的文章。')],type:'writing',wanted:['我为甲项目','同事在乙项目']},
 {name:'写作·空标题不足为据',scene:'writing',question:'写作输入',rows:[idea('2026-11-18','写作输入','写作，输入。')],type:null,wanted:[]},
].map(x=>({...x,rows:[...x.rows,unrelated]}));
