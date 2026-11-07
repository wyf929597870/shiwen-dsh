package io.github.wyf929597870.shiwen;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private boolean restoringActivity;
    private final androidx.activity.OnBackPressedCallback backCallback = new androidx.activity.OnBackPressedCallback(true) {
        @Override public void handleOnBackPressed() { handleSystemBack(); }
    };
    @Override public void onCreate(android.os.Bundle state) {
        registerPlugin(io.github.wyf929597870.shiwen.probe.LibraryProbePlugin.class);
        restoringActivity = state != null;
        // Capacitor dispatches the launch Intent through onNewIntent during super.onCreate.
        super.onCreate(state);
        getOnBackPressedDispatcher().addCallback(this, backCallback);
        if (bridge != null && bridge.getWebView() != null) {
            bridge.getWebView().setWebChromeClient(new com.getcapacitor.BridgeWebChromeClient(bridge) {
                @Override public boolean onJsConfirm(android.webkit.WebView view, String url, String message, android.webkit.JsResult result) {
                    if (isFinishing() || isDestroyed()) { result.cancel(); return true; }
                    String theme = getSharedPreferences("shiwen-appearance", MODE_PRIVATE).getString("theme", "system");
                    boolean dark = "dark".equals(theme) || ("system".equals(theme) &&
                        (getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
                            == android.content.res.Configuration.UI_MODE_NIGHT_YES);
                    boolean english = "en".equals(getSharedPreferences("shiwen-appearance", MODE_PRIVATE).getString("language", "zh-CN"));
                    android.content.Context context = new android.view.ContextThemeWrapper(MainActivity.this,
                        dark ? android.R.style.Theme_Material_Dialog_Alert : android.R.style.Theme_Material_Light_Dialog_Alert);
                    new android.app.AlertDialog.Builder(context).setMessage(message)
                        .setPositiveButton(english ? "OK" : "确定", (dialog, which) -> result.confirm())
                        .setNegativeButton(english ? "Cancel" : "取消", (dialog, which) -> result.cancel())
                        .setOnCancelListener(dialog -> result.cancel()).show();
                    return true;
                }
            });
        }
        applySystemBars();
        restoringActivity = false;
    }
    public void applySystemBars() {
        String theme = getSharedPreferences("shiwen-appearance", MODE_PRIVATE).getString("theme", "system");
        boolean light = "light".equals(theme) || ("system".equals(theme) &&
            (getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
                != android.content.res.Configuration.UI_MODE_NIGHT_YES);
        setTheme(light ? io.github.wyf929597870.shiwen.R.style.Shiwen_Light : io.github.wyf929597870.shiwen.R.style.Shiwen_Dark);
        android.view.View decor = getWindow().getDecorView();
        int flags = decor.getSystemUiVisibility();
        int lightFlags = android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | android.view.View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        decor.setSystemUiVisibility(light ? flags | lightFlags : flags & ~lightFlags);
        androidx.core.view.WindowInsetsControllerCompat controller = androidx.core.view.WindowCompat.getInsetsController(getWindow(), decor);
        controller.setAppearanceLightStatusBars(light);
        controller.setAppearanceLightNavigationBars(light);
    }
    private void handleSystemBack() {
        if (bridge == null || bridge.getWebView() == null) { fallbackBack(); return; }
        bridge.getWebView().evaluateJavascript(
            "typeof window.__shiwenBack === 'function' && window.__shiwenBack()",
            result -> { if (!"true".equals(result)) fallbackBack(); });
    }
    private void fallbackBack() {
        backCallback.setEnabled(false);
        getOnBackPressedDispatcher().onBackPressed();
        backCallback.setEnabled(true);
    }
    @Override public void onResume() {
        super.onResume();
        applySystemBars();
    }
    @Override public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applySystemBars();
    }
    @Override public void onConfigurationChanged(android.content.res.Configuration configuration) {
        super.onConfigurationChanged(configuration);
        applySystemBars();
        if (bridge != null && bridge.getWebView() != null) {
            boolean dark = (configuration.uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
                == android.content.res.Configuration.UI_MODE_NIGHT_YES;
            bridge.getWebView().evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('shiwen-system-theme',{detail:" + dark + "}))", null);
        }
    }
    @Override protected void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (!restoringActivity) acceptSharedText(intent);
    }
    private void acceptSharedText(android.content.Intent intent) {
        try {
            new io.github.wyf929597870.shiwen.library.ShareInboxStore(this, "shiwen-share-inbox").receive(intent);
        } catch (Exception error) {
            boolean english = "en".equals(getSharedPreferences("shiwen-appearance", MODE_PRIVATE).getString("language", "zh-CN"));
            android.widget.Toast.makeText(this, english ? "Could not receive shared text. The inbox or text is too large." : "无法接收分享：待保存内容已满或文本过长。", android.widget.Toast.LENGTH_LONG).show();
        }
    }
}
