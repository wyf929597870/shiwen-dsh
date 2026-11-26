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
    private val directory = ModelDirectory()
    private fun text(activity: Activity, chinese: String, english: String) =
        if (activity.getSharedPreferences("shiwen-appearance", 0).getString("language", "zh-CN") == "en") english else chinese

    fun show(activity: Activity, store: ModelConfigStore, worker: Executor, revision: String?, adding: Boolean, complete: () -> Unit) {
        worker.execute {
            val old = runCatching {
                when {
                    revision != null -> store.get(revision)
                    adding -> { store.catalog(); null }
                    else -> store.read()
                }
            }
            val unreadable = old.exceptionOrNull()?.message == "MODEL_CONFIG_UNAVAILABLE"
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
                val saved = old.getOrNull()
                val context = DialogAppearance.native(activity)
                val preset = Button(context).apply {
                    text = text(activity, "选择服务商", "Choose provider")
                    panel.addView(this)
                }
                val name = input(text(activity, "供应商名称", "Provider name"), saved?.name ?: "")
                val url = input(text(activity, "API 基础地址（HTTPS）", "API base URL (HTTPS)"), saved?.baseUrl ?: "")
                val key = input(if (saved == null) "API Key" else text(activity, "API Key（地址不变时留空可保留）", "API key (leave blank to reuse for the same endpoint)"), "", true)
                val fetch = Button(context).apply {
                    text = text(activity, "获取模型列表", "Fetch model list")
                    panel.addView(this)
                }
                val model = input(text(activity, "模型 ID（每行一个，也可手动填写）", "Model IDs (one per line, or enter manually)"), saved?.model ?: "").apply {
                    setSingleLine(false)
                    inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
                    maxLines = 6
                }
                fun ids() = model.text.lines().map(String::trim).filter(String::isNotEmpty).distinct()
                preset.setOnClickListener {
                    val custom = text(activity, "自定义兼容接口", "Custom compatible endpoint")
                    val names = arrayOf("SenseNova Token Plan", "DeepSeek", custom)
                    AlertDialog.Builder(context).setTitle(text(activity, "选择服务商", "Choose provider"))
                        .setItems(names) { _, i ->
                            val address = listOf("https://token.sensenova.cn/v1/", "https://api.deepseek.com/", "")[i]
                            if (url.text.toString().trimEnd('/') != address.trimEnd('/')) {
                                key.text.clear(); model.text.clear()
                            }
                            name.setText(if (i == 2) "" else names[i]); url.setText(address)
                            if (i == 2) name.requestFocus() else key.requestFocus()
                        }.show()
                }
                val note = TextView(DialogAppearance.native(activity)).apply {
                    text = if (unreadable) this@ModelConfigDialog.text(activity, "已有配置无法解密，请清除后重新填写。", "The saved settings could not be decrypted. Clear them and configure again.")
                    else if (old.isFailure) this@ModelConfigDialog.text(activity, "此配置已更新，请关闭后重新选择。", "This configuration changed. Close and select it again.")
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
                var pending: okhttp3.Call? = null
                var childDialog: AlertDialog? = null
                dialog.setOnDismissListener {
                    pending?.cancel(); pending = null
                    childDialog?.dismiss()
                    lifecycle?.removeObserver(observer)
                    key.text.clear(); complete()
                }
                lifecycle?.addObserver(observer)
                dialog.show()
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = old.isSuccess
                fetch.isEnabled = old.isSuccess
                if (old.getOrNull() == null && !unreadable) dialog.getButton(AlertDialog.BUTTON_NEUTRAL).visibility = android.view.View.GONE
                dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                fun busy(value: Boolean) {
                    listOf(name, url, model, key, preset, fetch).forEach { it.isEnabled = !value }
                    listOf(-1, -2, -3).forEach { dialog.getButton(it).isEnabled = !value }
                    dialog.setCancelable(!value)
                }
                fetch.setOnClickListener {
                    val request = runCatching {
                        val normalized = ModelConfigStore.normalizeUrl(url.text.toString())
                        directory.request(normalized, ModelConfigStore.endpointKey(saved, normalized, key.text.toString()))
                    }.getOrElse {
                        note.text = text(activity, "请检查 HTTPS 地址和 API Key。修改地址后需重新填写 Key。", "Check the HTTPS URL and API key. A new URL requires entering the key again.")
                        return@setOnClickListener
                    }
                    busy(true)
                    // The user can still cancel a slow provider request and close the editor.
                    dialog.setCancelable(true)
                    dialog.getButton(AlertDialog.BUTTON_NEGATIVE).isEnabled = true
                    note.text = text(activity, "正在获取模型列表…", "Fetching model list…")
                    pending = request
                    fun finish(result: Result<List<ListedModel>>) = activity.runOnUiThread {
                        if (!dialog.isShowing || pending !== request) return@runOnUiThread
                        pending = null
                        busy(false)
                        val rows = result.getOrElse { failure ->
                            note.text = when (failure.message) {
                                "HTTP_401", "HTTP_403" -> text(activity, "服务商拒绝访问，请检查 Key 和账户权限。", "Access denied. Check the key and account permissions.")
                                "EMPTY_LIST" -> text(activity, "服务商未返回模型，可手动填写模型 ID。", "No models returned. You can enter IDs manually.")
                                else -> text(activity, "获取失败，请检查网络和接口地址后重试，也可手动填写模型 ID。", "Check the network and endpoint and retry, or enter model IDs manually.")
                            }
                            return@runOnUiThread
                        }
                        val selected = ids()
                        val listedIds = rows.map { it.id }.toSet()
                        val checked = rows.map { it.id in selected }.toBooleanArray()
                        note.text = text(activity, "已获取 ${rows.size} 个模型。", "Fetched ${rows.size} models.")
                        val picker = AlertDialog.Builder(context).setTitle(text(activity, "选择要保存的模型", "Select models to save"))
                            .setMultiChoiceItems(rows.map { it.label }.toTypedArray(), checked) { _, index, value -> checked[index] = value }
                            .setNegativeButton(text(activity, "取消", "Cancel"), null)
                            .setPositiveButton(text(activity, "确定", "Apply")) { _, _ ->
                                val chosen = rows.filterIndexed { index, _ -> checked[index] }.map { it.id }
                                model.setText((selected.filter { it !in listedIds } + chosen).joinToString("\n"))
                            }.create()
                        childDialog = picker
                        picker.show()
                    }
                    request.enqueue(object : okhttp3.Callback {
                        override fun onFailure(call: okhttp3.Call, e: java.io.IOException) = finish(Result.failure(e))
                        override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) = finish(runCatching { directory.read(response) })
                    })
                }
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                    val provider = name.text.toString()
                    val endpoint = url.text.toString()
                    val selected = ids()
                    val secret = key.text.toString()
                    busy(true)
                    worker.execute {
                        val result = runCatching { store.saveModels(old.getOrThrow()?.revision, provider, endpoint, selected, secret) }
                        activity.runOnUiThread {
                            if (result.isSuccess) dialog.dismiss()
                            else { busy(false); note.text = text(activity, "保存失败：请检查名称、HTTPS 地址、模型名和密钥。修改地址后需重新输入密钥。", "Save failed. Check the name, HTTPS URL, model, and API key. Changing the URL requires entering the key again.") }
                        }
                    }
                }
                dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener {
                    AlertDialog.Builder(DialogAppearance.native(activity)).setMessage(if (unreadable) text(activity,"清除全部无法解密的模型配置？","Clear all unreadable model settings?") else text(activity, "删除这个模型配置及其密钥？", "Delete this model configuration and its API key?"))
                        .setNegativeButton(text(activity, "取消", "Cancel"), null).setPositiveButton(text(activity, "清除", "Clear")) { _, _ ->
                            busy(true)
                            worker.execute {
                                val result = runCatching { if (unreadable) store.clear() else store.remove(old.getOrThrow()!!.revision) }
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
