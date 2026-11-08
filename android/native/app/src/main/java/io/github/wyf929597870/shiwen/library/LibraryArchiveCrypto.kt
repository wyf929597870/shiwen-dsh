package io.github.wyf929597870.shiwen.library

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.security.SecureRandom
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/** Streaming authenticated archive encryption. V1 single-tag envelopes remain readable. */
internal object LibraryArchiveCrypto {
    private val MAGIC = "SHWBKUP1".toByteArray(Charsets.US_ASCII)
    private const val LEGACY_VERSION = 1
    private const val VERSION = 2
    private const val MIN_ITERATIONS = 210_000
    private const val ITERATIONS = 310_000
    private const val MAX_ITERATIONS = 600_000
    private const val SALT_BYTES = 16
    private const val NONCE_BYTES = 12
    private const val TAG_BITS = 128
    private const val TAG_BYTES = 16
    private const val HEADER_SIZE = 8 + 1 + 4 + SALT_BYTES + NONCE_BYTES
    private const val CHUNK_BYTES = 64 * 1024
    private const val LEGACY_MAX_PLAIN_BYTES = 64L * 1024 * 1024

    fun isEncrypted(bytes: ByteArray): Boolean = bytes.size >= MAGIC.size && bytes.copyOfRange(0, MAGIC.size).contentEquals(MAGIC)
    fun isEncrypted(file: File): Boolean = file.isFile && FileInputStream(file).use { input ->
        val prefix = ByteArray(MAGIC.size)
        var offset = 0
        while (offset < prefix.size) {
            val count = input.read(prefix, offset, prefix.size - offset)
            if (count < 0) return@use false
            offset += count
        }
        prefix.contentEquals(MAGIC)
    }

    /** Small-payload compatibility helpers used by focused crypto tests and legacy callers only. */
    fun encrypt(plain: ByteArray, password: CharArray): ByteArray = withTempFiles { source, target ->
        source.writeBytes(plain)
        encryptFile(source, target, password, maxOf(1L, plain.size.toLong()))
        target.readBytes()
    }

    fun decrypt(envelope: ByteArray, password: CharArray): ByteArray = withTempFiles { source, target ->
        source.writeBytes(envelope)
        decryptFile(source, target, password, 1024L * 1024 * 1024)
        target.readBytes()
    }

    private inline fun <T> withTempFiles(block: (File, File) -> T): T {
        val source = File.createTempFile("shiwen-crypto-test-", ".input")
        val target = File.createTempFile("shiwen-crypto-test-", ".output")
        try { return block(source, target) }
        finally { source.delete(); target.delete() }
    }

    fun encryptFile(plain: File, encrypted: File, password: CharArray, maxPlainBytes: Long) {
        try {
            validatePassword(password)
            require(plain.isFile && plain.length() in 1..maxPlainBytes) { "ARCHIVE_SIZE_INVALID" }
            val salt = ByteArray(SALT_BYTES).also(SecureRandom()::nextBytes)
            val nonce = ByteArray(NONCE_BYTES).also(SecureRandom()::nextBytes)
            val header = header(VERSION, ITERATIONS, salt, nonce)
            val key = derive(password, salt, ITERATIONS)
            var chunkCount = 0L
            try {
                DataOutputStream(BufferedOutputStream(FileOutputStream(encrypted))).use { output ->
                    output.write(header)
                    var index = 0L
                    var total = 0L
                    FileInputStream(plain).buffered().use { input ->
                        val buffer = ByteArray(CHUNK_BYTES)
                        while (true) {
                            var count = 0
                            while (count < buffer.size) {
                                val read = input.read(buffer, count, buffer.size - count)
                                if (read < 0) break
                                count += read
                            }
                            if (count == 0) break
                            total += count
                            require(total <= maxPlainBytes) { "ARCHIVE_TOO_LARGE" }
                            output.writeInt(count)
                            output.write(encryptChunk(key, nonce, header, index, count, false, buffer, count))
                            index++
                        }
                        chunkCount = index
                    }
                    check(total == plain.length()) { "ARCHIVE_FILE_CHANGED" }
                    output.writeInt(0)
                    output.write(encryptChunk(key, nonce, header, index, 0, true, ByteArray(0), 0))
                }
            } finally { key.fill(0) }
            val maxEnvelope = plain.length() + HEADER_SIZE + (chunkCount + 1) * (4 + TAG_BYTES)
            check(encrypted.length() <= maxEnvelope) { "ARCHIVE_TOO_LARGE" }
        } catch (error: Exception) {
            encrypted.delete()
            throw error
        } finally { password.fill('\u0000') }
    }

