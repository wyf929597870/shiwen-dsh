package io.github.wyf929597870.shiwen.library

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.json.JSONArray
import org.json.JSONObject

class LibraryRecoveryProgressTest {
    @Test fun jsonArrayComparisonIgnoresObjectKeyOrderButPreservesArrayOrder() {
        assertTrue(canonicalJsonArrayEquals(
            """[{"text":"原话","origin":"personal"}]""",
            """[{"origin":"personal","text":"原话"}]"""))
        assertFalse(canonicalJsonArrayEquals(
            """[{"id":"a"},{"id":"b"}]""",
            """[{"id":"b"},{"id":"a"}]"""))
        assertFalse(canonicalJsonArrayEquals(
            """[{"text":"原话","origin":"personal"}]""",
            """[{"text":"改写","origin":"personal"}]"""))
        assertFalse(canonicalJsonArrayEquals("not-json", "not-json"))
    }

    @Test fun localFailureRemainsVisibleWhileRemoteSetupIsReceiving() {
        assertEquals("failed", LibraryRecoveryCoordinator.progressState(
            taskState = "failed", remoteState = "receiving", remoteKind = "setup",
            candidateCount = 0, resolvedCandidateCount = 0))
    }

    @Test fun successfulRemoteStatesKeepTheirExistingMappings() {
        assertEquals("aligning", LibraryRecoveryCoordinator.progressState(
            taskState = "running", remoteState = "committed", remoteKind = "setup",
            candidateCount = 0, resolvedCandidateCount = 0))
        assertEquals("needsReview", LibraryRecoveryCoordinator.progressState(
            taskState = "running", remoteState = "ready", remoteKind = "reconcile",
            candidateCount = 2, resolvedCandidateCount = 1))
        assertEquals("completed", LibraryRecoveryCoordinator.progressState(
            taskState = "running", remoteState = "completed", remoteKind = "reconcile",
            candidateCount = 0, resolvedCandidateCount = 0))
    }

    @Test fun localReviewAndAlignmentRemainDistinctFromCompleted() {
        assertEquals("needsReview", LibraryRecoveryCoordinator.recoveryState("needs-review", "completed"))
        assertEquals("aligning", LibraryRecoveryCoordinator.recoveryState("syncing", "completed"))
        assertEquals("completed", LibraryRecoveryCoordinator.recoveryState("complete", "completed"))
        assertEquals("failed", LibraryRecoveryCoordinator.recoveryState("failed", "completed"))
        assertEquals("failed", LibraryRecoveryCoordinator.recoveryState("syncing", "failed"))
    }

    @Test fun onlyFrozenOperationsWhoseExactVersionIsInSnapshotAreCovered() {
        val coverage = SnapshotCoverage(
            listOf(
                SnapshotCoveredOperation("op-a", "record-a", "version-a"),
                SnapshotCoveredOperation("op-b", "record-a", "version-b"),
                SnapshotCoveredOperation("op-c", "record-c", "version-c")),
            setOf("record-a" to "version-a", "record-c" to "version-other"))
        assertEquals(setOf("op-a"), coveredOperationIds(coverage))
    }

    @Test fun failureCodeIdentifiesOnlyActionAndSafeProtocolCode() {
        assertEquals("RECOVERY_SETUPBLOBPART_VALIDATION_ERROR",
            LibraryRecoveryCoordinator.failureCode("setupBlobPart", "VALIDATION_ERROR"))
        assertEquals("RECOVERY_SETUPPAGE_ATTACHMENTS_VALIDATION_ERROR",
            LibraryRecoveryCoordinator.failureCode("setupPage", "VALIDATION_ERROR", "attachments"))
        assertEquals("RECOVERY_SETUPPAGE_REQUEST_FAILED",
            LibraryRecoveryCoordinator.failureCode("setupPage", "document text must not leak"))
    }

    @Test fun recoveryNormalizesImportOnlyProvenanceForStrictWireContract() {
        val source = JSONObject().put("import", JSONObject().put("sourceName", "original.md"))
        val wire = LibraryRecoveryCoordinator.normalizeProvenance(source, "record-1")
        assertEquals("record-1", wire.getString("recordId"))
        assertEquals("original.md", wire.getJSONObject("import").getString("sourceName"))
        assertEquals(JSONObject.NULL, wire.getJSONObject("import").get("contentDay"))
        assertEquals("", wire.getJSONObject("import").getString("dateBasis"))
        assertEquals(0, wire.getJSONArray("sources").length())
        assertEquals(0, wire.getJSONArray("externalSources").length())

        val alreadyPresent = JSONObject().put("recordId", "record-2")
            .put("sources", JSONArray().put(JSONObject().put("sourceRecordId", "record-1")))
            .put("externalSources", JSONArray())
        val normalized = LibraryRecoveryCoordinator.normalizeProvenance(alreadyPresent, "record-2")
        assertEquals(alreadyPresent.getJSONArray("sources").toString(), normalized.getJSONArray("sources").toString())
    }

