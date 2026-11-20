// Desktop views are projections of existing records; kind and provenance remain independent.
export const sectionKinds={
  library:['journal','freewrite','idea'],
  reading:['reading_note'],
  collections:['web','reference','ai'],
  articles:['article']
};
export function recordSection(kind){
  return Object.keys(sectionKinds).find(section=>sectionKinds[section].includes(kind));
}