    fun decryptFile(envelope: File, plain: File, password: CharArray, maxPlainBytes: Long) {
        try {
            validatePassword(password)
            require(envelope.isFile && envelope.length() >= HEADER_SIZE + 4 + TAG_BYTES) { "BACKUP_ENVELOPE_INVALID" }
            DataInputStream(BufferedInputStream(FileInputStream(envelope))).use { input ->
                val prefix = ByteArray(HEADER_SIZE)
                input.readFully(prefix)
                val parsed = parseHeader(prefix)
                check(parsed.version == VERSION || parsed.version == LEGACY_VERSION) { "BACKUP_ENCRYPTION_VERSION_UNSUPPORTED" }
                if (parsed.version == LEGACY_VERSION) {
                    require(envelope.length() <= LEGACY_MAX_PLAIN_BYTES + HEADER_SIZE + TAG_BYTES) { "ARCHIVE_SIZE_INVALID" }
                } else {
                    val maxChunks = (maxPlainBytes + CHUNK_BYTES - 1) / CHUNK_BYTES
                    val maximumEnvelope = maxPlainBytes + HEADER_SIZE + (maxChunks + 1) * (4 + TAG_BYTES)
                    require(envelope.length() <= maximumEnvelope) { "ARCHIVE_SIZE_INVALID" }
                }
                check(parsed.iterations in MIN_ITERATIONS..MAX_ITERATIONS) { "BACKUP_KDF_PARAMETERS_INVALID" }
                val key = derive(password, parsed.salt, parsed.iterations)
                try {
                    when (parsed.version) {
                        VERSION -> decryptChunks(input, plain, key, parsed, maxPlainBytes)
                        LEGACY_VERSION -> decryptLegacy(input, plain, key, parsed, maxPlainBytes)
                        else -> error("BACKUP_ENCRYPTION_VERSION_UNSUPPORTED")
                    }
                } finally { key.fill(0) }
            }
        } catch (error: Exception) {
            plain.delete()
            if (error is AEADBadTagException) error("BACKUP_PASSWORD_INVALID")
            throw error
        } finally { password.fill('\u0000') }
    }

    private fun decryptChunks(input: DataInputStream, plain: File, key: ByteArray, header: ParsedHeader, maxPlainBytes: Long) {
        var index = 0L
        var total = 0L
        var shortChunkSeen = false
        var terminated = false
        FileOutputStream(plain).buffered().use { output ->
            while (!terminated) {
                val length = try { input.readInt() } catch (_: Exception) { error("BACKUP_ENVELOPE_TRUNCATED") }
                if (length == 0) {
                    val tag = ByteArray(TAG_BYTES)
                    try { input.readFully(tag) } catch (_: Exception) { error("BACKUP_ENVELOPE_TRUNCATED") }
                    try { decryptChunk(key, header.nonce, header.bytes, index, 0, true, tag) }
                    catch (_: AEADBadTagException) { error("BACKUP_PASSWORD_INVALID") }
                    check(input.read() == -1) { "BACKUP_ENVELOPE_TRAILING_DATA" }
                    terminated = true
                } else {
                    require(length in 1..CHUNK_BYTES) { "BACKUP_ENVELOPE_INVALID" }
                    require(!shortChunkSeen) { "BACKUP_ENVELOPE_INVALID" }
                    total += length
                    require(total <= maxPlainBytes) { "ARCHIVE_TOO_LARGE" }
                    if (length < CHUNK_BYTES) shortChunkSeen = true
                    val ciphertext = ByteArray(length + TAG_BYTES)
                    try { input.readFully(ciphertext) } catch (_: Exception) { error("BACKUP_ENVELOPE_TRUNCATED") }
                    val decoded = try { decryptChunk(key, header.nonce, header.bytes, index, length, false, ciphertext) }
                        catch (_: AEADBadTagException) { error("BACKUP_PASSWORD_INVALID") }
                    check(decoded.size == length) { "BACKUP_ENVELOPE_INVALID" }
                    output.write(decoded)
                    index++
                }
            }
        }
        require(total > 0) { "BACKUP_ENVELOPE_INVALID" }
    }

