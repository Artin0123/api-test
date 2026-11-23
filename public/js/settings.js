// Split from the original app.js; loaded in original order (see index.html).
const HTTP_URL_RE = /^https?:\/\/\S+/i;

const PROXY_SETTING_SPECS = {
  proxy_fail_threshold: { label: "失败禁用门槛", fallback: 3, min: 1, max: null },
  proxy_max_retries: { label: "最多重试次数", fallback: 3, min: 0, max: 3 },
  proxy_upstream_timeout_ms: { label: "上游超时 (ms)", fallback: 120000, min: 1000, max: 600000 },
};

// ── Settings modal ────────────────────────────────────────────────────────
function settingsSecretFields() {
  return [
    {
      input: dom.setProxyPassword,
      toggle: dom.setProxyPasswordToggle,
      copy: dom.setProxyPasswordCopy,
      showLabel: "显示密码",
      hideLabel: "隐藏密码",
    },
  ];
}

function setSecretVisibility(field, visible) {
  if (!field?.input || !field?.toggle) return;
  field.input.type = visible ? "text" : "password";
  field.toggle.innerHTML = visible ? EYE_OFF_ICON_SVG : EYE_ICON_SVG;
  field.toggle.setAttribute("aria-pressed", String(visible));
  const label = visible ? field.hideLabel : field.showLabel;
  field.toggle.setAttribute("aria-label", label);
  field.toggle.title = label;
}

function syncSecretCopyState(field) {
  if (!field?.input || !field?.copy) return;
  if (copyBtnTimers.has(field.copy)) return;
  field.copy.disabled = !field.input.value.trim();
}

function resetSettingsSecrets() {
  for (const field of settingsSecretFields()) {
    if (field.copy) {
      const pending = copyBtnTimers.get(field.copy);
      if (pending) {
        clearTimeout(pending);
        copyBtnTimers.delete(field.copy);
      }
      field.copy.innerHTML = COPY_ICON_SVG;
      delete field.copy.dataset.origHtml;
      field.copy.classList.remove("copied");
    }
    setSecretVisibility(field, false);
    syncSecretCopyState(field);
  }
}

function openSettings() {
  const s = state.settings || {};
  applySettingsToUI();
  dom.setDiscordUrl.value = s.discord_webhook_url || "";
  dom.setGithubUrl.value = s.github_url || "";
  dom.setProxyPassword.value = s.proxy_password || "";
  dom.setProxyFailThreshold.value = String(
    s.proxy_fail_threshold ?? PROXY_SETTING_SPECS.proxy_fail_threshold.fallback,
  );
  dom.setProxyMaxRetries.value = String(
    s.proxy_max_retries ?? PROXY_SETTING_SPECS.proxy_max_retries.fallback,
  );
  dom.setProxyTimeoutMs.value = String(
    s.proxy_upstream_timeout_ms ?? PROXY_SETTING_SPECS.proxy_upstream_timeout_ms.fallback,
  );
  resetSettingsSecrets();
  dom.settingsError.textContent = "";
  dom.settingsOk.classList.add("hidden");
  openModal(dom.settingsOverlay, dom.setDiscordUrl);
}

function closeSettings() {
  resetSettingsSecrets();
  closeModal(dom.settingsOverlay);
}

function settingsPatchUnchanged(currentSettings, patch) {
  if (!currentSettings) return false;
  for (const [key, val] of Object.entries(patch)) {
    const existing = Object.prototype.hasOwnProperty.call(
      PROXY_SETTING_SPECS,
      key,
    )
      ? (currentSettings[key] ?? PROXY_SETTING_SPECS[key].fallback)
      : typeof currentSettings[key] === "string"
        ? currentSettings[key]
        : "";
    if (existing !== val) return false;
  }
  return true;
}

async function saveSettings() {
  dom.settingsError.textContent = "";
  dom.settingsOk.classList.add("hidden");

  const discordUrl = dom.setDiscordUrl.value.trim();
  if (discordUrl && !HTTP_URL_RE.test(discordUrl)) {
    dom.settingsError.textContent =
      "Discord Webhook URL 必须以 http:// 或 https:// 开头";
    return;
  }
  const githubUrl = dom.setGithubUrl.value.trim();
  if (githubUrl && !HTTP_URL_RE.test(githubUrl)) {
    dom.settingsError.textContent =
      "GitHub Actions URL 必须以 http:// 或 https:// 开头";
    return;
  }

  const kvMode = isKvStorageMode();

  const parseSettingInt = (input, spec) => {
    const raw = input.value.trim();
    if (!raw) return spec.fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < spec.min || (spec.max != null && n > spec.max)) {
      const range = spec.max == null ? `>= ${spec.min}` : `${spec.min} ~ ${spec.max}`;
      throw new Error(`${spec.label} 必须是 ${range} 的整数`);
    }
    return n;
  };

  let patch;
  try {
    patch = {
      github_url: githubUrl,
      discord_webhook_url: discordUrl,
    };
    if (!kvMode) {
      patch.proxy_password = dom.setProxyPassword.value.trim();
      patch.proxy_fail_threshold = parseSettingInt(
        dom.setProxyFailThreshold,
        PROXY_SETTING_SPECS.proxy_fail_threshold,
      );
      patch.proxy_max_retries = parseSettingInt(
        dom.setProxyMaxRetries,
        PROXY_SETTING_SPECS.proxy_max_retries,
      );
      patch.proxy_upstream_timeout_ms = parseSettingInt(
        dom.setProxyTimeoutMs,
        PROXY_SETTING_SPECS.proxy_upstream_timeout_ms,
      );
    }
  } catch (err) {
    dom.settingsError.textContent = err.message;
    return;
  }

  if (settingsPatchUnchanged(state.settings, patch)) {
    closeSettings();
    return;
  }

  dom.settingsSave.disabled = true;
  try {
    // Send only the fields this modal owns so an open edit doesn't race providers[].
    const version = await postSettings(patch);
    const current = state.settings || {};
    state.settings = { ...current, ...patch };
    if (version !== undefined) state.settings.version = version;
    syncMockSettings(state.settings);
    applySettingsToUI();
    closeSettings();
    if (!kvMode && state.proxy) loadProxyState({ preserveOrder: true });
  } catch (err) {
    dom.settingsError.textContent = err.message;
  } finally {
    dom.settingsSave.disabled = false;
  }
}

