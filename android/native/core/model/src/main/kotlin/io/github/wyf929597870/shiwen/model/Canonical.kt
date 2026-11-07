package io.github.wyf929597870.shiwen.model

import java.security.MessageDigest

/** shiwen-json-v1; pure Kotlin/JVM, independent of Android and UI lifecycle. */
object Canonical {
    fun encode(value: Any?, depth: Int = 0): String {
        require(depth <= 64) { "VALIDATION_ERROR: depth" }
        return when (value) {
            null -> "null"
            is Boolean -> value.toString()
            is String -> quote(value)
            is Byte, is Short, is Int, is Long -> {
                val n = (value as Number).toLong()
                require(n in -9007199254740991L..9007199254740991L) { "VALIDATION_ERROR: integer" }
                n.toString()
            }
            is List<*> -> value.joinToString(",", "[", "]") { encode(it, depth + 1) }
            is Map<*, *> -> {
                require(value.keys.all { it is String }) { "VALIDATION_ERROR: keys" }
                value.keys.map { it as String }.sorted().joinToString(",", "{", "}") {
                    quote(it) + ":" + encode(value[it], depth + 1)
                }
            }
            else -> error("VALIDATION_ERROR: type")
        }
    }
    private fun quote(text: String): String = buildString {
        append('"')
        var i = 0
        while (i < text.length) {
            val c = text[i++]
            when (c) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\b' -> append("\\b")
                '\u000c' -> append("\\f")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> when {
                    c.code < 32 -> append("\\u" + c.code.toString(16).padStart(4, '0'))
                    Character.isHighSurrogate(c) -> {
                        require(i < text.length && Character.isLowSurrogate(text[i])) { "VALIDATION_ERROR: unicode" }
                        append(c); append(text[i++])
                    }
                    Character.isLowSurrogate(c) -> error("VALIDATION_ERROR: unicode")
                    else -> append(c)
                }
            }
        }
        append('"')
    }
    fun hash(value: Any?): String = MessageDigest.getInstance("SHA-256")
        .digest(encode(value).toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it.toInt() and 255) }
}