    /** Legacy v1 decrypts to private staging; doFinal authenticates before the file is consumed. */
    private fun decryptLegacy(input: DataInputStream, plain: File, key: ByteArray, header: ParsedHeader, maxPlainBytes: Long) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, header.nonce))
        cipher.updateAAD(aad(LEGACY_VERSION, header.iterations))
        FileOutputStream(plain).buffered().use { output ->
            val buffer = ByteArray(CHUNK_BYTES)
            var total = 0L
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                val decoded = cipher.update(buffer, 0, count) ?: ByteArray(0)
                total += decoded.size
                require(total <= maxPlainBytes) { "ARCHIVE_TOO_LARGE" }
                output.write(decoded)
            }
            val tail = try { cipher.doFinal() } catch (_: AEADBadTagException) { error("BACKUP_PASSWORD_INVALID") }
            total += tail.size
            require(total in 1..maxPlainBytes) { "ARCHIVE_SIZE_INVALID" }
            output.write(tail)
        }
    }

    private fun encryptChunk(key: ByteArray, baseNonce: ByteArray, header: ByteArray, index: Long,
        length: Int, terminal: Boolean, input: ByteArray, count: Int): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, nonceFor(baseNonce, index)))
        cipher.updateAAD(header)
        cipher.updateAAD(chunkAad(index, length, terminal))
        return cipher.doFinal(input, 0, count)
    }

    private fun decryptChunk(key: ByteArray, baseNonce: ByteArray, header: ByteArray, index: Long,
        length: Int, terminal: Boolean, ciphertext: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, nonceFor(baseNonce, index)))
        cipher.updateAAD(header)
        cipher.updateAAD(chunkAad(index, length, terminal))
        return cipher.doFinal(ciphertext)
    }

    private fun nonceFor(base: ByteArray, index: Long) = base.copyOfRange(0, 4) + ByteBuffer.allocate(8).putLong(index).array()
    private fun chunkAad(index: Long, length: Int, terminal: Boolean) = ByteBuffer.allocate(13)
        .putLong(index).putInt(length).put(if (terminal) 1 else 0).array()

    private data class ParsedHeader(val version: Int, val iterations: Int, val salt: ByteArray, val nonce: ByteArray, val bytes: ByteArray)
    private fun header(version: Int, iterations: Int, salt: ByteArray, nonce: ByteArray): ByteArray =
        MAGIC + byteArrayOf(version.toByte()) + ByteBuffer.allocate(4).putInt(iterations).array() + salt + nonce
    private fun parseHeader(bytes: ByteArray): ParsedHeader {
        check(bytes.size == HEADER_SIZE && bytes.copyOfRange(0, MAGIC.size).contentEquals(MAGIC)) { "BACKUP_ENVELOPE_INVALID" }
        val input = ByteBuffer.wrap(bytes)
        input.position(MAGIC.size)
        val version = input.get().toInt() and 0xff
        val iterations = input.int
        val salt = ByteArray(SALT_BYTES).also(input::get)
        val nonce = ByteArray(NONCE_BYTES).also(input::get)
        return ParsedHeader(version, iterations, salt, nonce, bytes)
    }

    private fun derive(password: CharArray, salt: ByteArray, iterations: Int): ByteArray {
        val spec = PBEKeySpec(password, salt, iterations, 256)
        return try { SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded }
        finally { spec.clearPassword() }
    }
    private fun aad(version: Int, iterations: Int): ByteArray =
        MAGIC + byteArrayOf(version.toByte()) + ByteBuffer.allocate(4).putInt(iterations).array()
    private fun validatePassword(password: CharArray) { require(password.size in 8..256) { "BACKUP_PASSWORD_LENGTH_INVALID" } }
}
