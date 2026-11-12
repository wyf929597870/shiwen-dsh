package io.github.wyf929597870.shiwen.network

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import io.github.wyf929597870.shiwen.model.Canonical

internal data class BoundNodeAgentResult(val value: Any, val nodeId: String,
    val baseUrl: String, val configRevision: String, val nodeChanged: Boolean = false)
private class NodeHttpException(val status: Int, message: String) : Exception(message)

/** Auth and profile refresh share the node's exact-origin encrypted cookie jar. */
internal class NodeConnection(private val store: NodeSettingsStore) {
    fun refresh(id: String, password: String? = null, expectedBaseUrl: String? = null,
        expectedConfigRevision: String? = null) {
        val count = refreshing.getOrPut(id) { java.util.concurrent.atomic.AtomicInteger() }
        count.incrementAndGet()
        try { synchronized(locks.getOrPut(id) { Any() }) { performRefresh(id, password, expectedBaseUrl, expectedConfigRevision) } }
        finally { count.decrementAndGet() }
    }
    private fun performRefresh(id: String, password: String?, expectedBaseUrl: String?, expectedConfigRevision: String?) {
        val row = NodeReachability.resolve(store, id); val url = row.getString("baseUrl")
        val revision = row.getString("configRevision")
        check((expectedBaseUrl == null || expectedBaseUrl == url) &&
            (expectedConfigRevision == null || expectedConfigRevision == revision)) { "NODE_CHANGED" }
        val cookies = row.optJSONArray("cookies") ?: JSONArray()
        val client = NodeClient(url, row.optBoolean("allowPrivateHttp"), (0 until cookies.length()).map(cookies::getString), row.optString("fingerprint").takeIf { it.isNotEmpty() }, row.optString("token").takeIf { it.isNotEmpty() }) { next ->
            store.update(id, url, revision) { it.put("cookies", JSONArray(next)) }
        }
        try {
            if (password != null) {
                require(password.isNotEmpty() && password.toByteArray().size <= 1024) { "INVALID_PASSWORD" }
                val login = request(client, "/auth/login", JSONObject().put("password", password).put("remember", true).put("name", "Shiwen Android"))
                if (row.optString("fingerprint").isNotEmpty()) {
                    store.update(id, url, revision) { it.put("token", login.getString("token")) }
                    client.revoke(); performRefresh(id, null, expectedBaseUrl, expectedConfigRevision); return
                }
            }
            val status = request(client, "/auth/status")
            val authenticated = status.optBoolean("authenticated")
            store.update(id, url, revision) { it.put("authenticated", authenticated).put("connectionState", if (authenticated) "online" else "login-required").put("lastCheckedAt", Instant.now().toString()) }
            check(authenticated) { "NODE_LOGIN_REQUIRED" }
            // Existing authenticated workbench route; older servers respond unsupported.
            val response = request(client, "/api/shiwen", JSONObject().put("method", "mobileAgentProfile").put("args", JSONObject()))
            val profile = response.optJSONObject("result") ?: error("PROFILE_UNSUPPORTED")
            validateProfile(profile)
            store.update(id, url, revision) { it.put("profile", profile).put("profileSyncStatus", "synced").put("profileUpdatedAt", Instant.now().toString()) }
        } catch (e: Exception) {
            runCatching { store.update(id, url, revision) {
                if (e.message in listOf("NODE_LOGIN_REQUIRED", "NODE_AUTH_FAILED")) it.put("authenticated", false)
                it.put("profileSyncStatus", if (it.has("profile")) "cached" else "not-synced")
            } }
            throw e
        } finally { client.revoke() }
    }
    internal fun agentState(id: String): BoundNodeAgentResult = agentRpc(id, "agentState", JSONObject(), 1_048_576L)

