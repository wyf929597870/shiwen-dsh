package io.github.wyf929597870.shiwen.library

import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Base64

class WritingDeltaTest {
    @Test fun unicodeAndWhitespaceCountsMatchDesktopDiffFixtures() {
        val lines=javaClass.classLoader!!.getResourceAsStream("writing-delta.tsv")!!.bufferedReader().readLines()
        for((index,line) in lines.withIndex()){
            val fields=line.split('\t');val before=String(Base64.getDecoder().decode(fields[0]),Charsets.UTF_8)
            val after=String(Base64.getDecoder().decode(fields[1]),Charsets.UTF_8);val result=WritingDelta.between(before,after)
            assertEquals("Fixture $index additions",fields[2].toInt(),result.added)
            assertEquals("Fixture $index removals",fields[3].toInt(),result.removed)
            val pieces=WritingDelta.changes(before,after)
            assertEquals(before,pieces.filter { it.kind!="add" }.joinToString(""){it.text})
            assertEquals(after,pieces.filter { it.kind!="remove" }.joinToString(""){it.text})
            assertEquals(result.added,pieces.filter { it.kind=="add" }.sumOf { WritingDelta.count(it.text) })
            assertEquals(result.removed,pieces.filter { it.kind=="remove" }.sumOf { WritingDelta.count(it.text) })
        }
        assertEquals(2,WritingDelta.count("甲😀 \n\u00a0\uFEFF"))
    }
    @Test fun separatedEditsDoNotRelabelUnchangedMiddleText() {
        val changes=WritingDelta.changes("前言\n原有AI内容😀\n末尾","新前言\n原有AI内容😀\n末尾补充")
        assertEquals(listOf("新","补充"),changes.filter { it.kind=="add" }.map { it.text })
        assertEquals("前言\n原有AI内容😀\n末尾",changes.filter { it.kind=="equal" }.joinToString(""){it.text})
    }
    @Test fun longAppendDoesNotCountUnchangedTextAgain() {
        val before="每天记录一点。".repeat(100_000)
        assertEquals(WritingDelta.Counts(3,0),WritingDelta.between(before,before+"新想法\n"))
    }
}
