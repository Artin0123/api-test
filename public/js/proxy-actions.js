// Split from the original app.js; loaded in original order (see index.html).
const MAX_PROXY_TOASTS = 3;
const PROXY_TOAST_OK_MS = 5000;
const PROXY_TOAST_FAIL_MS = 20000;
const PROXY_TOAST_FADE_MS = 300;
const PROXY_TEST_TIMEOUT_MS = 20000;

function dismissProxyToast(toast) {
  if (!toast || toast.dataset.leaving === "1") return;
  toast.dataset.leaving = "1";
  if (toast._timer) {
    clearTimeout(toast._timer);
    toast._timer = null;
  }
  const root = toast.parentElement;
  const siblings = root
    ? Array.from(root.querySelectorAll(".proxy-toast")).filter(
        (el) => el !== toast && el.dataset.leaving !== "1",
      )
    : [];
  const oldTops = new Map(
    siblings.map((el) => [el, el.getBoundingClientRect().top]),
  );

  toast.style.top = `${toast.offsetTop}px`;
  toast.classList.remove("is-visible");
  toast.classList.add("is-leaving");

  if (siblings.length) {
    for (const el of siblings) {
      const dy = oldTops.get(el) - el.getBoundingClientRect().top;
      if (dy) {
        el.style.transition = "none";
        el.style.transform = `translateY(${dy}px)`;
      }
    }
    void root.offsetHeight;
    for (const el of siblings) {
      el.style.transition = "";
      el.style.transform = "";
    }
  }

  setTimeout(() => {
    toast.remove();
  }, PROXY_TOAST_FADE_MS);
}

function showProxyToast(
  message,
  { type = "info", duration = 0, pending = false } = {},
) {
  const root = dom.proxyToastRoot;
  if (!root) return null;

  if (!pending) {
    const active = Array.from(root.querySelectorAll(".proxy-toast")).filter(
      (el) => el.dataset.leaving !== "1" && el.dataset.pending !== "1",
    );
    while (active.length >= MAX_PROXY_TOASTS) {
      dismissProxyToast(active.shift());
    }
  }
  // Only prune excess leaving nodes on rapid burst clicks so normal transitions
  // let the oldest toast fade upward smoothly instead of snapping.
  const leaving = Array.from(root.querySelectorAll(".proxy-toast.is-leaving"));
  while (leaving.length > 1) {
    leaving.shift().remove();
  }

  const toast = document.createElement("div");
  toast.className = `proxy-toast proxy-toast--${type}`;
  if (pending) toast.dataset.pending = "1";
  toast.setAttribute("role", "status");

  const msgSpan = document.createElement("span");
  msgSpan.className = "proxy-toast-msg";
  msgSpan.textContent = message;

  const closeBtn = document.createElement("button");
  closeBtn.className = "proxy-toast-close";
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "关闭通知");
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => dismissProxyToast(toast));

  toast.append(msgSpan, closeBtn);
  root.appendChild(toast);

  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => toast.classList.add("is-visible"));
  } else {
    toast.classList.add("is-visible");
  }

  if (duration > 0) {
    toast._timer = setTimeout(() => dismissProxyToast(toast), duration);
  }
  return toast;
}