    internal fun agentDocumentSave(id: String, name: String, body: String, revision: Int): BoundNodeAgentResult {
        require(name == "IDENTITY.md" || name == "SOUL.md") { "INVALID_AGENT_DOCUMENT" }
        require(revision >= 0) { "INVALID_REVISION" }
        require(body.isNotBlank() && body.toByteArray(Charsets.UTF_8).size <= 12_000) { "INVALID_AGENT_DOCUMENT_BODY" }
        return agentRpc(id, "agentDocumentSave", JSONObject().put("name", name).put("scope", "global")
            .put("body", body).put("revision", revision))
    }

    internal fun memorySave(id: String, memoryId: String?, body: String, category: String, revision: Int?,
        boundTo: BoundNodeAgentResult? = null): BoundNodeAgentResult {
        require(category == "user" || category == "memory") { "INVALID_MEMORY_CATEGORY" }
        require(body.isNotBlank() && body.length <= 10_000) { "INVALID_MEMORY_BODY" }
        require(memoryId.isNullOrBlank() || revision != null && revision >= 0) { "INVALID_REVISION" }
        val args = JSONObject().put("body", body).put("scope", "global").put("category", category)
        if (!memoryId.isNullOrBlank()) args.put("id", memoryId).put("revision", revision)
        return agentRpc(id, "memorySave", args, boundTo = boundTo)
    }

    internal fun memoryDecide(id: String, memoryId: String, revision: Int, accept: Boolean,
        boundTo: BoundNodeAgentResult? = null): BoundNodeAgentResult {
        require(memoryId.isNotBlank() && revision >= 0) { "INVALID_MEMORY_REQUEST" }
        return agentRpc(id, "memoryDecide", JSONObject().put("id", memoryId).put("revision", revision).put("accept", accept), boundTo = boundTo)
    }

    internal fun memoryDelete(id: String, memoryId: String, revision: Int,
        boundTo: BoundNodeAgentResult? = null): BoundNodeAgentResult {
        require(memoryId.isNotBlank() && revision >= 0) { "INVALID_MEMORY_REQUEST" }
        return agentRpc(id, "memoryDelete", JSONObject().put("id", memoryId).put("revision", revision), boundTo = boundTo)
    }

    internal fun mobileManagement(id: String, action: String, args: JSONObject, expectedConfigRevision: String? = null): JSONObject {
        require(action in MANAGEMENT_ACTIONS) { "NODE_MANAGEMENT_ACTION_DENIED" }
        require(args.toString().toByteArray(Charsets.UTF_8).size <= MANAGEMENT_ARGS_LIMIT) { "NODE_MANAGEMENT_ARGS_TOO_LARGE" }
        val write = action in MANAGEMENT_WRITE_ACTIONS
        val result = managementRpc(id, "mobileManagement", JSONObject().put("action", action).put("args", args), write, expectedConfigRevision)
        val envelope = result.value as? JSONObject ?: error(if (write) "NODE_WRITE_RESULT_UNKNOWN" else "NODE_RPC_RESULT_UNKNOWN")
        check(envelope.optString("action") == action && envelope.has("data") && envelope.get("data") != JSONObject.NULL) {
            if (write) "NODE_WRITE_RESULT_UNKNOWN" else "NODE_RPC_RESULT_UNKNOWN"
        }
        return JSONObject().put("action", action).put("data", envelope.get("data"))
            .put("nodeChanged", result.nodeChanged)
    }

    /** Fixed native surface for remote chat sessions. Writes are never retried by this client. */
    internal fun mobileSessions(id: String, action: String, args: JSONObject, expectedConfigRevision: String? = null): JSONObject {
        require(action in SESSION_ACTIONS) { "NODE_SESSION_ACTION_DENIED" }
        require(args.toString().toByteArray(Charsets.UTF_8).size <= SESSION_ARGS_LIMIT) { "NODE_SESSION_ARGS_TOO_LARGE" }
        val write = action in SESSION_WRITE_ACTIONS
        val bound = sessionRpc(id, action, args, write, expectedConfigRevision)
        val data = bound.value as? JSONObject
            ?: error(if (write) "NODE_SESSION_WRITE_UNKNOWN" else "NODE_SESSION_RESULT_UNKNOWN")
        check(data.optString("action") == action && data.has("data")) {
            if (write) "NODE_SESSION_WRITE_UNKNOWN" else "NODE_SESSION_RESULT_UNKNOWN"
        }
        return JSONObject().put("action", action).put("data", data.get("data")).put("nodeChanged", bound.nodeChanged)
    }

