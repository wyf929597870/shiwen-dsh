package io.github.wyf929597870.shiwen.library

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.security.SecureRandom
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/** Portable, optional archive encryption. The passphrase is never persisted. */
internal object LibraryArchiveCrypto {
    private val MAGIC = "SHWBKUP1".toByteArray(Charsets.US_ASCII)
    private const val VERSION = 1
    private const val MIN_ITERATIONS = 210_000
    private const val ITERATIONS = 310_000
    private const val MAX_ITERATIONS = 600_000
    private const val SALT_BYTES = 16
    private const val NONCE_BYTES = 12
    private const val TAG_BITS = 128
    private const val HEADER_SIZE = 8 + 1 + 4 + SALT_BYTES + NONCE_BYTES

    fun isEncrypted(bytes: ByteArray): Boolean = bytes.size >= MAGIC.size && bytes.copyOfRange(0, MAGIC.size).contentEquals(MAGIC)

    fun encrypt(plain: ByteArray, password: CharArray): ByteArray {
        try {
            validatePassword(password)
            require(plain.size.toLong() <= LibraryFileTransfer.MAX_BACKUP_BYTES) { "ARCHIVE_TOO_LARGE" }
            val salt = ByteArray(SALT_BYTES).also(SecureRandom()::nextBytes)
            val nonce = ByteArray(NONCE_BYTES).also(SecureRandom()::nextBytes)
            val key = derive(password, salt, ITERATIONS)
            try {
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, nonce))
                cipher.updateAAD(aad(ITERATIONS))
                val encrypted = cipher.doFinal(plain)
                val out = ByteArrayOutputStream(HEADER_SIZE + encrypted.size)
                out.write(MAGIC)
                out.write(VERSION)
                out.write(ByteBuffer.allocate(4).putInt(ITERATIONS).array())
                out.write(salt); out.write(nonce); out.write(encrypted)
                return out.toByteArray()
            } finally { key.fill(0) }
        } finally { password.fill('\u0000') }
    }

    fun decrypt(envelope: ByteArray, password: CharArray): ByteArray {
        try {
            validatePassword(password)
            require(envelope.size >= HEADER_SIZE + 16 && envelope.size.toLong() <= LibraryFileTransfer.MAX_BACKUP_BYTES + HEADER_SIZE + 16) {
                "BACKUP_ENVELOPE_INVALID"
            }
            val input = ByteBuffer.wrap(envelope)
            val magic = ByteArray(MAGIC.size); input.get(magic)
            check(magic.contentEquals(MAGIC)) { "BACKUP_ENVELOPE_INVALID" }
            val version = input.get().toInt() and 0xff
            check(version == VERSION) { "BACKUP_ENCRYPTION_VERSION_UNSUPPORTED" }
            val iterations = input.int
            // Bound both CPU cost and downgrade resistance before doing expensive KDF work.
            check(iterations in MIN_ITERATIONS..MAX_ITERATIONS) { "BACKUP_KDF_PARAMETERS_INVALID" }
            val salt = ByteArray(SALT_BYTES); input.get(salt)
            val nonce = ByteArray(NONCE_BYTES); input.get(nonce)
            val ciphertext = ByteArray(input.remaining()); input.get(ciphertext)
            val key = derive(password, salt, iterations)
            try {
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, nonce))
                cipher.updateAAD(aad(iterations))
                return try { cipher.doFinal(ciphertext) } catch (_: AEADBadTagException) { error("BACKUP_PASSWORD_INVALID") }
            } finally { key.fill(0) }
        } finally { password.fill('\u0000') }
    }

    private fun derive(password: CharArray, salt: ByteArray, iterations: Int): ByteArray {
        val spec = PBEKeySpec(password, salt, iterations, 256)
        return try { SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded }
        finally { spec.clearPassword() }
    }

    private fun aad(iterations: Int): ByteArray = MAGIC + byteArrayOf(VERSION.toByte()) + ByteBuffer.allocate(4).putInt(iterations).array()

    private fun validatePassword(password: CharArray) {
        require(password.size in 8..256) { "BACKUP_PASSWORD_LENGTH_INVALID" }
    }
}
