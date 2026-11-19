// Split from the original app.js; loaded in original order (see index.html).
// ── Events ────────────────────────────────────────────────────────────────
function bindEvents() {
  initCustomSelects();
  initInfoTooltips();
  // Auth
  dom.authBtn.addEventListener("click", login);
  dom.authInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") login();
  });
  dom.logoutBtn.addEventListener("click", logout);

  // Topbar mobile menu
  dom.mobileMenuBtn.addEventListener("click", () => toggleMobileMenu());
  dom.mobileMenuClose?.addEventListener("click", () => toggleMobileMenu(false));
  dom.topbarMenuBackdrop?.addEventListener("click", () =>
    toggleMobileMenu(false),
  );

  // Theme
  dom.themeToggle.addEventListener("click", () => {
    toggleTheme();
    toggleMobileMenu(false);
  });

  // Tabs
  dom.tabBtns.forEach((b) =>
    b.addEventListener("click", () => switchTab(b.dataset.tab)),
  );

  // Line numbers
  bindLineNums(dom.edKeys);
  bindLineNums(dom.edModels);
  bindLineNums(dom.edExtraBody);
  bindKeysHighlight();

  // Normalize editor fields on blur so displayed formatting updates when leaving
  // the field, while Save focuses on validation and submission.
  dom.edApiBase.addEventListener("blur", () => {
    const normalized = dom.edApiBase.value.trim().replace(/\/+$/, "");
    if (dom.edApiBase.value !== normalized) dom.edApiBase.value = normalized;
  });
  dom.edAlias.addEventListener("blur", () => {
    const normalized = dom.edAlias.value.trim();
    if (dom.edAlias.value !== normalized) dom.edAlias.value = normalized;
  });
  dom.edKeys.addEventListener("blur", () => {
    const normalized = normalizeKeys(dom.edKeys.value);
    if (dom.edKeys.value !== normalized) {
      dom.edKeys.value = normalized;
      syncLineNums(dom.edKeys);
      syncKeysHighlight();
    }
  });
  dom.edModels.addEventListener("blur", () => {
    const normalized = normalizeModels(dom.edModels.value);
    if (dom.edModels.value !== normalized) {
      dom.edModels.value = normalized;
      syncLineNums(dom.edModels);
    }
  });

  // Extra Body JSON live validation
  dom.edExtraBody.addEventListener("input", () => {
    const val = dom.edExtraBody.value.trim();
    if (!val) {
      dom.edExtraBodyStatus.textContent = "";
      dom.edExtraBodyStatus.className = "json-status";
      return;
    }
    try {
      JSON.parse(val);
      dom.edExtraBodyStatus.textContent = "✓ 有效";
      dom.edExtraBodyStatus.className = "json-status json-ok";
    } catch {
      dom.edExtraBodyStatus.textContent = "✗ 格式错误";
      dom.edExtraBodyStatus.className = "json-status json-err";
    }
  });

  // Config
  dom.addProviderBtn.addEventListener("click", () => openEditor());
  dom.bulkEnableBtn.addEventListener("click", () => bulkToggle(true));
  dom.bulkDisableBtn.addEventListener("click", () => bulkToggle(false));
  dom.providerGrid.addEventListener("click", (e) => {
    const editBtn = e.target.closest("[data-edit]");
    if (editBtn) return openEditor(Number(editBtn.dataset.edit));
    const delBtn = e.target.closest("[data-delete]");
    if (delBtn) return deleteProvider(Number(delBtn.dataset.delete));
  });
  dom.providerGrid.addEventListener("change", (e) => {
    const box = e.target.closest("[data-select]");
    if (box) toggleSelection(Number(box.dataset.select));
  });
  dom.edAddHeaderBtn.addEventListener("click", () => {
    const row = createHeaderRow();
    dom.edHeadersContainer.appendChild(row);
    row.querySelector("[data-header-key]")?.focus();
  });
  dom.editorSave.addEventListener("click", () => saveEditor());
  dom.editorCancel.addEventListener("click", closeEditor);

  // Key tools: three-state sort, export, footer delete confirmation. Finding a key
  // is the orange occurrence highlight in the textarea, bound in bindKeysHighlight.
  dom.edSortKeysBtn.addEventListener("click", cycleEditorSort);
  dom.edExportKeysBtn.addEventListener("click", exportEditorKeys);
  dom.edKeys.addEventListener("input", () => {
    if (
      state.editorPendingRemoved &&
      diffKeyLines(state.editorSnapshot ?? "", dom.edKeys.value).length === 0
    ) {
      hideEditorConfirm();
    }
  });
  dom.editorOverlay.addEventListener("click", (e) => {
    if (e.target.dataset.closeModal === "editor") closeEditor();
  });

  // Proxy tab
  dom.proxyProvider.addEventListener("change", () => {
    state.proxySelected = dom.proxyProvider.value;
    state.proxyPage = 1;
    clearProxyNotice({ keepGlobal: true });
    renderProxyToolbar();
    renderProxyKeyCards();
  });
  dom.proxyUrlCopy.innerHTML = COPY_ICON_SVG;
  dom.proxyUrlCopy.addEventListener("click", () => {
    const url = dom.proxyUrlCopy.dataset.copyVal || "";
    if (url) copyText(url, dom.proxyUrlCopy);
  });
  dom.proxyTestActive.addEventListener("click", () => runProxyBatch("active"));
  dom.proxyTestDisabled.addEventListener("click", () => runProxyBatch("disabled"));
  dom.proxyRecoverAll.addEventListener("click", recoverAllProxyKeys);
  dom.proxyKeyGrid.addEventListener("click", (e) => {
    const copyBtn = e.target.closest(".copy-btn");
    if (copyBtn) {
      return copyText(copyBtn.dataset.copyVal || "", copyBtn);
    }
    if (state.proxyBusy) return;
    const testBtn = e.target.closest("[data-proxy-test]");
    if (testBtn) {
      return testProxyKey(testBtn.dataset.fp, testBtn.dataset.proxyTest);
    }
    const disableBtn = e.target.closest("[data-proxy-disable]");
    if (disableBtn) {
      return disableProxyKey(
        disableBtn.dataset.fp,
        disableBtn.dataset.proxyDisable,
      );
    }
    const recoverBtn = e.target.closest("[data-proxy-recover]");
    if (recoverBtn) {
      return recoverProxyKey(
        recoverBtn.dataset.fp,
        recoverBtn.dataset.proxyRecover,
      );
    }
  });

  // Result body delegated scroll (capture phase — scroll doesn't bubble from textarea)
  dom.resultsBody.addEventListener(
    "scroll",
    (e) => {
      if (
        e.target.tagName === "TEXTAREA" &&
        e.target.closest(".result-lined-editor")
      ) {
        syncLineNums(e.target);
      }
    },
    true,
  );

  // Result group open & performance table sorting — delegated
  const toggleResultGroupHeader = (header) => {
    const g = header.closest(".result-group");
    if (!g) return;
    const open = g.classList.toggle("open");
    header.setAttribute("aria-expanded", String(open));
  };
  const toggleInvGroupHeader = (invHeader) => {
    const g = invHeader.closest(".inv-group");
    if (!g) return;
    const open = g.classList.toggle("open");
    invHeader.setAttribute("aria-expanded", String(open));
  };

  dom.resultsBody.addEventListener("click", (e) => {
    const header = e.target.closest(".result-group-header");
    if (header) {
      toggleResultGroupHeader(header);
      return;
    }

    const invHeader = e.target.closest(".inv-group-header");
    if (invHeader && !e.target.closest("button")) {
      toggleInvGroupHeader(invHeader);
      return;
    }

    const sortTh = e.target.closest("th[data-sort]");
    if (sortTh) {
      e.stopPropagation();
      const table = sortTh.closest("table");
      const tbody = table.querySelector("tbody");
      const col = sortTh.dataset.sort;
      const currentDir = sortTh.dataset.sortDir || "";
      const newDir = currentDir === "asc" ? "desc" : "asc";

      table.querySelectorAll("th[data-sort]").forEach((th) => {
        delete th.dataset.sortDir;
        const indicator = th.querySelector(".sort-indicator");
        if (indicator) indicator.textContent = "";
      });

      sortTh.dataset.sortDir = newDir;
      const indicator = sortTh.querySelector(".sort-indicator");
      if (indicator) indicator.textContent = newDir === "asc" ? "▲" : "▼";

      const rowsArr = Array.from(tbody.querySelectorAll("tr"));
      const colIndex = Array.from(table.querySelectorAll("thead th")).indexOf(
        sortTh,
      );

      const isModel = col === "model";
      const pairs = rowsArr.map((row) => {
        const cell = row.children[colIndex];
        const raw =
          cell.dataset.value !== undefined
            ? cell.dataset.value
            : cell.textContent.trim();
        if (isModel) {
          return { row, val: raw, missing: raw === "" };
        }
        const parsed = raw === "" ? NaN : parseFloat(raw);
        return { row, val: parsed, missing: !Number.isFinite(parsed) };
      });

      pairs.sort((a, b) => {
        if (a.missing !== b.missing) return a.missing ? 1 : -1;
        if (isModel) {
          const cmp = a.val.localeCompare(b.val);
          return newDir === "asc" ? cmp : -cmp;
        }
        if (a.val < b.val) return newDir === "asc" ? -1 : 1;
        if (a.val > b.val) return newDir === "asc" ? 1 : -1;
        return 0;
      });

      const frag = document.createDocumentFragment();
      pairs.forEach((p) => frag.appendChild(p.row));
      tbody.appendChild(frag);
      return;
    }

    const copyBtn = e.target.closest(".copy-btn");
    if (copyBtn) {
      copyText(copyBtn.dataset.copyVal || "", copyBtn);
      return;
    }

    const sampleBtn = e.target.closest("[data-sample]");
    if (sampleBtn) {
      try {
        const payload = JSON.parse(sampleBtn.dataset.sample);
        openSample(payload.model, payload.sample);
      } catch {}
      return;
    }

    const errBtn = e.target.closest("[data-errdetail]");
    if (errBtn) {
      e.stopPropagation();
      try {
        const payload = JSON.parse(errBtn.dataset.errdetail);
        openErrorDetail(payload.error_code, payload.error_detail);
      } catch {}
    }
  });

  dom.resultsBody.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (e.target.closest("button, input, textarea, select, a")) return;
    const header = e.target.closest(".result-group-header");
    if (header) {
      e.preventDefault();
      toggleResultGroupHeader(header);
      return;
    }
    const invHeader = e.target.closest(".inv-group-header");
    if (invHeader) {
      e.preventDefault();
      toggleInvGroupHeader(invHeader);
    }
  });

  // Dead keys tab
  dom.dkBulkDelBtn.addEventListener("click", onDkBulkDelClick);
  [dom.dkFHost, dom.dkFCode].forEach((el) =>
    el.addEventListener("change", renderDeadKeys),
  );
  bindDateFilterInput(dom.dkFFrom);
  bindDateFilterInput(dom.dkFTo);
  dom.dkFKey.addEventListener("input", renderDeadKeys);
  dom.dkFReset.addEventListener("click", () => {
    dom.dkFHost.value = "";
    dom.dkFKey.value = "";
    dom.dkFCode.value = "";
    syncCustomSelect(dom.dkFHost);
    syncCustomSelect(dom.dkFCode);
    resetDateFilterInput(dom.dkFFrom);
    resetDateFilterInput(dom.dkFTo);
    renderDeadKeys();
  });
  dom.dkTableWrap.addEventListener("click", (e) => {
    const sortTh = e.target.closest("th[data-sort]");
    if (sortTh) {
      const col = sortTh.dataset.sort;
      if (state.dkSort.col === col) {
        state.dkSort.dir = state.dkSort.dir === "asc" ? "desc" : "asc";
      } else {
        state.dkSort.col = col;
        state.dkSort.dir = "asc";
      }
      renderDeadKeys();
      return;
    }
    const copyBtn = e.target.closest(".copy-btn");
    if (copyBtn) return copyText(copyBtn.dataset.copyVal || "", copyBtn);

    const detailBtn = e.target.closest("[data-dk-detail]");
    if (detailBtn) {
      const rec = state.deadKeys.find(
        (r) => r && r.id === detailBtn.dataset.dkDetail,
      );
      if (rec)
        openErrorDetail(
          rec.error_code,
          detailFor(rec),
          dkProviderLabel(rec),
        );
      return;
    }
  });
  dom.dkTableWrap.addEventListener("change", onDkCheckChange);

  // Dead key bulk-delete confirm
  dom.dkConfirmOk.addEventListener("click", confirmDeleteDeadKeys);
  dom.dkConfirmCancel.addEventListener("click", closeDkConfirm);
  dom.dkConfirmOverlay.addEventListener("click", (e) => {
    if (e.target.dataset.closeModal === "dkconfirm") closeDkConfirm();
  });

  // Error detail modal
  dom.errDetailClose.addEventListener("click", closeErrorDetail);
  dom.errDetailOverlay.addEventListener("click", (e) => {
    if (e.target.dataset.closeModal === "errdetail") closeErrorDetail();
  });

  // Settings modal
  dom.settingsBtn.addEventListener("click", () => {
    openSettings();
    toggleMobileMenu(false);
  });
  dom.settingsCancel.addEventListener("click", closeSettings);
  dom.settingsSave.addEventListener("click", saveSettings);
  dom.testDiscordBtn.addEventListener("click", testDiscordWebhook);
  for (const field of settingsSecretFields()) {
    setSecretVisibility(field, false);
    if (field.copy) field.copy.innerHTML = COPY_ICON_SVG;
    syncSecretCopyState(field);
    field.toggle?.addEventListener("mousedown", (e) => e.preventDefault());
    field.toggle?.addEventListener("click", () => {
      setSecretVisibility(field, field.input.type === "password");
    });
    field.copy?.addEventListener("click", () => {
      const val = field.input?.value.trim() || "";
      if (val) {
        copyText(val, field.copy, {
          shouldDisable: () => !(field.input?.value.trim()),
        });
      }
    });
    field.input?.addEventListener("input", () => syncSecretCopyState(field));
  }
  dom.settingsOverlay.addEventListener("click", (e) => {
    if (e.target.dataset.closeModal === "settings") closeSettings();
  });

  // Sample modal
  dom.sampleClose.addEventListener("click", closeSample);
  dom.sampleOverlay.addEventListener("click", (e) => {
    if (e.target.dataset.closeModal === "sample") closeSample();
  });

  // Global modal keyboard handling: Esc closes topmost modal; Tab stays trapped inside
  const MODAL_CLOSE_MAP = new Map([
    [dom.editorOverlay, closeEditor],
    [dom.settingsOverlay, closeSettings],
    [dom.sampleOverlay, closeSample],
    [dom.dkConfirmOverlay, closeDkConfirm],
    [dom.errDetailOverlay, closeErrorDetail],
  ]);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && activeCustomSelect) {
      e.preventDefault();
      closeOpenCustomSelect({ restoreFocus: true });
      return;
    }
    const activeOverlay = topOpenModal();
    if (!activeOverlay) return;
    if (e.key === "Escape") {
      const closeFn = MODAL_CLOSE_MAP.get(activeOverlay);
      if (closeFn) closeFn();
      return;
    }
    if (e.key === "Tab") {
      const items = modalFocusableElements(activeOverlay);
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first || !activeOverlay.contains(document.activeElement)) {
          e.preventDefault();
          last.focus();
        }
      } else if (document.activeElement === last || !activeOverlay.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      }
    }
  });
}