    /** Versioned offline-library RPC. It exposes only frozen protocol actions, never arbitrary HTTP paths. */
    internal fun mobileSync(id: String, action: String, requestBody: JSONObject,
        expectedConfigRevision: String? = null, retryRead: Boolean = true): JSONObject {
        require(action in MOBILE_SYNC_ACTIONS) { "MOBILE_SYNC_ACTION_DENIED" }
        require(requestBody.toString().toByteArray(Charsets.UTF_8).size <= MOBILE_SYNC_REQUEST_LIMIT) { "MOBILE_SYNC_REQUEST_TOO_LARGE" }
        val write = action in MOBILE_SYNC_WRITE_ACTIONS
        val row = NodeReachability.resolve(store, id)
        check(row.optBoolean("authenticated")) { "NODE_LOGIN_REQUIRED" }
        val url = row.getString("baseUrl")
        val revision = row.getString("configRevision")
        check(expectedConfigRevision == null || expectedConfigRevision == revision) { "NODE_CHANGED" }
        val cookies = row.optJSONArray("cookies") ?: JSONArray()
        val client = NodeClient(url, row.optBoolean("allowPrivateHttp"), (0 until cookies.length()).map(cookies::getString), row.optString("fingerprint").takeIf { it.isNotEmpty() }, row.optString("token").takeIf { it.isNotEmpty() }) { next ->
            store.update(id, url, revision) { it.put("cookies", JSONArray(next)) }
        }
        return try {
            val envelope = try {
                request(client, "/api/shiwen", JSONObject().put("method", "mobileSync")
                    .put("args", JSONObject().put("action", action).put("request", requestBody)),
                    MOBILE_SYNC_RESPONSE_LIMIT, safeErrors = true)
            } catch (failure: Exception) {
                if (write && !isDefiniteSyncRejection(failure)) error("MOBILE_SYNC_WRITE_UNKNOWN")
                if (!write && retryRead && failure is java.io.IOException && row.optString("fingerprint").isNotEmpty()) {
                    client.revoke()
                    val connected = NodeReachability.resolve(store, id, true)
                    if (connected.getString("configRevision") == revision && connected.optString("connectionState") == "online")
                        return mobileSync(id, action, requestBody, revision, false)
                }
                throw failure
            }
            val result = envelope.optJSONObject("result") ?: error(if (write) "MOBILE_SYNC_WRITE_UNKNOWN" else "MOBILE_SYNC_RESULT_UNKNOWN")
            check(result.optString("action") == action && result.has("data") && result.get("data") is JSONObject) {
                if (write) "MOBILE_SYNC_WRITE_UNKNOWN" else "MOBILE_SYNC_RESULT_UNKNOWN"
            }
            val latest = runCatching { store.get(id) }.getOrNull()
            val changed = latest == null || (row.optString("fingerprint").isEmpty() && latest.optString("baseUrl") != url) || latest.optString("configRevision") != revision
            check(!changed || write) { "NODE_CHANGED" }
            JSONObject().put("action", action).put("data", result.getJSONObject("data")).put("nodeChanged", changed)
                .put("configRevision", revision).put("nodeId", id)
        } finally { client.revoke() }
    }

    private fun isDefiniteSyncRejection(error: Exception): Boolean {
        val rejection = error as? NodeHttpException ?: return false
        return rejection.status in setOf(401, 403, 404, 409, 413, 422) ||
            (rejection.status == 400 && rejection.message in MOBILE_SYNC_REJECTION_CODES)
    }

