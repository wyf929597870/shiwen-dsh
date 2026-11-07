package io.github.wyf929597870.shiwen.agent

import io.github.wyf929597870.shiwen.DialogAppearance
import android.app.Activity
import android.app.AlertDialog
import android.text.InputType
import android.view.WindowManager
import android.widget.*
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.LifecycleOwner
import java.util.concurrent.Executor

internal object ModelConfigDialog {
    private fun text(activity: Activity, chinese: String, english: String) =
        if (activity.getSharedPreferences("shiwen-appearance", 0).getString("language", "zh-CN") == "en") english else chinese

    fun show(activity: Activity, store: ModelConfigStore, worker: Executor, complete: () -> Unit) {
        worker.execute {
            val old = runCatching { store.read() }
            activity.runOnUiThread {
                if (activity.isFinishing || activity.isDestroyed) { complete(); return@runOnUiThread }
                val panel = LinearLayout(DialogAppearance.native(activity)).apply {
                    orientation = LinearLayout.VERTICAL
                    val padding = (20 * resources.displayMetrics.density).toInt()
                    setPadding(padding, padding, padding, padding)
                }
                fun input(label: String, value: String, secret: Boolean = false): EditText {
                    panel.addView(TextView(DialogAppearance.native(activity)).apply { text = label })
                    return EditText(DialogAppearance.native(activity)).apply {
                        setText(value); setSingleLine(true)
                        inputType = if (secret) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
                            else InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
                        importantForAutofill = android.view.View.IMPORTANT_FOR_AUTOFILL_NO
                        panel.addView(this)
                    }
                }
                val name = input(text(activity, "供应商名称", "Provider name"), old.getOrNull()?.name ?: "")
                val url = input(text(activity, "API 基础地址（HTTPS，通常以 /v1/ 结尾）", "API base URL (HTTPS, usually ending in /v1/)"), old.getOrNull()?.baseUrl ?: "")
                val model = input(text(activity, "模型名称（需支持工具调用）", "Model name (must support tool calling)"), old.getOrNull()?.model ?: "")
                val key = input(if (old.getOrNull() == null) "API Key" else text(activity, "API Key（地址不变时留空可保留）", "API key (leave blank to keep it if the URL is unchanged)"), "", true)
                val note = TextView(DialogAppearance.native(activity)).apply {
                    text = if (old.isFailure) this@ModelConfigDialog.text(activity, "已有配置无法解密，请清除后重新填写。", "The saved settings could not be decrypted. Clear them and configure again.")
                    else this@ModelConfigDialog.text(activity, "仅保存在此手机，不参与资料库同步。保存配置不会发送模型请求。", "Stored only on this phone and excluded from library sync. Saving settings will not send a model request.")
                    panel.addView(this)
                }
                val dialog = AlertDialog.Builder(DialogAppearance.native(activity)).setTitle(text(activity, "手机模型配置", "Phone model settings"))
                    .setView(ScrollView(DialogAppearance.native(activity)).apply { addView(panel) })
                    .setPositiveButton(text(activity, "保存", "Save"), null).setNegativeButton(text(activity, "取消", "Cancel"), null)
                    .setNeutralButton(text(activity, "清除配置", "Clear settings"), null).create()
                val lifecycle = (activity as? LifecycleOwner)?.lifecycle
                val observer = LifecycleEventObserver { _, event ->
                    if (event == Lifecycle.Event.ON_DESTROY) dialog.dismiss()
                }
                dialog.setOnDismissListener {
                    lifecycle?.removeObserver(observer)
                    key.text.clear(); complete()
                }
                lifecycle?.addObserver(observer)
                dialog.show()
                dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                fun busy(value: Boolean) {
                    listOf(name, url, model, key).forEach { it.isEnabled = !value }
                    listOf(-1, -2, -3).forEach { dialog.getButton(it).isEnabled = !value }
                    dialog.setCancelable(!value)
                }
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                    val values = listOf(name.text.toString(), url.text.toString(), model.text.toString(), key.text.toString())
                    busy(true)
                    worker.execute {
                        val result = runCatching { store.save(values[0], values[1], values[2], values[3]) }
                        activity.runOnUiThread {
                            if (result.isSuccess) dialog.dismiss()
                            else { busy(false); note.text = text(activity, "保存失败：请检查名称、HTTPS 地址、模型名和密钥。修改地址后需重新输入密钥。", "Save failed. Check the name, HTTPS URL, model, and API key. Changing the URL requires entering the key again.") }
                        }
                    }
                }
                dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener {
                    AlertDialog.Builder(DialogAppearance.native(activity)).setMessage(text(activity, "清除此手机的模型配置和密钥？已开始的请求不受影响。", "Clear the model settings and API key from this phone? Requests already in progress are unaffected."))
                        .setNegativeButton(text(activity, "取消", "Cancel"), null).setPositiveButton(text(activity, "清除", "Clear")) { _, _ ->
                            busy(true)
                            worker.execute {
                                val result = runCatching { store.clear() }
                                activity.runOnUiThread {
                                    if (result.isSuccess) dialog.dismiss()
                                    else { busy(false); note.text = text(activity, "清除失败，请重试。", "Could not clear settings. Try again.") }
                                }
                            }
                        }.show()
                }
            }
        }
    }
}