// ── Init ──────────────────────────────────────────────────────────────────
async function initApp() {
  // Apply current theme icon
  applyTheme(getTheme());
  // Load config tab (default)
  await loadConfig();
}

async function bootstrap() {
  bindEvents();
  applyTheme(getTheme());

  if (MOCK) {
    // Skip auth in mock mode
    state.signedIn = true;
    dom.authOverlay.classList.remove("active");
    document.documentElement.classList.remove("has-token");
    await initApp();
    return;
  }

  if (localStorage.getItem(SIGNED_IN_HINT) !== "1") {
    document.documentElement.classList.remove("has-token");
    return;
  }

  // The hint says there was a session; only the server knows if the cookie is
  // still valid, so probe it. A 401 here is handled by api() → sessionEnded().
  try {
    const probe = await api("/api/settings", { auth: true });
    applyFetchedSettings(probe);
    markSignedIn();
    dom.authOverlay.classList.remove("active");
    await initApp();
  } catch (err) {
    // Also covers a network failure, where sessionEnded() has not run yet — the
    // pre-paint hider must come off either way or the page stays blank.
    sessionEnded();
    dom.authError.textContent =
      err.message === "Unauthorized"
        ? "登入已过期，请重新输入密码"
        : `连线失败：${err.message}`;
  }
}

bootstrap();