    private fun sessionRpc(id: String, action: String, args: JSONObject, write: Boolean,
        expectedConfigRevision: String?): BoundNodeAgentResult {
        require(id.isNotBlank()) { "NODE_ID_REQUIRED" }
        val row = NodeReachability.resolve(store, id)
        check(row.optBoolean("authenticated")) { "NODE_LOGIN_REQUIRED" }
        val url = row.getString("baseUrl")
        val revision = row.getString("configRevision")
        check(expectedConfigRevision == null || expectedConfigRevision == revision) { "NODE_CHANGED" }
        val cookies = row.optJSONArray("cookies") ?: JSONArray()
        val client = NodeClient(url, row.optBoolean("allowPrivateHttp"), (0 until cookies.length()).map(cookies::getString), row.optString("fingerprint").takeIf { it.isNotEmpty() }, row.optString("token").takeIf { it.isNotEmpty() }) { next ->
            store.update(id, url, revision) { it.put("cookies", JSONArray(next)) }
        }
        return try {
            val envelope = try {
                request(client, "/api/shiwen", JSONObject().put("method", "mobileSessions")
                    .put("args", JSONObject().put("action", action).put("args", args)), SESSION_RESPONSE_LIMIT, safeErrors = true)
            } catch (failure: Exception) {
                if (write && !isDefiniteSessionRejection(failure)) error("NODE_SESSION_WRITE_UNKNOWN")
                throw failure
            }
            check(envelope.has("result")) { if (write) "NODE_SESSION_WRITE_UNKNOWN" else "NODE_SESSION_RESULT_UNKNOWN" }
            val latest = runCatching { store.get(id) }.getOrNull()
            val changed = latest == null || (row.optString("fingerprint").isEmpty() && latest.optString("baseUrl") != url) || latest.optString("configRevision") != revision
            check(!changed || write) { "NODE_CHANGED" }
            BoundNodeAgentResult(envelope.get("result"), id, url, revision, changed)
        } finally { client.revoke() }
    }

    private fun isDefiniteSessionRejection(error: Exception): Boolean {
        val rejection = error as? NodeHttpException ?: return false
        return rejection.status in setOf(401, 403, 404, 409, 413, 422) ||
            (rejection.status == 400 && rejection.message in SESSION_REJECTION_CODES)
    }

    internal fun externalStatus(id: String): JSONObject {
        val bound = managementRpc(id, "externalStatus", JSONObject(), write = false)
        val result = bound.value as? JSONObject
            ?: error("NODE_RPC_RESULT_UNKNOWN")
        return JSONObject(result.toString()).put("nodeChanged", bound.nodeChanged)
    }

    internal fun externalClientCreate(id: String, name: String, scopes: List<String>): JSONObject {
        require(name.isNotBlank() && name.length <= 80) { "INVALID_EXTERNAL_CLIENT_NAME" }
        require(scopes.isNotEmpty() && scopes.size <= 8 && scopes.all { it in EXTERNAL_SCOPES }) { "INVALID_EXTERNAL_SCOPES" }
        val bound = managementRpc(id, "externalClientCreate", JSONObject()
            .put("name", name.trim()).put("scopes", JSONArray(scopes.distinct())), write = true)
        val result = bound.value as? JSONObject
            ?: error("NODE_WRITE_RESULT_UNKNOWN")
        check(result.optString("id").isNotBlank() && result.optString("token").matches(Regex("sw_[A-Za-z0-9_-]{43}")) &&
            result.optString("name").isNotBlank() && result.optJSONArray("scopes") != null && result.has("created")) {
            "NODE_WRITE_RESULT_UNKNOWN"
        }
        return JSONObject(result.toString()).put("nodeChanged", bound.nodeChanged)
    }

