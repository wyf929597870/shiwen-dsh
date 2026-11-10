import {goalDefinitions,reviewGoalDays,goalSummary} from './review-goals.mjs';
import {validDay} from './wiki-import.mjs';

// Additive response: preserve legacy edit statistics while sharing the panel's
// content-date totals and goals. Never return journal bodies in statistics.
export function toolReview(api,args={}){
 let range=args;
 if(args.day!==undefined){
  if(validDay(args.day)!==args.day||args.period!=='1'||args.month!==undefined)throw Error('指定日期需要 period=1 且不能同时指定 month');
  range={period:'1',now:args.day+'T12:00:00'};
 }
 const report=api.review(range),preview=api.reviewPreview(range),days=reviewGoalDays(preview);
 return {start:report.start,end:report.end,totals:report.totals,daily:report.daily,undated:report.undated,
  originals:{personalOriginalCharacters:preview.personalOriginalCharacters,observedEdits:preview.observedEdits,daily:preview.daily},
  goals:{definitions:goalDefinitions.map(({id,label,en,unit,unitEn})=>({id,label,en,unit,unitEn})),
   daily:days.map(({day,goals})=>({day,goals})),
   summary:Object.fromEntries(goalDefinitions.map(({id})=>[id,goalSummary(days,id)]))}};
}
