package io.github.wyf929597870.shiwen.agent

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.util.concurrent.TimeUnit

internal data class ListedModel(val id: String, val name: String?) {
    val label get() = if (name != null && name != id) "$name\n$id" else id
}

internal class ModelDirectory(builder: OkHttpClient.Builder = OkHttpClient.Builder()) {
    private val client = builder.followRedirects(false).followSslRedirects(false)
        .callTimeout(20, TimeUnit.SECONDS).build()

    fun request(baseUrl: String, key: String): Call {
        val url = ModelConfigStore.normalizeUrl(baseUrl) + "models"
        return client.newCall(Request.Builder().url(url).header("Authorization", "Bearer $key")
            .header("Accept", "application/json").build())
    }

    fun read(response: Response): List<ListedModel> = response.use {
        check(it.isSuccessful) { "HTTP_${it.code}" }
        val source = it.body.source()
        check(!source.request(2L * 1024 * 1024 + 1)) { "INVALID_LIST" }
        val root = Json.parseToJsonElement(source.readUtf8()) as? JsonObject
        val data = root?.get("data") as? JsonArray ?: error("INVALID_LIST")
        data.mapNotNull { element ->
            val row = element as? JsonObject ?: return@mapNotNull null
            fun field(key: String) = (row[key] as? JsonPrimitive)?.takeIf { v -> v.isString }
                ?.content?.trim()?.takeIf { v -> v.length in 1..200 && v.none(Char::isISOControl) }
            val id = field("id") ?: return@mapNotNull null
            ListedModel(id, field("name") ?: field("display_name"))
        }.distinctBy { row -> row.id }.also { rows -> check(rows.isNotEmpty()) { "EMPTY_LIST" } }
    }
}
