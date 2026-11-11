// Split from the original app.js; loaded in original order (see index.html).
function renderProxyTestResult(id, result) {
  if (id == null) return;
  const targetId = String(id);
  const els = Array.from(
    dom.proxyKeyGrid.querySelectorAll("[data-proxy-result]"),
  ).filter((el) => el.dataset.proxyResult === targetId);
  if (!els.length) return;
  let text;
  let className;
  if (result && result.ok) {
    text = `可用 · ${result.ms} ms · ${result.model || ""}`;
    className = "proxy-test-result ok";
  } else {
    const detail =
      result && result.error ? ` · ${truncate(result.error, 90)}` : "";
    const charged =
      result && result.disabled
        ? " · 已达门槛，已禁用"
        : result && typeof result.fail_count === "number"
          ? ` · 连续失败 ${result.fail_count} 次`
          : "";
    text = `不可用 · HTTP ${result && result.status ? result.status : "—"}${detail}${charged}`;
    className = "proxy-test-result fail";
  }
  for (const el of els) {
    el.textContent = text;
    el.className = className;
  }
}

/** Returns the result object so the batch loop can count it. */
async function testProxyKey(fp, id, { fromBatch = false, model = null } = {}) {
  if (id == null || id === "") return null;
  if (!fromBatch && state.proxyBusy) return null;
  const targetId = String(id);
  const token = `${fp}:${targetId}`;
  if (state.proxyTestingKeys.has(token)) return null;

  const targetFp = fp || (selectedProxyProvider() || {}).fp || null;
  const beforeProvider = (state.proxy?.providers || []).find(
    (item) => item.fp === targetFp,
  );
  const selectedModel = String(model ?? dom.proxyTestModel.value ?? "").trim();
  if (!selectedModel) {
    setProxyNotice("请先在「来源设定」填写 Models。", "info");
    return null;
  }
  const beforeKey = (beforeProvider?.keys || []).find(
    (k) => String(k.id ?? "") === targetId,
  );
  const wasDirty = !!(
    beforeKey &&
    (beforeKey.disabled || Number(beforeKey.fail_count || 0) > 0)
  );
  state.proxyTestingKeys.add(token);
  updateProxyCardButtonsDisabled();

  for (const el of Array.from(
    dom.proxyKeyGrid.querySelectorAll("[data-proxy-result]"),
  ).filter((node) => node.dataset.proxyResult === targetId)) {
    el.textContent = "测试中...";
    el.className = "proxy-test-result";
  }

  let result;
  try {
    if (MOCK) {
      const provider = (state.proxy?.providers || []).find(
        (item) => item.fp === targetFp,
      );
      if (provider) {
        provider.test_model = selectedModel;
        mockOverrideForProvider(provider.fp).test_model = selectedModel;
        const ki = (provider.keys || []).findIndex(
          (k) => String(k.id ?? "") === targetId,
        );
        const rawKey = ki >= 0 ? (provider._mockPlainKeys || [])[ki] : "";
        if (rawKey) {
          const override = mockOverrideForProvider(provider.fp);
          const prev = override.keys.get(rawKey) || {};
          override.keys.set(rawKey, {
            ...prev,
            disabled: false,
            fail_count: 0,
          });
        }
      }
      result = {
        ok: true,
        status: 200,
        ms: 123,
        model: selectedModel,
        fail_count: 0,
        disabled: false,
      };
    } else {
      result = await api("/api/proxy/test", {
        method: "POST",
        auth: true,
        body: { fp, id: Number(targetId), model: selectedModel },
      });
    }
  } catch (err) {
    result = { ok: false, status: err.status || 0, error: err.message };
  } finally {
    state.proxyTestingKeys.delete(token);
    updateProxyCardButtonsDisabled();
  }

  if (beforeProvider && result && result.model) {
    beforeProvider.test_model = result.model;
  }
  if (state.settings && typeof result?.settings_version === "number") {
    state.settings.version = result.settings_version;
  }

  const store = proxyResultStore(targetFp);
  if (store) store.set(targetId, result);
  renderProxyTestResult(targetId, result);

  if (
    result &&
    !result.disabled &&
    result.ok === false &&
    typeof result.fail_count === "number"
  ) {
    const provider = (state.proxy?.providers || []).find(
      (item) => item.fp === targetFp,
    );
    for (const k of provider?.keys || []) {
      if (String(k.id ?? "") === targetId) k.fail_count = result.fail_count;
    }
    for (const card of Array.from(
      dom.proxyKeyGrid.querySelectorAll("[data-key-id]"),
    ).filter((node) => node.dataset.keyId === targetId)) {
      const strong = card.querySelector("[data-proxy-fail-count]");
      if (strong) strong.textContent = String(result.fail_count);
    }
  }

  if (!fromBatch && result && result.disabled) {
    await loadProxyState({ preserveResults: true });
    setProxyNotice(
      `这把密钥已达门槛并被禁用（连续失败 ${result.fail_count} 次）。`,
      "error",
    );
  } else if (!fromBatch && result && result.ok && wasDirty) {
    await loadProxyState({ preserveResults: true });
    clearProxyNotice({ keepGlobal: true });
  }
  return result;
}

function proxyActionButtons() {
  return [
    dom.proxyTestActive,
    dom.proxyTestDisabled,
    dom.proxyRecoverAll,
    dom.proxyTestModel,
    dom.proxyProvider,
  ];
}

