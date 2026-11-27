package io.github.wyf929597870.shiwen.library

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.wyf929597870.shiwen.network.NodeConnection
import io.github.wyf929597870.shiwen.network.NodeSettingsStore
import java.util.UUID
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Each phase starts in a fresh test-app process. The host runner physically removes the USB port mapping for offline edits. */
@RunWith(AndroidJUnit4::class)
class TopicSyncHostTest {
    @get:Rule val foreground = ForegroundIntegrationRule()

    @Test fun topicsConverge() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.containsKey("topicPhase"))
        fun arg(key:String) = requireNotNull(args.getString(key))
        val phase = arg("topicPhase")
        val library = UUID.fromString(arg("library")).toString()
        val host = java.net.URI(arg("host"))
        require(host.scheme=="http" && host.host=="127.0.0.1" && host.port>0)
        val context = ApplicationProvider.getApplicationContext<Context>()
        val manager = LibraryManager(context,"topic-test-registry-$library","topic-test-legacy-$library")
        val nodes = NodeSettingsStore(context,"topic-test-nodes-$library")
        val coordinator = LibrarySyncCoordinator(context,manager,nodes)
        fun waitFor(op:JSONObject,expected:String="completed") {
            val end = System.nanoTime()+60_000_000_000L
            var progress = JSONObject()
            while (System.nanoTime()<end) {
                progress = coordinator.progress(library,op.getString("operationId"))
                if (progress.optString("state") in setOf("completed","failed")) {
                    assertEquals(progress.toString(),expected,progress.getString("state"))
                    return
                }
                Thread.sleep(50)
            }
            fail("Sync timed out: $progress")
        }
        try {
            if (phase=="cleanup") return
            if (phase=="initial") {
                val node = nodes.save(null,"Isolated topic test",host.toString(),true).getString("id")
                NodeConnection(nodes).refresh(node,arg("password"))
                val started = coordinator.connect(node)
                assertEquals(library,started.getString("libraryId"))
                waitFor(started)
            }
            val repo = manager.openLibrary(library)
            val themes = WorkspaceThemes(repo)
            val id = arg("theme")
            fun topic(method:String,params:JSONObject=obj()) = themes.perform(obj("method" to method,"args" to params.put("expectedLibraryId",library)))
            fun read() = topic("themeRead",obj("id" to id)) as JSONObject
            fun rename(title:String) = topic("themeSave",obj("id" to id,"revision" to read().getInt("revision"),"title" to title,"summary" to read().getString("summary")))
            fun sync() = waitFor(coordinator.syncNow(library,"manual"))
            fun quotes() = read().getJSONArray("members").objects().map { it.getString("quote") }
            when (phase) {
                "initial" -> {
                    assertEquals(listOf("desktop passage"),quotes())
                    assertEquals("current",read().getJSONArray("members").getJSONObject(0).getJSONObject("location").getString("status"))
                }
                "offline" -> {
                    // Check the actual host port, independent of Android network state or retry policy.
                    assertTrue(runCatching { java.net.Socket().use { it.connect(java.net.InetSocketAddress(host.host,host.port),2000) } }.isFailure)
                    assertEquals(listOf("desktop passage"),quotes())
                    rename("phone earlier")
                    topic("themeMemberAdd",obj("themeId" to id,"revision" to read().getInt("revision"),
                        "sourceRecordId" to arg("source"),"sourceRevision" to repo.read(arg("source")).revision,
                        "field" to "body","start" to 16,"end" to 29,"quote" to "phone passage"))
                    topic("themeSave",obj("title" to "phone-created","summary" to "created offline"))
                    assertEquals(2,coordinator.status(library).getInt("pendingCount"))
                }
                "desktopWins" -> {
                    assertEquals("phone earlier",read().getString("title"))
                    assertTrue(quotes().contains("phone passage"))
                    sync()
                    assertEquals("desktop later",read().getString("title"))
                    assertEquals(3,quotes().distinct().size)
                    assertEquals("desktop description",read().getString("summary"))
                    assertEquals(0,coordinator.status(library).getInt("pendingCount"))
                }
                "phoneWins" -> {
                    assertEquals("desktop later",read().getString("title"))
                    rename("phone latest")
                    val member = read().getJSONArray("members").objects().single { it.getString("quote")=="desktop passage" }
                    topic("themeMemberRemove",obj("themeId" to id,"revision" to read().getInt("revision"),"memberId" to member.getString("id")))
                    sync()
                    assertEquals("phone latest",read().getString("title"))
                    assertEquals(setOf("phone passage","parallel"),quotes().toSet())
                    assertEquals("new desktop summary",read().getString("summary"))
                }
                "delete" -> {
                    sync()
                    val list = (topic("themeList") as JSONArray).objects()
                    assertEquals(listOf(id),list.map { it.getString("id") })
                    topic("themeDelete",obj("id" to id,"revision" to read().getInt("revision")))
                    sync()
                    sync()
                    assertEquals(0,(topic("themeList") as JSONArray).length())
                    assertEquals(0,coordinator.status(library).getInt("pendingCount"))
                }
                else -> error("Unknown phase")
            }
        } finally {
            coordinator.close()
            if (phase=="cleanup") { manager.closeForTest(); nodes.clearForTest() } else manager.close()
        }
    }
}
