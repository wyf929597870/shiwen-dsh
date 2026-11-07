package io.github.wyf929597870.shiwen.network

import org.json.JSONArray
import org.json.JSONObject

/** Explicit remote management actions. No arbitrary RPC method or URL is exposed. */
internal class NodeManagementActions(private val connection: NodeConnection) {
    fun manage(id: String, action: String, args: JSONObject, expectedConfigRevision: String? = null): JSONObject =
        connection.mobileManagement(id, action, args, expectedConfigRevision)

    fun externalStatus(id: String): JSONObject {
        val raw = connection.externalStatus(id)
        val clients = JSONArray()
        val rows = raw.optJSONArray("clients") ?: JSONArray()
        for (index in 0 until rows.length()) {
            val row = rows.optJSONObject(index) ?: continue
            val clientId = row.optString("id")
            val name = row.optString("name")
            if (clientId.isBlank() || name.isBlank()) continue
            val scopes = row.optJSONArray("scopes") ?: JSONArray()
            clients.put(JSONObject().put("id", clientId).put("name", name)
                .put("scopes", JSONArray((0 until scopes.length()).mapNotNull {
                    scopes.optString(it).takeIf { scope -> scope in setOf("create", "read", "update", "delete") }
                }))
                .put("created", row.opt("created") ?: JSONObject.NULL)
                .put("revoked", row.opt("revoked") ?: JSONObject.NULL)
                .put("last_used", row.opt("last_used") ?: JSONObject.NULL))
        }
        return JSONObject().put("running", raw.optBoolean("running"))
            .put("endpoint", raw.opt("endpoint")?.takeIf { it is String } ?: JSONObject.NULL)
            .put("clients", clients).put("nodeChanged", raw.optBoolean("nodeChanged"))
    }

    /** The returned token is for the native dialog only; LibraryProbePlugin must never resolve it to JS. */
    fun createExternalClientForNativeDialog(id: String, name: String, scopes: List<String>): JSONObject =
        connection.externalClientCreate(id, name, scopes)

    fun revokeExternalClient(id: String, clientId: String): JSONObject =
        connection.externalClientRevoke(id, clientId)

    fun externalClientMetadata(issued: JSONObject): JSONObject = JSONObject()
        .put("id", issued.getString("id"))
        .put("name", issued.getString("name"))
        .put("scopes", JSONArray(issued.getJSONArray("scopes").toString()))
        .put("created", issued.get("created"))
        .put("nodeChanged", issued.optBoolean("nodeChanged"))
}
