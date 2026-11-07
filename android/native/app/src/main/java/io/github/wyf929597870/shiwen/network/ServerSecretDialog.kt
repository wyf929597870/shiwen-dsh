package io.github.wyf929597870.shiwen.network

import io.github.wyf929597870.shiwen.DialogAppearance
import android.app.Activity
import android.app.AlertDialog
import android.text.InputType
import android.view.View
import android.view.WindowManager
import android.widget.EditText
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.LifecycleOwner
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean

internal object ServerSecretDialog {
    fun show(activity: Activity, writer: ServerSecretSettings, executor: Executor, id: String, configRevision: String,
        namespace: String, path: JSONArray, revision: Long, english: Boolean, complete: (JSONObject) -> Unit) {
        activity.runOnUiThread {
            if (activity.isFinishing || activity.isDestroyed) { complete(JSONObject().put("status", "cancelled")); return@runOnUiThread }
            val done = AtomicBoolean(false); var sending = false
            fun finish(result: JSONObject) { if (done.compareAndSet(false, true)) complete(result) }
            val input = EditText(DialogAppearance.native(activity)).apply {
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
                importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
                setSingleLine(true); setPadding(32, 24, 32, 24)
                filters = arrayOf(android.text.InputFilter.LengthFilter(8192))
            }
            val dialog = AlertDialog.Builder(DialogAppearance.native(activity)).setTitle(if (english) "Server credential" else "服务器密钥")
                .setMessage("$namespace / ${(0 until path.length()).joinToString(" / ") { path.getString(it) }}")
                .setView(input).setNegativeButton(if (english) "Cancel" else "取消", null)
                .setPositiveButton(if (english) "Save" else "保存", null).create()
            val lifecycle = (activity as? LifecycleOwner)?.lifecycle
            val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP || event == Lifecycle.Event.ON_DESTROY) dialog.dismiss() }
            dialog.setOnDismissListener {
                lifecycle?.removeObserver(observer); input.text?.clear()
                if (!sending) finish(JSONObject().put("status", "cancelled"))
            }
            lifecycle?.addObserver(observer)
            dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE); dialog.show()
            dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                if (sending) return@setOnClickListener
                val secret = input.text.toString()
                if (secret.isEmpty()) { input.error = if (english) "Enter a credential" else "请输入密钥"; return@setOnClickListener }
                sending = true; input.text?.clear(); dialog.dismiss()
                executor.execute {
                    val result = runCatching { writer.set(id, configRevision, namespace, path, revision, secret) }
                        .getOrElse { JSONObject().put("status", "rejected").put("code", "SECRET_NOT_SENT_CHECK_NODE") }
                    finish(result)
                }
            }
        }
    }
}
