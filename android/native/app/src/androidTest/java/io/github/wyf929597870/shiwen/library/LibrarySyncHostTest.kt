package io.github.wyf929597870.shiwen.library

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.wyf929597870.shiwen.network.NodeConnection
import io.github.wyf929597870.shiwen.network.NodeSettingsStore
import io.github.wyf929597870.shiwen.model.Canonical
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/** Synthetic Host only. Never uses the app's node store, active library, or password. */
@RunWith(AndroidJUnit4::class)
class LibrarySyncHostTest {
    @get:org.junit.Rule val foreground = ForegroundIntegrationRule()
    @Test fun fullSnapshotAndRepeatedOfflineEditsConvergeWithRealHost() {
        val args = InstrumentationRegistry.getArguments()
        val host = args.getString("syntheticHost")
        val password = args.getString("syntheticPassword")
        assumeTrue(!host.isNullOrBlank() && !password.isNullOrBlank())
        requireNotNull(host); requireNotNull(password)
        val uri = java.net.URI(host)
        require(uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port in 1..65535 && uri.rawQuery == null)
        val context = ApplicationProvider.getApplicationContext<Context>()
        val suffix = args.getString("registrySuffix") ?: UUID.randomUUID().toString()
        val nodes = NodeSettingsStore(context,"sync-host-node-$suffix")
        val manager = LibraryManager(context,"sync-host-registry-$suffix","sync-host-legacy-$suffix")
        val coordinator = LibrarySyncCoordinator(context,manager,nodes)
        try {
            val nodeId = nodes.save(null,"Synthetic sync service",host,true).getString("id")
            val connection = NodeConnection(nodes)
            connection.refresh(nodeId,password)
            val connected = coordinator.connect(nodeId)
            val libraryId = connected.getString("libraryId")
            fun awaitOperation(operation: JSONObject) {
                val operationId = operation.getString("operationId")
                val deadline = System.nanoTime() + 60_000_000_000L
                while (System.nanoTime() < deadline) {
                    val progress = coordinator.progress(libraryId,operationId)
                    if (progress.optString("state") == "completed") return
                    if (progress.optString("state") == "failed") fail("Native sync failed: $progress")
                    Thread.sleep(50)
                }
                fail("Native sync did not finish: ${coordinator.progress(libraryId,operationId)}")
            }
            awaitOperation(connected)
            val repo = manager.openLibrary(libraryId)
            if(args.getString("oldComputer")=="true"){
                val poolClass=Class.forName("io.github.wyf929597870.shiwen.library.PhoneExploration")
                val pool=poolClass.getConstructor(LibraryRepository::class.java).newInstance(repo)
                val status=poolClass.getMethod("execute",String::class.java,JSONObject::class.java).invoke(pool,"explorationSyncStatus",JSONObject()) as JSONObject
                assertEquals("upgrade_required",status.getJSONObject("status").getString("state"))
            }
            val seeded = repo.read(args.getString("syntheticRecordId")!!)
            assertEquals("2024-03-01",seeded.contentDay)
            assertEquals("formatting",seeded.processing)
            assertEquals("original:fixture-voice",JSONArray(seeded.sourcesJson).getJSONObject(0).getString("sourceRef"))
            assertEquals("complete",coordinator.status(libraryId).getString("integrity"))
            assertEquals(repo.dao.head(seeded.id)?.versionId,seeded.versionId)

            val create = repo.create(UUID.randomUUID().toString(),JSONObject()
                .put("kind","journal").put("title","Android sync fixture")
                .put("markdown","离线第一天").put("origin","personal")
                .put("processing","original").put("contentDay","2024-03-02"),1)
            fun remoteEdit(before: LibraryRecord, remoteText:String) {
                val remoteHead = repo.dao.remoteHead(before.id)!!
                val remoteDevice = UUID.randomUUID().toString()
                val revision = nodes.get(nodeId).getString("configRevision")
                // Kotlin internal methods include the build variant in their JVM names.
                val syncMethod=connection.javaClass.methods.single { it.name.startsWith("mobileSync$") && it.parameterTypes.size==5 }
                fun remote(action:String,body:JSONObject) = (syncMethod.invoke(connection,nodeId,action,body,revision,true) as JSONObject).getJSONObject("data")
                remote("identity",JSONObject().put("protocolVersion","1.0.0-draft.3").put("deviceId",remoteDevice))
                val remoteSources = JSONArray().put(JSONObject().put("text",remoteText).put("origin","personal"))
                val remotePayload = JSONObject(remoteHead.recordJson).apply {
                    put("markdown",remoteText);put("sources",remoteSources);put("updatedAt",java.time.Instant.now().toString())
                    for(key in listOf("revision","versionId","changeId","baseVersionId","serverRevision","localGeneration","syncState","doc")) remove(key)
                }
                val remoteOperation = JSONObject().put("operationId",UUID.randomUUID().toString()).put("recordId",before.id)
                    .put("changeId",UUID.randomUUID().toString()).put("versionId",UUID.randomUUID().toString())
                    .put("baseVersionId",remoteHead.versionId).put("parentVersionIds",JSONArray().put(remoteHead.versionId))
                    .put("originDeviceId",remoteDevice).put("action","update").put("baseRevision",remoteHead.revision)
                    .put("localGeneration",1).put("occurredAt",java.time.Instant.now().toString()).put("timeZone","Asia/Shanghai")
                    .put("payload",remotePayload).put("activities",JSONArray().put(JSONObject()
                        .put("activityId",UUID.randomUUID().toString()).put("originDeviceId",remoteDevice)
                        .put("occurredAt",java.time.Instant.now().toString()).put("timeZone","Asia/Shanghai")
                        .put("beforeHash", contentHash(before.markdown,JSONArray(before.sourcesJson)))
                        .put("afterHash",contentHash(remoteText,remoteSources)).put("afterSegments",remoteSources)
                        .put("action","write").put("authorship","personal")))
                val pushed = remote("push",JSONObject().put("libraryId",libraryId).put("epoch",repo.registryItem().epoch)
                    .put("deviceId",remoteDevice).put("operations",JSONArray().put(JSONObject().put("inlineBody",remoteOperation))))
                assertEquals("applied",pushed.getJSONArray("receipts").getJSONObject(0).getString("status"))
            }
            val compatibilityRun=args.containsKey("oldApkPath") || args.getString("oldComputer")=="true"
            if(compatibilityRun) remoteEdit(seeded,"电脑更新了另一篇日记")
            val second = repo.update(create.id,create.revision,UUID.randomUUID().toString(),JSONObject().put("markdown","离线第一天\n第二天新增"))
            val third = repo.update(second.id,second.revision,UUID.randomUUID().toString(),JSONObject().put("markdown","离线第一天\n第二天新增\n第三天新增"))
            awaitOperation(coordinator.syncNow(libraryId,"manual"))
            assertEquals(0,coordinator.status(libraryId).getInt("pendingCount"))
            assertEquals(0,coordinator.status(libraryId).getInt("conflictCount"))
            val activityIds = repo.dao.activities(create.id).map { it.activityId }.toSet()
            assertEquals(3,activityIds.size)
            awaitOperation(coordinator.syncNow(libraryId,"manual"))
            assertEquals(activityIds,repo.dao.activities(create.id).map { it.activityId }.toSet())
            assertEquals(third.markdown,repo.read(create.id).markdown)
            assertEquals(3,repo.versions(create.id).size)

            if(compatibilityRun){
                val edited=repo.read(seeded.id)
                assertEquals("电脑更新了另一篇日记",edited.markdown)
                assertEquals(2,repo.versions(seeded.id).size)
                assertEquals(repo.dao.remoteHead(seeded.id)!!.versionId,edited.versionId)
                assertEquals(repo.dao.remoteHead(create.id)!!.versionId,repo.read(create.id).versionId)
                if(args.getString("oldComputer")=="true"){
                    val pool=PhoneExploration(repo)
                    val response=args.getString("queuedResponse")!!
                    val item=obj("externalItemId" to response,"text" to "升级后还能接着写吗？","type" to "explore",
                        "sources" to JSONArray().put(obj("recordId" to seeded.id,"revision" to 2)))
                    val submitted=pool.execute("shiwen_exploration_suggest",obj("requestId" to freshId(),"suggestions" to JSONArray().put(item)))
                    val question=submitted.getJSONArray("items").getJSONObject(0).getString("questionId")
                    pool.execute("shiwen_exploration_review",obj("action" to "accept","requestId" to freshId(),
                        "questionId" to question,"expectedRevision" to pool.detail(question).getInt("revision")))
                    pool.execute("shiwen_exploration_respond",obj("requestId" to freshId(),"questionId" to question,
                        "expectedRevision" to pool.detail(question).getInt("revision"),"responseRecordId" to response,"body" to "升级前保留的回应。"))
                    awaitOperation(coordinator.syncNow(libraryId,"manual"))
                    assertTrue(pool.rows("outbox",pool.local).isNotEmpty())
                    assertEquals("升级前保留的回应。",repo.read(response).markdown)
                }
                return
            }

            // The full operation exceeds an inline request: both its body and attachment
            // must cross the real chunk protocol before the server can acknowledge it.
            val longText = "长文资料".repeat(200_000)
            val originalBytes = longText.toByteArray()
            val longRecord = repo.importMarkdown(UUID.randomUUID().toString(), "Android long fixture", longText,
                JSONObject().put("kind", "reference").put("origin", "external").put("processing", "original")
                    .put("contentDay", "2024-03-03"), "long-original.md", originalBytes, "import")
            awaitOperation(coordinator.syncNow(libraryId,"manual"))
            val longOutbox = repo.dao.allOutbox().filter { it.recordId == longRecord.id }
            assertTrue("Long-record outbox states: ${longOutbox.map { it.state to it.lastError }}",
                longOutbox.isNotEmpty() && longOutbox.all { it.state == "applied" })
            assertEquals(0,coordinator.status(libraryId).getInt("pendingCount"))
            assertEquals(longText,repo.read(longRecord.id).markdown)
            val attachmentId = JSONArray(longRecord.attachmentDescriptorsJson).getJSONObject(0).getString("id")
            assertArrayEquals(originalBytes, repo.attachmentBytes(attachmentId))
            assertTrue(repo.dao.allAttachments().single { it.id == attachmentId }.uploaded)

            // Another device edits the same server head while this phone has an offline edit.
            val before = repo.read(create.id)
            val localEdit = repo.update(before.id,before.revision,UUID.randomUUID().toString(),
                JSONObject().put("markdown", before.markdown+"\n手机尚未上传的修改"))
            val remoteText = "服务端并发编辑"
            remoteEdit(before,remoteText)
            awaitOperation(coordinator.syncNow(libraryId,"manual"))
            assertEquals(1,coordinator.status(libraryId).getInt("conflictCount"))
            assertEquals(localEdit.markdown,repo.read(before.id).markdown)
            val conflict = repo.dao.conflicts(20,0).single()
            repo.resolveConflictRemote(conflict.id,conflict.remoteRevision!!,UUID.randomUUID().toString())
            awaitOperation(coordinator.syncNow(libraryId,"manual"))
            assertEquals(remoteText,repo.read(before.id).markdown)
            assertEquals(0,coordinator.status(libraryId).getInt("conflictCount"))
            assertTrue(repo.versions(before.id).any { it.markdown == localEdit.markdown })
        } finally {
            coordinator.closeForTest()
            if(args.getString("oldComputer")=="true")manager.close() else {
                manager.closeForTest()
                nodes.clearForTest()
            }
        }
    }
    private fun contentHash(markdown:String,sources:JSONArray):String = Canonical.hash(mapOf("markdown" to markdown,"segments" to plain(sources)))
    private fun plain(value:Any?):Any? = when(value) {
        JSONObject.NULL -> null
        is JSONObject -> value.keys().asSequence().associateWith { plain(value.get(it)) }
        is JSONArray -> (0 until value.length()).map { plain(value.get(it)) }
        else -> value
    }
}
