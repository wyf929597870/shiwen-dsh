package io.github.wyf929597870.shiwen.library

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Copy a record and its referenced images without retaining source-library attachment IDs. */
internal object LibraryImageCopy {
    private val reference = Regex("!?\\[[^\\r\\n]*?]\\((attachment:([a-f0-9-]{36}))\\)", RegexOption.IGNORE_CASE)
    private data class Replacement(val start: Int, val end: Int, val id: String, val label: String? = null)

    fun copy(source: LibraryRepository, target: LibraryRepository, recordId: String, requestId: String): LibraryRecord {
        check(source.libraryId != target.libraryId) { "COPY_TARGET_MUST_DIFFER" }
        UUID.fromString(requestId)
        val row = source.read(recordId)
        require(row.kind != "ai_annotation") { "ANNOTATION_COPY_UNSUPPORTED" }
        check(!row.deleted) { "RECORD_NOT_FOUND" }
        val masked = maskCode(row.markdown)
        val matches = reference.findAll(masked).map { match ->
            val value = checkNotNull(match.groups[1]); Replacement(value.range.first, value.range.last + 1, match.groupValues[2])
        }.toMutableList()
        val mappedIds = mutableSetOf<String>()
        val imported = source.dao.provenance(recordId)?.json?.let(::JSONObject)?.optJSONObject("import")
        val links = imported?.optJSONArray("links") ?: JSONArray()
        val base = imported?.optString("sourceName", "")?.substringBeforeLast('/', "") ?: ""
        fun resolveLegacy(value: String): String {
            val raw = android.net.Uri.decode(value).substringBefore('#').replace('\\', '/')
            require(!raw.startsWith('/') && !Regex("^[a-zA-Z][a-zA-Z0-9+.-]*:").containsMatchIn(raw)) { "COPY_IMAGE_MAPPING_INVALID" }
            val normalized = java.nio.file.Paths.get(base, raw).normalize().toString().replace('\\', '/')
            require(!normalized.startsWith("../") && normalized != ".." && !normalized.startsWith('/')) { "COPY_IMAGE_MAPPING_INVALID" }
            val candidates = (0 until links.length()).map { links.getJSONObject(it) }.filter {
                it.optString("relativePath") == normalized || it.optString("relativePath") == raw
            }.mapNotNull { it.optString("targetAttachmentId").takeIf { id -> id.isNotBlank() && id != "null" } }.distinct()
            return candidates.singleOrNull() ?: error("COPY_IMAGE_MAPPING_MISSING")
        }
        val legacyImage = Regex("!\\[([^\\r\\n]*?)]\\(([^)]+)\\)|!\\[\\[([^\\r\\n]*?)]]", RegexOption.IGNORE_CASE)
        for (match in legacyImage.findAll(masked)) {
            val wiki = match.groupValues[3].isNotEmpty()
            val pieces = if (wiki) match.groupValues[3].split('|', limit = 2) else emptyList()
            val raw = if (wiki) pieces[0] else match.groupValues[2].substringBefore(" \"")
            if (raw.startsWith("attachment:", true)) {
                if (wiki) {
                    val id = raw.substringAfter(':'); UUID.fromString(id)
                    val group = checkNotNull(match.groups[3]); matches += Replacement(group.range.first, group.range.first + raw.length, id)
                }
                continue
            }
            if (raw.startsWith("http://", true) || raw.startsWith("https://", true)) continue
            val id = resolveLegacy(raw); mappedIds += id
            val label = (if (wiki) pieces.getOrElse(1) { pieces[0] } else match.groupValues[1]).replace("]", "_")
            matches += Replacement(match.range.first, match.range.last + 1, id, label)
        }
        matches.sortBy { it.start }
        val ids = matches.map { it.id }.distinct()
        require(ids.size <= 10) { "TOO_MANY_IMAGES_SELECTED" }
        val owned = source.dao.attachments(recordId).associateBy { it.id }
        val all = source.dao.allAttachments().associateBy { it.id }
        val replacement = linkedMapOf<String, StagedLibraryAttachment>()
        var total = 0L
        for (id in ids) {
            val attachment = checkNotNull(owned[id] ?: if(id in mappedIds) all[id] else null) { "COPY_IMAGE_MISSING" }
            require(attachment.byteLength in 1..LibraryAttachmentDraftStore.MAX_IMAGE_BYTES.toLong()) { "COPY_IMAGE_TOO_LARGE" }
            val bytes = source.attachmentBytes(id)
            val mime = LibraryAttachmentDraftStore.imageMime(bytes) ?: error("COPY_IMAGE_FORMAT_UNSUPPORTED")
            total += bytes.size; require(total <= 32L * 1024 * 1024) { "COPY_IMAGES_TOO_LARGE" }
            val newId = UUID.nameUUIDFromBytes("copy:${source.libraryId}:${target.libraryId}:$requestId:$id".toByteArray()).toString()
            replacement[id] = StagedLibraryAttachment(newId, attachment.name, LibraryAttachmentDraftStore.sha256(bytes), bytes.size.toLong(), bytes, mime)
        }
        val sourceSegments = JSONArray(row.sourcesJson)
        val original = (0 until sourceSegments.length()).joinToString("") { sourceSegments.getJSONObject(it).optString("text") }
        check(original == row.markdown) { "SOURCE_SEGMENTS_MISMATCH" }
        val copied = JSONArray()
        fun appendSlice(from: Int, to: Int) {
            var offset = 0
            for (index in 0 until sourceSegments.length()) {
                val segment = sourceSegments.getJSONObject(index); val text = segment.optString("text")
                val lo = maxOf(0, from - offset); val hi = minOf(text.length, to - offset)
                if (hi > lo) {
                    val result = JSONObject(segment.toString()).put("text", text.substring(lo, hi))
                    val sourceRef = segment.optString("sourceRef")
                    if (sourceRef.startsWith("attachment:", ignoreCase = true)) {
                        val originalId = sourceRef.substringAfter(':'); val mapped = replacement[originalId]
                        if (mapped != null) result.put("sourceRef", "attachment:${mapped.id}") else result.remove("sourceRef")
                    } else if (sourceRef.isNotBlank()) result.put("sourceRef", "源资料库 ${source.libraryId} · $sourceRef")
                    copied.put(result)
                }
                offset += text.length
            }
        }
        var cursor = 0
        for (match in matches) {
            appendSlice(cursor, match.start)
            var offset = 0; var origin = "unknown"
            for (index in 0 until sourceSegments.length()) {
                val segment = sourceSegments.getJSONObject(index); val end = offset + segment.optString("text").length
                if (match.start < end) { origin = segment.optString("origin", "unknown"); break }; offset = end
            }
            val newReference = "attachment:${replacement.getValue(match.id).id}"
            val text = if (match.label != null) "![${match.label}]($newReference)" else newReference
            copied.put(JSONObject().put("text", text).put("origin", origin))
            cursor = match.end
        }
        appendSlice(cursor, row.markdown.length)
        val markdown = (0 until copied.length()).joinToString("") { copied.getJSONObject(it).getString("text") }
        val descriptors = JSONArray(replacement.values.map { item -> JSONObject().put("id", item.id).put("name", item.name)
            .put("hash", item.hash).put("byteLength", item.byteLength) })
        val input = JSONObject().put("kind", row.kind).put("title", row.title).put("markdown", markdown)
            .put("origin", row.origin).put("processing", row.processing).put("contentDay", row.contentDay ?: JSONObject.NULL)
            .put("dateBasis", row.dateBasis).put("url", row.url ?: "").put("annotation", row.annotation ?: "")
            .put("stage", row.stage ?: "draft").put("sources", copied).put("sourceIds", JSONArray())
            .put("attachmentDescriptors", descriptors)
        return target.create(requestId, input, 1, activityAction = "copy", stagedAttachments = replacement.values.toList())
    }

    internal fun maskCode(markdown: String): String {
        val output = markdown.toCharArray(); var offset = 0; var fence: String? = null
        val marker = Regex("^\\s{0,3}(`{3,}|~{3,})")
        val inline = Regex("(`+)([^`]*?)\\1")
        for (line in markdown.split('\n')) {
            val opening = marker.find(line)?.groupValues?.get(1)
            if (opening != null) {
                val active = fence
                if (active == null) fence = opening else if (opening[0] == active[0] && opening.length >= active.length && line.trim() == opening) fence = null
                for (index in line.indices) output[offset + index] = ' '
            } else if (fence != null) {
                for (index in line.indices) output[offset + index] = ' '
            } else {
                inline.findAll(line).forEach { match -> for (index in match.range) output[offset + index] = ' ' }
            }
            offset += line.length + 1
        }
        return String(output)
    }
}