    internal fun externalClientRevoke(id: String, clientId: String): JSONObject {
        require(clientId.isNotBlank() && clientId.length <= 128) { "INVALID_EXTERNAL_CLIENT_ID" }
        val bound = managementRpc(id, "externalClientRevoke", JSONObject().put("id", clientId), write = true)
        val result = bound.value as? JSONObject
            ?: error("NODE_WRITE_RESULT_UNKNOWN")
        check(result.optBoolean("revoked")) { "NODE_WRITE_RESULT_UNKNOWN" }
        return JSONObject().put("revoked", true).put("nodeChanged", bound.nodeChanged)
    }

    private fun managementRpc(id: String, method: String, args: JSONObject, write: Boolean,
        expectedConfigRevision: String? = null): BoundNodeAgentResult {
        require(id.isNotBlank()) { "NODE_ID_REQUIRED" }
        val row = NodeReachability.resolve(store, id)
        check(row.optBoolean("authenticated")) { "NODE_LOGIN_REQUIRED" }
        val url = row.getString("baseUrl")
        val revision = row.getString("configRevision")
        check(expectedConfigRevision == null || expectedConfigRevision == revision) { "NODE_CHANGED" }
        val cookies = row.optJSONArray("cookies") ?: JSONArray()
        val client = NodeClient(url, row.optBoolean("allowPrivateHttp"), (0 until cookies.length()).map(cookies::getString), row.optString("fingerprint").takeIf { it.isNotEmpty() }, row.optString("token").takeIf { it.isNotEmpty() }) { next ->
            store.update(id, url, revision) { it.put("cookies", JSONArray(next)) }
        }
        return try {
            val envelope = try {
                request(client, "/api/shiwen", JSONObject().put("method", method).put("args", args),
                    MANAGEMENT_RESPONSE_LIMIT, safeErrors = true)
            } catch (failure: Exception) {
                if (write && !isDefiniteManagementRejection(failure)) error("NODE_WRITE_RESULT_UNKNOWN")
                throw failure
            }
            check(envelope.has("result")) {
                if (write) "NODE_WRITE_RESULT_UNKNOWN" else "NODE_RPC_RESULT_UNKNOWN"
            }
            val nodeChanged = runCatching {
                val latest = store.get(id)
                (row.optString("fingerprint").isEmpty() && latest.optString("baseUrl") != url) || latest.optString("configRevision") != revision
            }.getOrDefault(true)
            check(!nodeChanged || write) { "NODE_CHANGED" }
            BoundNodeAgentResult(envelope.get("result"), id, url, revision, nodeChanged)
        } finally { client.revoke() }
    }

    private fun agentRpc(id: String, method: String, args: JSONObject, responseLimit: Long = 263_168L,
        boundTo: BoundNodeAgentResult? = null): BoundNodeAgentResult {
        require(id.isNotBlank()) { "NODE_ID_REQUIRED" }
        check(method in setOf("agentState", "agentDocumentSave", "memorySave", "memoryDecide", "memoryDelete")) {
            "NODE_AGENT_METHOD_DENIED"
        }
        val row = NodeReachability.resolve(store, id)
        check(row.optBoolean("authenticated")) { "NODE_LOGIN_REQUIRED" }
        val url = row.getString("baseUrl")
        val revision = row.getString("configRevision")
        check(boundTo == null || boundTo.nodeId == id && (row.optString("fingerprint").isNotEmpty() || boundTo.baseUrl == url) && boundTo.configRevision == revision) {
            "NODE_CHANGED"
        }
        val savedCookies = row.optJSONArray("cookies") ?: JSONArray()
        val client = NodeClient(url, row.optBoolean("allowPrivateHttp"),
            (0 until savedCookies.length()).map(savedCookies::getString), row.optString("fingerprint").takeIf { it.isNotEmpty() }, row.optString("token").takeIf { it.isNotEmpty() }) { next ->
            store.update(id, url, revision) { it.put("cookies", JSONArray(next)) }
        }
        return try {
            val envelope = try {
                request(client, "/api/shiwen", JSONObject().put("method", method).put("args", args), responseLimit)
            } catch (failure: Exception) {
                if (method != "agentState" && !isDefiniteWriteRejection(failure)) error("NODE_WRITE_RESULT_UNKNOWN")
                throw failure
            }
            check(envelope.has("result")) { if (method == "agentState") "NODE_RPC_RESULT_UNKNOWN" else "NODE_WRITE_RESULT_UNKNOWN" }
            val nodeChanged = runCatching {
                val latest = store.get(id)
                (row.optString("fingerprint").isEmpty() && latest.optString("baseUrl") != url) || latest.optString("configRevision") != revision
            }.getOrDefault(true)
            check(!nodeChanged || method != "agentState") { "NODE_CHANGED" }
            BoundNodeAgentResult(envelope.get("result"), id, url, revision, nodeChanged)
        } finally { client.revoke() }
    }