    @Test fun missingImportDateFieldsFallBackToRecordButExplicitNullIsPreserved() {
        val missing = JSONObject().put("import", JSONObject().put("sourceName", "original.md"))
        val filled = LibraryRecoveryCoordinator.normalizeProvenance(missing, "record-1", "2024-04-01", "imported")
        assertEquals("2024-04-01", filled.getJSONObject("import").getString("contentDay"))
        assertEquals("imported", filled.getJSONObject("import").getString("dateBasis"))

        val explicitNull = JSONObject().put("import", JSONObject().put("contentDay", JSONObject.NULL)
            .put("dateBasis", "unknown"))
        val preserved = LibraryRecoveryCoordinator.normalizeProvenance(explicitNull, "record-2", "2024-04-02", "manual")
        assertEquals(JSONObject.NULL, preserved.getJSONObject("import").get("contentDay"))
        assertEquals("unknown", preserved.getJSONObject("import").getString("dateBasis"))
    }

    @Test fun unknownSetupCommitOutcomeIsResolvedFromRemoteStatus() {
        assertEquals("use-result", LibraryRecoveryCoordinator.setupCommitStatusAction("committed", true))
        assertEquals("retry", LibraryRecoveryCoordinator.setupCommitStatusAction("ready", false))
        assertEquals("not-ready", LibraryRecoveryCoordinator.setupCommitStatusAction("receiving", false))
        assertEquals("missing-result", LibraryRecoveryCoordinator.setupCommitStatusAction("committed", false))
        assertEquals("unknown", LibraryRecoveryCoordinator.setupCommitStatusAction("other", false))
    }

    @Test fun versionDocumentPreservesMarkdownAndSegmentProvenance() {
        val sources = JSONArray()
            .put(JSONObject().put("text", "**标题**\n原话：").put("origin", "personal").put("sourceRef", "voice:1"))
            .put(JSONObject().put("text", "整理内容").put("origin", "ai"))
        val markdown = "**标题**\n原话：整理内容"
        val doc = LibraryRecoveryCoordinator.versionDocument(markdown, sources)
        assertEquals("doc", doc.getString("type"))
        val paragraphs = doc.getJSONArray("content")
        assertEquals(2, paragraphs.length())
        val firstNodes = paragraphs.getJSONObject(0).getJSONArray("content")
        assertEquals("**标题**", firstNodes.getJSONObject(0).getString("text"))
        assertEquals("personal", firstNodes.getJSONObject(0).getJSONArray("marks").getJSONObject(0)
            .getJSONObject("attrs").getString("origin"))
        assertEquals("voice:1", firstNodes.getJSONObject(0).getJSONArray("marks").getJSONObject(0)
            .getJSONObject("attrs").getString("sourceRef"))
        val secondNodes = paragraphs.getJSONObject(1).getJSONArray("content")
        assertEquals("原话：", secondNodes.getJSONObject(0).getString("text"))
        assertEquals("整理内容", secondNodes.getJSONObject(1).getString("text"))
        assertEquals("ai", paragraphs.getJSONObject(1).getJSONArray("content").getJSONObject(1)
            .getJSONArray("marks").getJSONObject(0).getJSONObject("attrs").getString("origin"))

        val empty = LibraryRecoveryCoordinator.versionDocument("", JSONArray())
        assertEquals(1, empty.getJSONArray("content").length())
        assertEquals(0, empty.getJSONArray("content").getJSONObject(0).getJSONArray("content").length())

        val richDoc = JSONObject().put("type", "doc").put("content", JSONArray().put(JSONObject()
            .put("type", "paragraph").put("content", JSONArray().put(JSONObject().put("type", "text")
                .put("text", "标题").put("marks", JSONArray().put(JSONObject().put("type", "bold")))))))
        assertEquals(richDoc.toString(), LibraryRecoveryCoordinator.versionDocument("**标题**",
            JSONArray().put(JSONObject().put("text", "**标题**").put("origin", "personal")), richDoc).toString())
    }
}
