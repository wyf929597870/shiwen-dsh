package io.github.wyf929597870.shiwen.library

import android.util.JsonReader
import android.util.JsonToken
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.Writer

/** Match JSONObject.toString() for existing restore-request fingerprints, one value at a time. */
internal fun writeArchiveFingerprintJson(writer: Writer, value: Any?) {
    when (value) {
        null, JSONObject.NULL -> writer.write("null")
        is JSONObject -> {
            writer.write("{")
            value.keys().asSequence().forEachIndexed { index, key ->
                if (index > 0) writer.write(",")
                writer.write(JSONObject.quote(key)); writer.write(":")
                writeArchiveFingerprintJson(writer, value.get(key))
            }
            writer.write("}")
        }
        is JSONArray -> {
            writer.write("[")
            for (index in 0 until value.length()) {
                if (index > 0) writer.write(",")
                writeArchiveFingerprintJson(writer, value.get(index))
            }
            writer.write("]")
        }
        is String -> writer.write(JSONObject.quote(value))
        is Number -> writer.write(JSONObject.numberToString(value))
        is Boolean -> writer.write(value.toString())
        else -> error("ARCHIVE_JSON_VALUE_INVALID")
    }
}

/** Parse directly from staged UTF-8, without a whole-file byte array or JSON string. */
internal fun readArchiveJson(file: File): JSONObject = JsonReader(file.reader(Charsets.UTF_8).buffered()).use { reader ->
    fun read(depth: Int): Any {
        check(depth <= 128) { "ARCHIVE_JSON_TOO_DEEP" }
        return when (reader.peek()) {
            JsonToken.BEGIN_OBJECT -> JSONObject().also { value ->
                reader.beginObject()
                while (reader.hasNext()) {
                    val key = reader.nextName()
                    check(!value.has(key)) { "ARCHIVE_JSON_DUPLICATE_KEY" }
                    value.put(key, read(depth + 1))
                }
                reader.endObject()
            }
            JsonToken.BEGIN_ARRAY -> JSONArray().also { value ->
                reader.beginArray()
                while (reader.hasNext()) value.put(read(depth + 1))
                reader.endArray()
            }
            JsonToken.STRING -> reader.nextString()
            JsonToken.NUMBER -> reader.nextString().let { it.toLongOrNull() ?: it.toDouble() }
            JsonToken.BOOLEAN -> reader.nextBoolean()
            JsonToken.NULL -> { reader.nextNull(); JSONObject.NULL }
            else -> error("ARCHIVE_JSON_INVALID")
        }
    }
    val value = read(0) as? JSONObject ?: error("ARCHIVE_JSON_INVALID")
    check(reader.peek() == JsonToken.END_DOCUMENT) { "ARCHIVE_JSON_TRAILING_DATA" }
    value
}