    private fun isDefiniteWriteRejection(error: Exception): Boolean {
        val rejection = error as? NodeHttpException ?: return false
        return rejection.status in setOf(400, 401, 403, 404, 409, 413, 422, 429)
    }

    private fun isDefiniteManagementRejection(error: Exception): Boolean {
        val rejection = error as? NodeHttpException ?: return false
        if (rejection.status in setOf(401, 403, 404, 409, 413, 422, 429)) return true
        return rejection.message in SAFE_MANAGEMENT_ERROR_CODES &&
            (rejection.status == 400 || rejection.status == 503 && rejection.message == "MANAGEMENT_UNAVAILABLE")
    }

    private fun request(client: NodeClient, path: String, body: JSONObject? = null,
        responseLimit: Long = 263_168L, safeErrors: Boolean = false): JSONObject {
        val data = body?.toString()?.toRequestBody("application/json".toMediaType())
        client.request(path, if (data == null) "GET" else "POST", data).execute().use { response ->
            if (response.code == 401 || response.code == 403) throw NodeHttpException(response.code, "NODE_AUTH_FAILED")
            if (response.code == 429) throw NodeHttpException(429, "NODE_RATE_LIMITED")
            val source = response.body?.source() ?: error("NODE_INVALID_RESPONSE")
            check(!source.request(responseLimit + 1)) { "NODE_RESPONSE_TOO_LARGE" }
            val decoded = runCatching { JSONObject(source.readUtf8()) }.getOrNull()
            if (!response.isSuccessful) {
                if (safeErrors) {
                    val code = decoded?.optString("code")?.takeIf { it in SAFE_MANAGEMENT_ERROR_CODES }
                    val safeMessage = code ?: when (response.code) {
                        401, 403 -> "NODE_AUTH_FAILED"
                        429 -> "NODE_RATE_LIMITED"
                        404 -> "NODE_MANAGEMENT_UNAVAILABLE"
                        else -> "NODE_MANAGEMENT_REJECTED"
                    }
                    throw NodeHttpException(response.code, safeMessage)
                }
                if (decoded?.optString("code") == "PROFILE_TOO_LARGE")
                    throw NodeHttpException(response.code, "PROFILE_TOO_LARGE")
                val remoteError = decoded?.optString("error")?.takeIf { it.isNotBlank() }
                if (path == "/api/shiwen" && response.code == 404) error("PROFILE_UNSUPPORTED")
                if (remoteError == "未知操作" || remoteError == "Unsupported method") error("NODE_AGENT_API_UNSUPPORTED")
                throw NodeHttpException(response.code, remoteError ?: "NODE_REQUEST_FAILED")
            }
            return decoded ?: error("NODE_INVALID_RESPONSE")
        }
    }
    companion object {
        private const val MANAGEMENT_ARGS_LIMIT = 64 * 1024
        private const val MANAGEMENT_RESPONSE_LIMIT = 1_048_576L
        private const val SESSION_ARGS_LIMIT = 64 * 1024
        private const val SESSION_RESPONSE_LIMIT = 1_048_576L
        private const val MOBILE_SYNC_REQUEST_LIMIT = 4 * 1024 * 1024
        private const val MOBILE_SYNC_RESPONSE_LIMIT = 4 * 1024 * 1024L
        private val SESSION_REJECTION_CODES = setOf("INVALID_REQUEST", "SESSION_NOT_FOUND", "SESSION_CONFLICT", "MODEL_NOT_FOUND", "SESSIONS_UNAVAILABLE")
        private val SESSION_ACTIONS = setOf("capabilities", "list", "models", "catalog", "skills", "state", "events", "status",
            "create", "selectModel", "send", "cancel", "respond", "rename", "archive", "unarchive")
        private val SESSION_WRITE_ACTIONS = setOf("create", "selectModel", "send", "cancel", "respond", "rename", "archive", "unarchive")
        private val MOBILE_SYNC_REJECTION_CODES = setOf("INVALID_REQUEST", "VALIDATION_ERROR", "CONFLICT", "REVISION_CONFLICT", "OPERATION_REUSED",
            "EPOCH_MISMATCH", "LIBRARY_MISMATCH", "DEPENDENCY_MISSING", "ATTACHMENT_MISMATCH", "PROTOCOL_UNSUPPORTED",
            "SETUP_TARGET_BUSY", "SETUP_TARGET_CHANGED", "SETUP_TARGET_NOT_EMPTY", "SETUP_LEASE_EXPIRED", "SETUP_NOT_READY",
            "SETUP_ALREADY_COMMITTED", "MANIFEST_MISMATCH", "RECONCILIATION_REQUIRED")
        private val MOBILE_SYNC_ACTIONS = setOf("identity", "bootstrapBegin", "bootstrapPage", "changes", "push", "receipts", "ack",
            "payloadDownload", "operationPayloadBegin", "operationPayloadPart", "operationPayloadStatus", "operationPayloadCommit",
            "blobBegin", "blobPart", "blobStatus", "blobCommit", "blobDownload", "setupBegin", "setupPage", "setupStatus",
            "setupLease", "setupCommit", "setupAbort", "setupPayloadBegin", "setupPayloadPart", "setupPayloadStatus",
            "setupPayloadCommit", "setupBlobBegin", "setupBlobPart", "setupBlobStatus", "setupBlobCommit",
            "reconcileBegin", "reconcilePage", "reconcileStatus", "reconcileLease", "reconcileAbort", "reconcileReceipts",
            "reconcileCandidates", "reconcileBranchRead", "reconcileDecide", "reconcileComplete", "reconcilePayloadBegin",
            "reconcilePayloadPart", "reconcilePayloadStatus", "reconcilePayloadCommit", "reconcileBlobBegin", "reconcileBlobPart",
            "reconcileBlobStatus", "reconcileBlobCommit")
        private val MOBILE_SYNC_WRITE_ACTIONS = setOf("push", "ack", "operationPayloadBegin", "operationPayloadPart",
            "operationPayloadCommit", "blobBegin", "blobPart", "blobCommit", "setupBegin", "setupPage", "setupLease",
            "setupCommit", "setupAbort", "setupPayloadBegin", "setupPayloadPart", "setupPayloadCommit", "setupBlobBegin",
            "setupBlobPart", "setupBlobCommit", "reconcileBegin", "reconcilePage", "reconcileLease", "reconcileAbort",
            "reconcileDecide", "reconcileComplete", "reconcilePayloadBegin", "reconcilePayloadPart", "reconcilePayloadCommit",
            "reconcileBlobBegin", "reconcileBlobPart", "reconcileBlobCommit")
        private val SAFE_MANAGEMENT_ERROR_CODES = setOf(
            "INVALID_REQUEST", "VALIDATION_ERROR", "MANAGEMENT_UNAVAILABLE", "CONFLICT", "REVISION_CONFLICT", "SCHEDULE_CONFLICT", "SCHEDULE_NOT_FOUND",
            "SCHEDULE_EXECUTION_PENDING", "NODE_AGENT_API_UNSUPPORTED", "NODE_MANAGEMENT_ACTION_DENIED", "SESSION_NOT_FOUND",
            "SESSION_CONFLICT", "MODEL_NOT_FOUND", "OPERATION_REUSED", "EPOCH_MISMATCH", "LIBRARY_MISMATCH", "DEPENDENCY_MISSING",
            "ATTACHMENT_MISMATCH", "PROTOCOL_UNSUPPORTED", "SETUP_TARGET_BUSY", "SETUP_TARGET_CHANGED", "SETUP_TARGET_NOT_EMPTY",
            "SETUP_LEASE_EXPIRED", "SETUP_NOT_READY", "SETUP_ALREADY_COMMITTED", "MANIFEST_MISMATCH", "RECONCILIATION_REQUIRED",
            "SESSIONS_UNAVAILABLE"
        )
        private val MANAGEMENT_ACTIONS = setOf(
            "capabilities", "plugins.listBundles", "plugins.listPlugins", "plugins.marketIndexes", "plugins.marketSearch",
            "plugins.install", "plugins.enableBundle", "plugins.enablePlugin", "plugins.removeBundle",
            "plugins.installProgress", "plugins.cancelInstall", "plugins.versions", "plugins.readDetail", "plugins.update",
            "settings.describe", "settings.mutate", "schedules.list", "schedules.catalog",
            "schedules.view", "schedules.history", "schedules.create", "schedules.edit", "schedules.run",
            "schedules.deleteInactive"
        )
        private val MANAGEMENT_WRITE_ACTIONS = setOf(
            "plugins.install", "plugins.enableBundle", "plugins.enablePlugin", "plugins.removeBundle",
            "plugins.cancelInstall", "plugins.update", "settings.mutate", "schedules.create", "schedules.edit", "schedules.run", "schedules.deleteInactive"
        )
        private val EXTERNAL_SCOPES = setOf("create", "read", "update", "delete")
        private val locks = java.util.concurrent.ConcurrentHashMap<String, Any>()
        private val refreshing = java.util.concurrent.ConcurrentHashMap<String, java.util.concurrent.atomic.AtomicInteger>()
        fun isRefreshing(id: String) = (refreshing[id]?.get() ?: 0) > 0
        fun reserveRefresh(id: String): AutoCloseable {
            val count = refreshing.getOrPut(id) { java.util.concurrent.atomic.AtomicInteger() }
            count.incrementAndGet()
            return AutoCloseable { count.decrementAndGet() }
        }
        fun validateProfile(profile: JSONObject) {
            check(profile.optInt("version") == 1) { "PROFILE_UNSUPPORTED" }
            check(profile.optString("agentId") == "shiwen") { "PROFILE_UNSUPPORTED" }
            check(profile.optString("revision").matches(Regex("[a-f0-9]{64}"))) { "PROFILE_INVALID" }
            check(profile.has("systemContext") && profile.getString("systemContext").length in 1..32000) { "PROFILE_INVALID" }
            val fields = profile.keys().asSequence().filter { it != "revision" }.associateWith { plain(profile.get(it)) }
            check(Canonical.hash(fields) == profile.getString("revision")) { "PROFILE_HASH_MISMATCH" }
        }
        private fun plain(value: Any?, depth: Int = 0): Any? {
          check(depth <= 32) { "PROFILE_INVALID" }
          return when (value) {
            JSONObject.NULL -> null
            is JSONObject -> value.keys().asSequence().associateWith { plain(value.get(it), depth + 1) }
            is JSONArray -> (0 until value.length()).map { plain(value.get(it), depth + 1) }
            else -> value
          }
        }
    }
}
