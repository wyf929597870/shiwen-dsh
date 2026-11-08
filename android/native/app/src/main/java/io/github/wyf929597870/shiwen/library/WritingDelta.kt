package io.github.wyf929597870.shiwen.library

/** Unicode edit counts, with the same path selection as the desktop's jsdiff.
 * Adapted from jsdiff's Myers traversal (BSD-3-Clause); see android/THIRD_PARTY_NOTICES.md.
 * Whitespace is excluded from counts, but still participates in matching. */
internal object WritingDelta {
    data class Counts(val added: Int, val removed: Int)
    data class Change(val kind: String, val text: String)
    private data class Trail(val kind: String, val length: Int, val previous: Trail?)
    private data class Path(var oldPosition: Int, val added: Int, val removed: Int, var trail: Trail? = null)
    private data class Result(val counts: Counts, val changes: List<Change>)
    private val imageOrCode = Regex("(`+)([^`]*?)\\1|!\\[[^\\r\\n]*?]\\(attachment:[a-f0-9-]{36}\\)", RegexOption.IGNORE_CASE)
    private val fenceStart = Regex("^\\s{0,3}(`{3,}|~{3,})")
    private fun withoutImageReferences(value: String): String {
        var fence: String? = null
        return value.split('\n').joinToString("\n") { line ->
            val marker = fenceStart.find(line)?.groupValues?.get(1)
            if (marker != null) {
                val active = fence
                if (active == null) fence = marker else if (marker[0] == active[0] && marker.length >= active.length && line.trim() == marker) fence = null
                line
            } else if (fence != null) line else imageOrCode.replace(line) { match -> if (match.value.startsWith('`')) match.value else "" }
        }
    }
    fun count(value: String): Int = withoutImageReferences(value).codePoints().filter { !space(it) }.count().toInt()
    private fun space(value: Int) = value in 9..13 || value == 32 || value == 160 || value == 5760 ||
        value in 8192..8202 || value in setOf(8232,8233,8239,8287,12288,65279)
    fun between(before: String, after: String): Counts = calculate(withoutImageReferences(before),withoutImageReferences(after),false).counts
    fun changes(before: String, after: String): List<Change> = calculate(before,after,true).changes
    private fun calculate(before: String, after: String, withChanges: Boolean): Result {
        if(before==after)return Result(Counts(0,0),if(withChanges)listOf(Change("equal",before)) else emptyList())
        val old=before.codePoints().toArray();val next=after.codePoints().toArray()
        if(old.isEmpty())return Result(Counts(count(after),0),if(withChanges)listOf(Change("add",after)) else emptyList())
        if(next.isEmpty())return Result(Counts(0,count(before)),if(withChanges)listOf(Change("remove",before)) else emptyList())
        val paths=HashMap<Int,Path>()
        fun extend(path: Path, kind: String, length: Int) {
            if(!withChanges||length==0)return
            val prior=path.trail
            path.trail=if(prior?.kind==kind)Trail(kind,prior.length+length,prior.previous) else Trail(kind,length,prior)
        }
        fun common(path: Path, diagonal: Int): Int {
            var y=path.oldPosition-diagonal;var length=0
            while(path.oldPosition+1<old.size&&y+1<next.size&&old[path.oldPosition+1]==next[y+1]){path.oldPosition++;y++;length++}
            extend(path,"equal",length);return y
        }
        fun done(path: Path): Result {
            if(!withChanges)return Result(Counts(path.added,path.removed),emptyList())
            val trail=mutableListOf<Trail>();var entry=path.trail
            while(entry!=null){trail.add(entry);entry=entry.previous};trail.reverse()
            var x=0;var y=0
            val changes=trail.map { item ->
                val text=if(item.kind=="remove")String(old,x,item.length) else String(next,y,item.length)
                if(item.kind!="add")x+=item.length
                if(item.kind!="remove")y+=item.length
                Change(item.kind,text)
            }
            return Result(Counts(path.added,path.removed),changes)
        }
        val initial=Path(-1,0,0);common(initial,0);paths[0]=initial
        var minimum=Int.MIN_VALUE;var maximum=Int.MAX_VALUE;var steps=0
        for(distance in 1..(old.size+next.size)){
            var diagonal=maxOf(minimum,-distance)
            while(diagonal<=minOf(maximum,distance)){
                // Never block the library executor indefinitely on pathological rewrites.
                // Callers preserve drafts or report unavailable statistics, without guessing.
                check(++steps<=20_000_000) { "WRITING_DIFF_TOO_COMPLEX" }
                val remove=paths.remove(diagonal-1);val add=paths[diagonal+1]
                val nextAddedPosition=add?.oldPosition?.minus(diagonal)
                val canAdd=nextAddedPosition!=null&&nextAddedPosition>=0&&nextAddedPosition<next.size
                val canRemove=remove!=null&&remove.oldPosition+1<old.size
                if(!canAdd&&!canRemove){paths.remove(diagonal);diagonal+=2;continue}
                val path=if(!canRemove||(canAdd&&remove!!.oldPosition<add!!.oldPosition)){
                    Path(add!!.oldPosition,add.added+if(space(next[nextAddedPosition!!]))0 else 1,add.removed,add.trail).also { extend(it,"add",1) }
                }else Path(remove!!.oldPosition+1,remove.added,remove.removed+if(space(old[remove.oldPosition+1]))0 else 1,remove.trail).also { extend(it,"remove",1) }
                val y=common(path,diagonal)
                if(path.oldPosition+1>=old.size&&y+1>=next.size)return done(path)
                paths[diagonal]=path
                if(path.oldPosition+1>=old.size)maximum=minOf(maximum,diagonal-1)
                if(y+1>=next.size)minimum=maxOf(minimum,diagonal+1)
                diagonal+=2
            }
        }
        error("WRITING_DIFF_INVALID")
    }
}
