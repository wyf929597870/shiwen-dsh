package io.github.wyf929597870.shiwen.library

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class TopicMergeTest {
    private val first = "2026-01-01T08:00:00Z"
    private val second = "2026-01-01T09:00:00Z"
    private val third = "2026-01-01T10:00:00Z"
    private fun theme(title:String, at:String, vararg members:String) =
        obj("title" to title,"summary" to "summary","updated" to at,"titleUpdated" to at,
            "summaryUpdated" to first,"members" to JSONArray(members.map { obj("id" to it) }))
    private val base = obj("title" to "initial","summary" to "summary","ids" to JSONArray(listOf("shared")),
        "updated" to first,"titleUpdated" to first,"summaryUpdated" to first)

    @Test fun timeOfFieldEditWinsRegardlessOfReconnectOrder() {
        // The phone added a passage after the desktop rename, while its own rename was earlier.
        val phone = theme("phone",second,"shared","phone quote").put("updated","2026-01-01T11:00:00Z")
        val desktop = theme("desktop",third,"shared","desktop quote")
        val merged = mergeTopic(base,phone,desktop,null,null)!!
        assertEquals("desktop",merged.getString("title"))
        assertEquals(setOf("shared","phone quote","desktop quote"),merged.getJSONArray("members").objects().map { it.getString("id") }.toSet())
        phone.put("titleUpdated","2026-01-01T11:00:00Z")
        assertEquals("phone",mergeTopic(base,phone,desktop,null,null)!!.getString("title"))
        phone.put("titleUpdated",third)
        assertEquals("desktop",mergeTopic(base,phone,desktop,null,null)!!.getString("title"))
    }

    @Test fun removalOfSharedPassagePreservesIndependentAddition() {
        val result=mergeTopic(base,theme("initial",second),theme("initial",third,"shared","new"),null,null)!!
        assertEquals(listOf("new"),result.getJSONArray("members").objects().map { it.getString("id") })
    }

    @Test fun concurrentDeletionAndEditUseTheirOwnTimestamps() {
        assertNull(mergeTopic(base,null,theme("desktop",second),third,null))
        assertEquals("desktop",mergeTopic(base,null,theme("desktop",third),second,null)!!.getString("title"))
        assertNull(mergeTopic(base,theme("phone",second),null,null,third))
        assertEquals("phone",mergeTopic(base,theme("phone",third),null,null,second)!!.getString("title"))
    }
}
