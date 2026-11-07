package io.github.wyf929597870.shiwen.network

import org.json.JSONArray
import org.json.JSONObject

/** Fixed, user-triggered actions for the selected remote Shiwen agent. This deliberately exposes
 * no arbitrary RPC method/path and never reads the mutable active-node setting. */
internal class NodeAgentActions(private val store: NodeSettingsStore,
    private val connection: NodeConnection = NodeConnection(store)) {

    fun state(id: String): JSONObject {
        return readState(id).first
    }

    private fun projectState(call: BoundNodeAgentResult): JSONObject {
        boundNode(call)
        val raw = call.value as? JSONObject ?: error("NODE_AGENT_STATE_INVALID")
        val identity = document(raw, "identity")
        val soul = document(raw, "soul")
        val memories = JSONArray()
        val rows = raw.optJSONArray("memories") ?: JSONArray()
        for (i in 0 until rows.length()) {
            val memory = rows.optJSONObject(i) ?: continue
            if (memory.optString("scope") != "global") continue
            if (memory.optString("category") !in setOf("user", "memory")) continue
            if (memory.optString("status") !in setOf("active", "pending")) continue
            val idValue = memory.optString("id")
            val body = memory.optString("body")
            if (idValue.isBlank() || body.isBlank()) continue
            memories.put(JSONObject().put("id", idValue).put("body", body)
                .put("category", memory.getString("category")).put("status", memory.getString("status"))
                .put("revision", revision(memory, "revision"))
                .put("evidence", memory.optString("evidence", ""))
                .put("updated", memory.optString("updated", "")))
        }
        return JSONObject().put("identity", identity).put("soul", soul).put("memories", memories)
    }

    fun saveDocument(id: String, name: String, body: String, revision: Int): JSONObject {
        val call = connection.agentDocumentSave(id, name, body, revision)
        val item = (call.value as? JSONObject)?.takeIf {
            it.optString("name") == name && it.optString("body").isNotEmpty() &&
                ((it.opt("revision") as? Number)?.toInt() ?: -1) > revision
        } ?: error("NODE_WRITE_RESULT_UNKNOWN")
        return writeResult(id, call, whitelistItem(item))
    }

    fun saveMemory(id: String, memoryId: String?, body: String, category: String, revision: Int?): JSONObject {
        val boundTo = if (memoryId.isNullOrBlank()) null else {
            val (snapshot, stateCall) = readState(id)
            requireGlobalMemory(snapshot, memoryId, revision)
            stateCall
        }
        val call = connection.memorySave(id, memoryId, body, category, revision, boundTo)
        val item = (call.value as? JSONObject)?.takeIf {
            it.optString("body").isNotEmpty() && it.optString("category") == category &&
                it.optString("status") == "active" && ((it.opt("revision") as? Number)?.toInt() ?: -1) > 0 &&
                it.optString("id").isNotBlank() && (memoryId == null || it.optString("id") == memoryId)
        } ?: error("NODE_WRITE_RESULT_UNKNOWN")
        return writeResult(id, call, whitelistItem(item))
    }

    fun decideMemory(id: String, memoryId: String, revision: Int, accept: Boolean): JSONObject {
        val (snapshot, stateCall) = readState(id)
        requireGlobalMemory(snapshot, memoryId, revision, expectedStatus = "pending")
        val call = connection.memoryDecide(id, memoryId, revision, accept, stateCall)
        val expectedStatus = if (accept) "active" else "rejected"
        val item = (call.value as? JSONObject)?.takeIf {
            it.optString("id") == memoryId && it.optString("status") == expectedStatus &&
                ((it.opt("revision") as? Number)?.toInt() ?: -1) > revision
        } ?: error("NODE_WRITE_RESULT_UNKNOWN")
        return writeResult(id, call, whitelistItem(item))
    }

    fun deleteMemory(id: String, memoryId: String, revision: Int): JSONObject {
        val (snapshot, stateCall) = readState(id)
        requireGlobalMemory(snapshot, memoryId, revision, expectedStatus = "active")
        val call = connection.memoryDelete(id, memoryId, revision, stateCall)
        check(call.value == true) { "NODE_WRITE_RESULT_UNKNOWN" }
        return writeResult(id, call, JSONObject().put("id", memoryId).put("status", "deleted"))
    }

    private fun writeResult(id: String, call: BoundNodeAgentResult, item: JSONObject): JSONObject {
        // The write response is authoritative. A later profile refresh is a separate operation;
        // its failure must never turn this into a write failure that could prompt a duplicate POST.
        val result = JSONObject().put("saved", true).put("profileSynced", false).put("nodeChanged", call.nodeChanged)
        result.put("item", item)
        if (call.nodeChanged) return result.put("syncError", "NODE_CHANGED")
        try {
            boundNode(call)
            connection.refresh(id, expectedBaseUrl = call.baseUrl, expectedConfigRevision = call.configRevision)
            val profile = boundNode(call).optJSONObject("profile") ?: error("PROFILE_NOT_SYNCED")
            result.put("profileSynced", true).put("profileRevision", profile.getString("revision"))
        } catch (error: Exception) {
            if (error.message == "NODE_CHANGED") result.put("nodeChanged", true)
            result.put("syncError", error.message?.take(160) ?: "PROFILE_SYNC_FAILED")
        }
        return result
    }

    private fun boundNode(call: BoundNodeAgentResult): JSONObject {
        val row = store.get(call.nodeId)
        check(row.optString("baseUrl") == call.baseUrl &&
            row.optString("configRevision") == call.configRevision) { "NODE_CHANGED" }
        return row
    }

    private fun readState(id: String): Pair<JSONObject, BoundNodeAgentResult> {
        val call = connection.agentState(id)
        boundNode(call)
        return projectState(call) to call
    }

    private fun requireGlobalMemory(state: JSONObject, memoryId: String, expectedRevision: Int?, expectedStatus: String? = null) {
        require(!memoryId.isBlank()) { "INVALID_MEMORY_REQUEST" }
        val rows = state.getJSONArray("memories")
        val memory = (0 until rows.length()).map(rows::getJSONObject).firstOrNull { it.optString("id") == memoryId }
            ?: error("MEMORY_NOT_FOUND_OR_OUT_OF_SCOPE")
        check(expectedStatus == null || memory.optString("status") == expectedStatus) { "MEMORY_STATE_CHANGED" }
        check(expectedRevision != null && memory.getInt("revision") == expectedRevision) { "记忆已变更，请刷新后再保存" }
    }

    private fun document(state: JSONObject, key: String): JSONObject {
        val value = state.optJSONObject(key) ?: error("NODE_AGENT_STATE_INVALID")
        val body = value.optString("body")
        check(body.isNotEmpty() && value.has("revision")) { "NODE_AGENT_STATE_INVALID" }
        return JSONObject().put("body", body).put("revision", revision(value, "revision"))
    }

    private fun whitelistItem(value: JSONObject): JSONObject = JSONObject().apply {
        for (key in listOf("id", "name", "body", "category", "status", "revision", "evidence", "updated")) {
            if (value.has(key)) put(key, value.get(key))
        }
    }

    private fun revision(value: JSONObject, key: String): Int {
        val number = value.opt(key) as? Number ?: error("NODE_AGENT_STATE_INVALID")
        return number.toInt().also { check(it >= 0 && it.toDouble() == number.toDouble()) { "NODE_AGENT_STATE_INVALID" } }
    }
}
