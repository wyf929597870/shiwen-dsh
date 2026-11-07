package io.github.wyf929597870.shiwen.library

import android.util.Base64
import org.json.JSONObject

/** Validates one range response before it is appended to an attachment temp file. */
internal object AttachmentChunkProtocol {
    fun decode(
        response: JSONObject,
        attachmentId: String,
        recordId: String,
        name: String,
        digest: String,
        totalBytes: Long,
        branchId: String? = null,
        offset: Long,
        requestedBytes: Long,
    ): ByteArray {
        require(totalBytes >= 0L && offset in 0..totalBytes && requestedBytes > 0L) { "ATTACHMENT_RANGE_INVALID" }
        check(response.optString("attachmentId") == attachmentId &&
            response.optString("recordId") == recordId &&
            response.optString("name") == name &&
            response.optString("digest").equals(digest, ignoreCase = true) &&
            response.has("totalBytes") && response.optLong("totalBytes", -1L) == totalBytes &&
            response.has("offset") && response.optLong("offset", -1L) == offset
        ) { "ATTACHMENT_RESPONSE_IDENTITY_MISMATCH" }
        if (branchId != null) {
            check(response.optString("branchId") == branchId) { "ATTACHMENT_RESPONSE_BRANCH_MISMATCH" }
        } else {
            check(!response.has("branchId") || response.isNull("branchId")) { "ATTACHMENT_RESPONSE_BRANCH_MISMATCH" }
        }

        val bytes = try {
            Base64.decode(response.getString("dataBase64"), Base64.DEFAULT)
        } catch (_: Exception) {
            error("ATTACHMENT_CHUNK_ENCODING_INVALID")
        }
        val expectedSize = minOf(requestedBytes, totalBytes - offset)
        check(bytes.size.toLong() == expectedSize) { "ATTACHMENT_CHUNK_SIZE_INVALID" }

        val complete = response.optBoolean("complete", false)
        val next = response.opt("nextOffset")
        val expectedEnd = offset + bytes.size
        if (complete) {
            check(expectedEnd == totalBytes) { "ATTACHMENT_CHUNK_COMPLETION_INVALID" }
            // The wire contract uses null for the final offset. Numeric totalBytes
            // remains accepted for compatible hosts, but no other value is valid.
            check(next == JSONObject.NULL || (next is Number && next.toLong() == totalBytes)) {
                "ATTACHMENT_CHUNK_OFFSET_INVALID"
            }
        } else {
            check(bytes.isNotEmpty() && expectedEnd < totalBytes && next is Number && next.toLong() == expectedEnd) {
                "ATTACHMENT_CHUNK_OFFSET_INVALID"
            }
        }
        return bytes
    }
}