function formatProxyTestDuration(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(2).replace(/\.?0+$/, "")} s`;
}

function formatProxyTestError(result) {
  const err = result && result.error ? String(result.error).trim() : "";
  const status = result && result.status ? Number(result.status) : 0;
  if (status && err) return `${status} ${err}`;
  if (err) return err;
  if (status) return String(status);
  return "请求失败";
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
    if (!fromBatch) {
      showProxyToast("请先在「来源设定」填写 Models。", {
        type: "fail",
        duration: PROXY_TOAST_FAIL_MS,
      });
    }
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
  if (!fromBatch) {
    state.proxyBusy = true;
    proxyActionButtons().forEach((b) => {
      b.disabled = true;
    });
  }
  updateProxyCardButtonsDisabled();

  const pendingToast = fromBatch
    ? null
    : showProxyToast("正在测试密钥", {
        type: "info",
        duration: 0,
        pending: true,
      });

  const controller = new AbortController();
  const timeoutTimer = setTimeout(
    () => controller.abort(),
    PROXY_TEST_TIMEOUT_MS,
  );
  let result;
  try {
    if (MOCK) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      const provider = (state.proxy?.providers || []).find(
        (item) => item.fp === targetFp,
      );
      const ki = provider
        ? (provider.keys || []).findIndex((k) => String(k.id ?? "") === targetId)
        : -1;
      const rawKey = ki >= 0 ? (provider._mockPlainKeys || [])[ki] : "";
      if (rawKey.includes("bbbb")) {
        const override = mockOverrideForProvider(provider.fp);
        const prev = override.keys.get(rawKey) || {};
        const nextFail = Number(prev.fail_count || 0) + 1;
        const threshold = Number(state.settings?.proxy_fail_threshold || 3);
        const disabled = nextFail >= threshold;
        override.keys.set(rawKey, {
          ...prev,
          disabled,
          fail_count: nextFail,
        });
        result = {
          ok: false,
          status: 401,
          ms: 210,
          model: selectedModel,
          error:
            "Incorrect API key provided: sk-bb**bbbb. You can find your API key at https://platform.example.com/account/api-keys. (request id: req-mock-fail-long-message)",
          fail_count: nextFail,
          disabled,
        };
      } else {
        if (provider) {
          provider.test_model = selectedModel;
          mockOverrideForProvider(provider.fp).test_model = selectedModel;
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
          ms: rawKey.includes("cccc") ? 1450 : 123,
          model: selectedModel,
          fail_count: 0,
          disabled: false,
        };
      }
    } else {
      result = await api("/api/proxy/test", {
        method: "POST",
        auth: true,
        body: { fp, id: Number(targetId), model: selectedModel },
        signal: controller.signal,
      });
    }
  } catch (err) {
    if (err && err.name === "AbortError") {
      result = {
        ok: false,
        status: 0,
        error: "请求超时（20 秒）",
        timedOut: true,
      };
    } else {
      result = { ok: false, status: err.status || 0, error: err.message };
    }
  } finally {
    clearTimeout(timeoutTimer);
    state.proxyTestingKeys.delete(token);
    if (!fromBatch) {
      state.proxyBusy = false;
      dom.proxyProvider.disabled = false;
      renderProxyToolbar();
    }
    updateProxyCardButtonsDisabled();
  }

  if (beforeProvider && result && result.model) {
    beforeProvider.test_model = result.model;
  }
  if (state.settings && typeof result?.settings_version === "number") {
    state.settings.version = result.settings_version;
  }

  if (!fromBatch) {
    if (result && result.ok) {
      showProxyToast(`测试成功 ${formatProxyTestDuration(result.ms)}`, {
        type: "ok",
        duration: PROXY_TOAST_OK_MS,
      });
    } else {
      showProxyToast(`测试失败 ${formatProxyTestError(result)}`, {
        type: "fail",
        duration: PROXY_TOAST_FAIL_MS,
      });
    }
    if (pendingToast) {
      setTimeout(() => dismissProxyToast(pendingToast), PROXY_TOAST_FADE_MS);
    }
  }

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

  if (!fromBatch && ((result && result.disabled) || (result && result.ok && wasDirty))) {
    await loadProxyState();
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
    showProxyToast("请先在「来源设定」填写 Models。", {
      type: "fail",
      duration: PROXY_TOAST_FAIL_MS,
    });
    return;
  }
  const keys = (p.keys || []).filter((k) => {
    if (k.id == null) return false;
    // Only the two scopes the toolbar exposes: healthy keys or disabled keys.
    return mode === "disabled" ? k.disabled : !k.disabled;
  });
  if (!keys.length) {
    showProxyToast("没有符合这个条件的密钥。", {
      type: "info",
      duration: PROXY_TOAST_OK_MS,
    });
    return;
  }

  state.proxyBusy = true;
  proxyActionButtons().forEach((b) => {
    b.disabled = true;
  });
  updateProxyCardButtonsDisabled();

  const pendingToast = showProxyToast(
    mode === "disabled" ? "正在测试无效密钥" : "正在测试有效密钥",
    { type: "info", duration: 0, pending: true },
  );

  let ok = 0;
  let fail = 0;
  try {
    for (let i = 0; i < keys.length; i++) {
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

  await loadProxyState();
  showProxyToast(`测试完成，${ok} 个成功，${fail} 个失败。`, {
    type: fail > 0 ? "fail" : "ok",
    duration: fail > 0 ? PROXY_TOAST_FAIL_MS : PROXY_TOAST_OK_MS,
  });
  if (pendingToast) {
    setTimeout(() => dismissProxyToast(pendingToast), PROXY_TOAST_FADE_MS);
  }
}

async function disableProxyKey(fp, id) {
  if (state.proxyBusy || id == null || id === "") return;
  const targetId = String(id);
  const token = `${fp}:${targetId}`;
  if (state.proxyDisablingKeys.has(token)) return;
  if (!confirm("确定禁用这把密钥？禁用后将不再参与轮用。")) return;

  const currentProvider = selectedProxyProvider();
  state.proxyDisablingKeys.add(token);
  updateProxyCardButtonsDisabled();
  try {
    if (!MOCK) {
      await api("/api/proxy/disable", {
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
        override.keys.set(rawKey, { ...prev, disabled: true });
      }
    }
    await loadProxyState();
  } catch (err) {
    dom.proxyError.textContent = `禁用失败：${err.message}`;
    dom.proxyError.classList.remove("hidden");
  } finally {
    state.proxyDisablingKeys.delete(token);
    updateProxyCardButtonsDisabled();
  }
}

async function recoverProxyKey(fp, id) {
  if (state.proxyBusy || id == null || id === "") return;
  const targetId = String(id);
  const token = `${fp}:${targetId}`;
  if (state.proxyRecoveringKeys.has(token)) return;

  const currentProvider = selectedProxyProvider();
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
    await loadProxyState();
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
  if (!disabledKeys.length) return;
  if (
    !confirm(
      `确定恢复当前供应商下的全部 ${disabledKeys.length} 把失效密钥？恢复后会重新参与轮用。`,
    )
  ) {
    return;
  }

  state.proxyBusy = true;
  proxyActionButtons().forEach((b) => {
    b.disabled = true;
  });
  updateProxyCardButtonsDisabled();

  try {
    if (!MOCK) {
      await api("/api/proxy/recover", {
        method: "POST",
        auth: true,
        body: { fp: currentProvider.fp, all: true },
      });
    } else {
      const override = mockOverrideForProvider(currentProvider.fp);
      (currentProvider.keys || []).forEach((k, ki) => {
        if (!k.disabled || k.id == null) return;
        const rawKey = (currentProvider._mockPlainKeys || [])[ki] || "";
        if (!rawKey) return;
        const prev = override.keys.get(rawKey) || {};
        override.keys.set(rawKey, { ...prev, disabled: false, fail_count: 0 });
      });
    }
  } catch (err) {
    dom.proxyError.textContent = `恢复失败：${err.message}`;
    dom.proxyError.classList.remove("hidden");
    return;
  } finally {
    state.proxyBusy = false;
    dom.proxyProvider.disabled = false;
    renderProxyToolbar();
    updateProxyCardButtonsDisabled();
  }

  await loadProxyState();
}
