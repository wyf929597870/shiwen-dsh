package io.github.wyf929597870.shiwen.library

import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AttachmentChunkProtocolTest {
    private val id = "attachment-1"
    private val recordId = "record-1"
    private val name = "synthetic.bin"
    private val digest = "a".repeat(64)

    @Test fun acceptsSingleFinalChunkWithNullNextOffset() {
        val bytes = byteArrayOf(1, 2, 3)
        assertArrayEquals(bytes, AttachmentChunkProtocol.decode(response(bytes, 0, 3, true, JSONObject.NULL),
            id, recordId, name, digest, 3, offset = 0, requestedBytes = 1024))
    }

    @Test fun acceptsSequentialMultiChunkIncludingNullFinalOffset() {
        val first = byteArrayOf(1, 2)
        val second = byteArrayOf(3)
        val a = AttachmentChunkProtocol.decode(response(first, 0, 3, false, 2), id, recordId, name,
            digest, 3, offset = 0, requestedBytes = 2)
        val b = AttachmentChunkProtocol.decode(response(second, 2, 3, true, JSONObject.NULL), id, recordId,
            name, digest, 3, offset = 2, requestedBytes = 2)
        assertArrayEquals(byteArrayOf(1, 2, 3), a + b)
    }

    @Test fun acceptsEmptyAttachmentAsOneCompleteEmptyChunk() {
        assertArrayEquals(byteArrayOf(), AttachmentChunkProtocol.decode(response(byteArrayOf(), 0, 0,
            true, JSONObject.NULL), id, recordId, name, digest, 0, offset = 0, requestedBytes = 1024))
    }

    @Test fun rejectsNullOffsetForIncompleteChunkAndWrongIdentity() {
        assertThrows(IllegalStateException::class.java) {
            AttachmentChunkProtocol.decode(response(byteArrayOf(1), 0, 2, false, JSONObject.NULL), id,
                recordId, name, digest, 2, offset = 0, requestedBytes = 2)
        }
        assertThrows(IllegalStateException::class.java) {
            AttachmentChunkProtocol.decode(response(byteArrayOf(1), 0, 1, true, JSONObject.NULL)
                .put("recordId", "other-record"), id, recordId, name, digest, 1,
                offset = 0, requestedBytes = 1)
        }
    }

    @Test fun validatesBranchIdentitySeparatelyFromRecordAttachments() {
        val branchId = "branch-1"
        val response = response(byteArrayOf(1), 0, 1, true, JSONObject.NULL).put("branchId", branchId)
        assertArrayEquals(byteArrayOf(1), AttachmentChunkProtocol.decode(response, id, recordId, name,
            digest, 1, branchId, offset = 0, requestedBytes = 1))
        assertThrows(IllegalStateException::class.java) {
            AttachmentChunkProtocol.decode(response, id, recordId, name, digest, 1, "other-branch",
                offset = 0, requestedBytes = 1)
        }
    }

    private fun response(bytes: ByteArray, offset: Long, total: Long, complete: Boolean, next: Any?): JSONObject =
        JSONObject().put("attachmentId", id).put("recordId", recordId).put("name", name)
            .put("digest", digest).put("totalBytes", total).put("offset", offset)
            .put("nextOffset", next).put("complete", complete)
            .put("dataBase64", Base64.encodeToString(bytes, Base64.NO_WRAP))
}