async function runProxyBatch(mode) {
  if (state.proxyBusy) return;
  const p = selectedProxyProvider();
  if (!p) return;
  const selectedModel = dom.proxyTestModel.value.trim();
  if (!selectedModel) {
    setProxyNotice("请先在「来源设定」填写 Models。", "info");
    return;
  }
  const keys = (p.keys || []).filter((k) => {
    if (k.id == null) return false;
    // Only the two scopes the toolbar exposes: healthy keys or disabled keys.
    return mode === "disabled" ? k.disabled : !k.disabled;
  });
  if (!keys.length) {
    setProxyNotice("没有符合这个条件的密钥。", "info");
    return;
  }

  state.proxyBusy = true;
  proxyActionButtons().forEach((b) => {
    b.disabled = true;
  });
  updateProxyCardButtonsDisabled();
  const store = proxyResultStore(p.fp);
  if (store) {
    for (const k of keys) store.delete(String(k.id));
  }

  let ok = 0;
  let fail = 0;
  try {
    for (let i = 0; i < keys.length; i++) {
      setProxyNotice(
        `批量测试中：${i + 1} / ${keys.length}（可用 ${ok}，不可用 ${fail}）`,
        "info",
      );
      const result = await testProxyKey(p.fp, keys[i].id, {
        fromBatch: true,
        model: selectedModel,
      });
      if (result && result.ok) ok++;
      else fail++;
    }
  } finally {
    // Reset both flag and UI controls even if requests or reload fail.
    state.proxyBusy = false;
    dom.proxyProvider.disabled = false;
    renderProxyToolbar();
    updateProxyCardButtonsDisabled();
  }

  await loadProxyState({ preserveResults: true });
  setProxyNotice(
    `批量测试完成：共 ${keys.length} 把，可用 ${ok}，不可用 ${fail}。`,
    "info",
  );
}

async function recoverProxyKey(fp, id) {
  if (state.proxyBusy || id == null || id === "") return;
  const targetId = String(id);
  const token = `${fp}:${targetId}`;
  if (state.proxyRecoveringKeys.has(token)) return;

  const currentProvider = selectedProxyProvider();
  const targetFp = (currentProvider || {}).fp;
  state.proxyRecoveringKeys.add(token);
  updateProxyCardButtonsDisabled();
  try {
    if (!MOCK) {
      await api("/api/proxy/recover", {
        method: "POST",
        auth: true,
        body: { fp, id: Number(targetId) },
      });
    } else if (currentProvider) {
      const ki = (currentProvider.keys || []).findIndex(
        (k) => String(k.id ?? "") === targetId,
      );
      const rawKey = ki >= 0 ? (currentProvider._mockPlainKeys || [])[ki] : "";
      if (rawKey) {
        const override = mockOverrideForProvider(currentProvider.fp);
        const prev = override.keys.get(rawKey) || {};
        override.keys.set(rawKey, { ...prev, disabled: false, fail_count: 0 });
      }
    }
    const store = state.proxyLastResults.get(targetFp);
    if (store) store.delete(targetId);
    await loadProxyState({ preserveResults: true });
  } catch (err) {
    dom.proxyError.textContent = `恢复失败：${err.message}`;
    dom.proxyError.classList.remove("hidden");
  } finally {
    state.proxyRecoveringKeys.delete(token);
    updateProxyCardButtonsDisabled();
  }
}

async function recoverAllProxyKeys() {
  if (state.proxyBusy) return;
  const currentProvider = selectedProxyProvider();
  if (!currentProvider) return;
  const enabled =
    !!(state.proxy && state.proxy.proxy_enabled) &&
    currentProvider.enabled !== false;
  if (!enabled) return;

  const disabledKeys = (currentProvider.keys || []).filter(
    (k) => k.disabled && k.id != null,
  );
  if (!disabledKeys.length) {
    setProxyNotice("当前供应商没有已失效的密钥。", "info");
    return;
  }
  if (
    !confirm(
      `确定恢复当前供应商下的全部 ${disabledKeys.length} 把失效密钥？恢复后会重新参与轮用。`,
    )
  ) {
    return;
  }

  const targetFp = currentProvider.fp;
  state.proxyBusy = true;
  proxyActionButtons().forEach((b) => {
    b.disabled = true;
  });
  updateProxyCardButtonsDisabled();

  let recoveredCount = 0;
  try {
    if (!MOCK) {
      const res = await api("/api/proxy/recover", {
        method: "POST",
        auth: true,
        body: { fp: currentProvider.fp, all: true },
      });
      recoveredCount = Number(res.recovered ?? disabledKeys.length);
    } else {
      const override = mockOverrideForProvider(currentProvider.fp);
      (currentProvider.keys || []).forEach((k, ki) => {
        if (!k.disabled || k.id == null) return;
        const rawKey = (currentProvider._mockPlainKeys || [])[ki] || "";
        if (!rawKey) return;
        const prev = override.keys.get(rawKey) || {};
        override.keys.set(rawKey, { ...prev, disabled: false, fail_count: 0 });
        recoveredCount++;
      });
    }
    const store = state.proxyLastResults.get(targetFp);
    if (store) {
      for (const k of disabledKeys) store.delete(String(k.id));
    }
  } catch (err) {
    setProxyNotice(`恢复失败：${err.message}`, "error");
    return;
  } finally {
    state.proxyBusy = false;
    dom.proxyProvider.disabled = false;
    renderProxyToolbar();
    updateProxyCardButtonsDisabled();
  }

  const loaded = await loadProxyState({ preserveResults: true });
  if (loaded) {
    setProxyNotice(
      recoveredCount > 0
        ? `已恢复当前供应商的 ${recoveredCount} 把失效密钥。`
        : "当前供应商没有需要恢复的失效密钥。",
      "info",
    );
  }
}