async function testDiscordWebhook() {
  const url = dom.setDiscordUrl.value.trim();
  if (!url) {
    dom.settingsError.textContent = "请先输入 Discord Webhook URL";
    return;
  }
  dom.settingsError.textContent = "";
  const originalText = dom.testDiscordBtn.textContent;
  dom.testDiscordBtn.disabled = true;
  dom.testDiscordBtn.textContent = "发送中...";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content:
          "🔔 **API Key Tester**：这是一条测试通知。如果您看到此消息，表示 Webhook 已成功连线！",
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    dom.testDiscordBtn.textContent = "发送成功！";
    setTimeout(() => {
      dom.testDiscordBtn.textContent = originalText;
      dom.testDiscordBtn.disabled = false;
    }, 2000);
  } catch (err) {
    dom.settingsError.textContent = `发送失败: ${err.message}`;
    dom.testDiscordBtn.textContent = originalText;
    dom.testDiscordBtn.disabled = false;
  }
}

function applySettingsToUI() {
  const s = state.settings || {};
  const kvMode = isKvStorageMode();
  if (dom.proxyTabBtn) {
    dom.proxyTabBtn.classList.toggle("hidden", kvMode);
  }
  if (dom.logsTabBtn) {
    dom.logsTabBtn.classList.toggle("hidden", kvMode);
  }
  if (dom.tabProxy) {
    if (kvMode && dom.tabProxy.classList.contains("active")) {
      switchTab("config");
    } else if (kvMode) {
      dom.tabProxy.classList.add("hidden");
      dom.tabProxy.classList.remove("active");
    }
  }
  if (dom.tabLogs) {
    if (kvMode && dom.tabLogs.classList.contains("active")) {
      switchTab("config");
    } else if (kvMode) {
      dom.tabLogs.classList.add("hidden");
      dom.tabLogs.classList.remove("active");
    }
  }
  if (dom.settingsProxyFields) {
    dom.settingsProxyFields.classList.toggle("hidden", kvMode);
  }
  if (kvMode) {
    state.proxy = null;
    state.proxyStateSeq = null;
    state.logsData = null;
    if (typeof stopProxyLiveTimers === "function") stopProxyLiveTimers();
  }

  const url = String(s.github_url || "").trim();
  if (url && HTTP_URL_RE.test(url)) {
    dom.runNowBtn.href = url;
    dom.runNowBtn.removeAttribute("aria-disabled");
    dom.runNowBtn.title = "前往 GitHub Actions 立即执行测试或查看记录";
  } else {
    dom.runNowBtn.removeAttribute("href");
    dom.runNowBtn.setAttribute("aria-disabled", "true");
    dom.runNowBtn.title = "请在右上角「设定」填写 GitHub Actions URL 后可用";
  }
}

// ── Config tab ─────────────────────────────────────────────────────────────
async function loadConfig(prefetchedData = null) {
  const reqId = ++state.reqSeq.config;
  dom.configLoading.classList.remove("hidden");
  dom.configError.classList.add("hidden");
  dom.configSaveError.textContent = "";
  dom.providerGrid.classList.add("hidden");
  dom.providerEmpty.classList.add("hidden");

  try {
    let data;
    if (prefetchedData) {
      data = prefetchedData;
    } else if (MOCK) {
      const mock = await getMock();
      data = {
        settings: state.settings || mock.settings,
        storage_backend: mock.storage_backend || state.storageBackend || "d1",
      };
    } else {
      data = await api("/api/settings", { auth: true });
    }
    if (reqId !== state.reqSeq.config) return;
    applyFetchedSettings(data);
    await ensureProviderFps((state.settings || {}).providers || []);
    if (reqId !== state.reqSeq.config) return;
    syncMockSettings(state.settings);
    renderProviderGrid();
  } catch (err) {
    if (reqId !== state.reqSeq.config) return;
    dom.configError.textContent = `读取失败：${err.message}`;
    dom.configError.classList.remove("hidden");
  } finally {
    if (reqId === state.reqSeq.config) {
      dom.configLoading.classList.add("hidden");
    }
  }
}
