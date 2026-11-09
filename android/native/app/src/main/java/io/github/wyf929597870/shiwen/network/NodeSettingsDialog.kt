package io.github.wyf929597870.shiwen.network

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
import java.util.concurrent.atomic.AtomicBoolean

internal object NodeSettingsDialog {
    private fun text(activity: Activity, chinese: String, english: String) =
        if (activity.getSharedPreferences("shiwen-appearance", 0).getString("language", "zh-CN") == "en") english else chinese

    fun show(activity: Activity, store: NodeSettingsStore, id: String?, worker: Executor, complete: (String?) -> Unit) {
        val old = id?.let(store::get)
        val completed = AtomicBoolean(false)
        fun finish(nodeId: String?) { if (completed.compareAndSet(false, true)) complete(nodeId) }
        activity.runOnUiThread {
            if (activity.isFinishing || activity.isDestroyed) { finish(null); return@runOnUiThread }
            val panel = LinearLayout(DialogAppearance.native(activity)).apply { orientation = LinearLayout.VERTICAL; setPadding(32, 16, 32, 16) }
            fun field(label: String, value: String, secret: Boolean = false): EditText {
                panel.addView(TextView(DialogAppearance.native(activity)).apply { text = label })
                return EditText(DialogAppearance.native(activity)).apply {
                    setText(value); setSingleLine(true)
                    inputType = InputType.TYPE_CLASS_TEXT or if (secret) InputType.TYPE_TEXT_VARIATION_PASSWORD else InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
                    importantForAutofill = android.view.View.IMPORTANT_FOR_AUTOFILL_NO; panel.addView(this)
                }
            }
            val pairing = field(text(activity, "配对码（从服务电脑的访问密码与设备页面复制）", "Pairing code from the server computer"), "", true)
            val name = field(text(activity, "节点名称", "Node name"), old?.optString("name") ?: "")
            val address = field(text(activity, "服务地址（含 http:// 或 https:// 和端口）", "Server address (include http:// or https:// and port)"), old?.optString("baseUrl") ?: "")
            val backup = field(text(activity, "备用 HTTPS 地址（逗号分隔，配对后可用）", "Backup HTTPS addresses (comma separated, paired nodes only)"),
                old?.optJSONArray("endpoints")?.let { values -> (0 until values.length()).map(values::getString).filterNot { it == old.optString("baseUrl") }.joinToString(", ") } ?: "")
            val password = field(text(activity, "访问密码（已登录且地址不变时可留空）", "Access password (leave blank to keep the current sign-in)"), "", true)
            val allowHttp = CheckBox(DialogAppearance.native(activity)).apply {
                text = this@NodeSettingsDialog.text(activity, "允许可信局域网 HTTP（密码与内容未加密传输）", "Allow HTTP on a trusted LAN (passwords and content are unencrypted)"); isChecked = old?.optBoolean("allowPrivateHttp") == true; panel.addView(this)
            }
            val note = TextView(DialogAppearance.native(activity)).apply { text = this@NodeSettingsDialog.text(activity, "连接后自动同步拾文助手人设与已确认记忆。密码不保存；登录状态加密保存在此手机。", "Connecting syncs the Shiwen agent profile and confirmed memories. The password is not stored; the signed-in session is encrypted on this phone."); panel.addView(this) }
            var currentId = id
            val dialog = AlertDialog.Builder(DialogAppearance.native(activity)).setTitle(text(activity, "服务器节点", "Server node")).setView(ScrollView(DialogAppearance.native(activity)).apply { addView(panel) })
                .setPositiveButton(text(activity, "保存并连接", "Save and connect"), null).setNegativeButton(text(activity, "关闭", "Close"), null).create()
            val lifecycle = (activity as? LifecycleOwner)?.lifecycle
            val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_DESTROY) dialog.dismiss() }
            dialog.setOnDismissListener { lifecycle?.removeObserver(observer); password.text.clear(); pairing.text.clear(); finish(null) }
            lifecycle?.addObserver(observer); dialog.show(); dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            fun busy(value: Boolean) {
                listOf(pairing, name, address, backup, password, allowHttp).forEach { it.isEnabled = !value }
                dialog.getButton(-1).isEnabled = !value; dialog.getButton(-2).isEnabled = !value; dialog.setCancelable(!value)
            }
            dialog.getButton(-1).setOnClickListener {
                val backups = backup.text.toString(); val pairCode = pairing.text.toString(); val nodeName = name.text.toString(); val url = address.text.toString(); val pass = password.text.toString(); val allow = allowHttp.isChecked
                busy(true)
                worker.execute {
                    val result = runCatching {
                        if (pairCode.isNotBlank()) {
                            currentId = NodePairing.pair(store, pairCode, currentId)
                        } else {
                        val row = store.save(currentId, nodeName, url, allow); currentId = row.getString("id")
                        }
                        if (backups.isNotBlank()) {
                            val paired = store.get(currentId!!)
                            check(paired.optString("fingerprint").isNotEmpty()) { "PAIRING_REQUIRED" }
                            val urls = backups.split(',', '，').map { NodeSettingsStore.normalizeUrl(it.trim(), false) }
                            require(urls.size <= 15) { "TOO_MANY_ENDPOINTS" }
                            store.update(currentId!!, paired.getString("baseUrl"), paired.getString("configRevision")) {
                                it.put("endpoints", org.json.JSONArray((listOf(it.getString("baseUrl")) + urls).distinct()))
                            }
                        }
                        NodeConnection(store).refresh(currentId!!, pass.takeIf { it.isNotEmpty() })
                        store.select(currentId)
                    }
                    activity.runOnUiThread {
                        password.text.clear(); pairing.text.clear()
                        if (result.isSuccess) { finish(currentId); dialog.dismiss() } else {
                            busy(false); note.text = when (result.exceptionOrNull()?.message) {
                                "PAIRING_EXPIRED", "PAIRING_RESULT_UNKNOWN" -> this@NodeSettingsDialog.text(activity, "配对码已失效或结果未确认，请在服务电脑重新生成。", "Generate a new pairing code on the server.")
                                "NODE_IDENTITY_MISMATCH" -> this@NodeSettingsDialog.text(activity, "此地址的服务身份不匹配，未替换原节点。", "The server identity does not match. The original node was kept.")
                                "NODE_AUTH_FAILED", "NODE_LOGIN_REQUIRED" -> this@NodeSettingsDialog.text(activity, "请检查访问密码，服务器需要先设置访问密码。", "Check the access password. The server must have an access password configured.")
                                "PROFILE_UNSUPPORTED", "NODE_AGENT_API_UNSUPPORTED" -> this@NodeSettingsDialog.text(activity, "节点已保存，但服务尚未提供人设同步接口，请更新服务端后重试。", "Node saved, but this server does not support profile sync yet. Update the server and try again.")
                                "PROFILE_TOO_LARGE", "NODE_RESPONSE_TOO_LARGE" -> this@NodeSettingsDialog.text(activity, "人设或已确认记忆超过当前传输上限，尚未同步；已有快照仍保留。", "The profile or confirmed memories exceed the transfer limit and were not synced. The previous snapshot is kept.")
                                "HTTP_REQUIRES_EXPLICIT_CONSENT", "HTTP_PUBLIC_ADDRESS_DENIED" -> this@NodeSettingsDialog.text(activity, "HTTP 仅允许明确勾选的可信局域网地址。", "HTTP is allowed only for a trusted LAN address when explicitly enabled.")
                                else -> if (currentId != null) this@NodeSettingsDialog.text(activity, "节点配置已保存，但未完成连接及人设同步。若地址已改，旧地址的登录状态和人设已清除，请检查网络与配置后重试。", "Node settings were saved, but connection and profile sync did not complete. If the address changed, the previous sign-in and profile were cleared. Check the network and settings, then retry.") else this@NodeSettingsDialog.text(activity, "节点尚未保存，请检查名称、地址与网络后重试。", "The node was not saved. Check its name, address, and network, then retry.")
                            }
                        }
                    }
                }
            }
        }
    }
}
