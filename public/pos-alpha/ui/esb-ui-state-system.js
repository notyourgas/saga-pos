const STATE_PRESETS = Object.freeze({
  loading: Object.freeze({
    title: "Memuat laporan",
    message: "Data sedang disiapkan. Filter dan pilihan Anda tetap tersimpan.",
    role: "status",
    live: "polite",
    busy: true,
    action: null,
  }),
  error: Object.freeze({
    title: "Laporan gagal dimuat",
    message: "Coba lagi. Jika tetap gagal, periksa koneksi atau ubah periode.",
    role: "alert",
    live: "assertive",
    busy: false,
    action: Object.freeze({ id: "retry", label: "Coba lagi" }),
  }),
  empty: Object.freeze({
    title: "Belum ada hasil",
    message: "Tidak ada data untuk filter ini. Ubah outlet atau periode lalu tampilkan lagi.",
    role: "status",
    live: "polite",
    busy: false,
    action: Object.freeze({ id: "change-filter", label: "Ubah filter" }),
  }),
  locked: Object.freeze({
    title: "Akses laporan terkunci",
    message: "Akun ini belum memiliki izin. Kembali atau minta Owner memeriksa hak akses.",
    role: "status",
    live: "polite",
    busy: false,
    action: Object.freeze({ id: "review-access", label: "Periksa akses" }),
  }),
});

const REPORT_METADATA = Object.freeze([
  ["outlet", "Outlet"],
  ["period", "Periode"],
  ["timeBasis", "Basis waktu"],
  ["includedStatuses", "Status termasuk"],
  ["cutoff", "Cutoff data"],
  ["freshness", "Diperbarui"],
  ["denominator", "Denominator"],
  ["currency", "Mata uang"],
  ["policyVersion", "Versi kebijakan"],
  ["completeness", "Kelengkapan"],
]);

export const UI_STATE_KINDS = Object.freeze(Object.keys(STATE_PRESETS));

export function recoverRequiredMetric({ value, options, defaultValue } = {}) {
  const enabled = normalizeMetricOptions(options).filter((option) => !option.disabled);
  if (!enabled.length) throw new Error("ui_metric_enabled_option_required");
  const current = normalizeText(value);
  const preferred = normalizeText(defaultValue);
  const validCurrent = enabled.find((option) => option.value === current);
  if (validCurrent) return Object.freeze({ value: validCurrent.value, option: validCurrent, recovered: false, reason: null });
  const fallback = enabled.find((option) => option.value === preferred) ?? enabled[0];
  return Object.freeze({
    value: fallback.value,
    option: fallback,
    recovered: true,
    reason: current ? "invalid" : "empty",
  });
}

export function bindRequiredMetricSelect(select, { defaultValue, onRecovered = () => {}, onChange = () => {} } = {}) {
  if (!select?.options) throw new TypeError("ui_metric_select_required");
  select.required = true;
  const reconcile = () => {
    const result = recoverRequiredMetric({
      value: select.value,
      defaultValue,
      options: [...select.options].map((option) => ({ value: option.value, label: option.textContent, disabled: option.disabled })),
    });
    if (result.recovered) {
      select.value = result.value;
      onRecovered(result);
      select.dispatchEvent(new CustomEvent("saga:metric-recovered", { bubbles: true, detail: result }));
    }
    onChange(result);
    return result;
  };
  select.addEventListener("change", reconcile);
  const initial = reconcile();
  return Object.freeze({ reconcile, initial, destroy: () => select.removeEventListener("change", reconcile) });
}

export function createSurfaceState(input = {}) {
  const kind = normalizeText(input.kind);
  const preset = STATE_PRESETS[kind];
  if (!preset) throw new Error("ui_state_kind_invalid");
  const action = input.action === false
    ? null
    : normalizeAction(input.action ?? preset.action);
  return Object.freeze({
    kind,
    title: normalizeText(input.title) || preset.title,
    message: normalizeText(input.message) || preset.message,
    role: preset.role,
    live: preset.live,
    busy: preset.busy,
    action,
  });
}

export function renderSurfaceState(input = {}) {
  const state = createSurfaceState(input);
  const action = state.action
    ? `<button class="saga-state-action" type="button" data-state-action="${escapeHtml(state.action.id)}">${escapeHtml(state.action.label)}</button>`
    : "";
  return `<div class="saga-state-panel saga-state-${state.kind}" data-ui-state="${state.kind}" role="${state.role}" aria-live="${state.live}" aria-atomic="true" aria-busy="${state.busy}">
    <span class="saga-state-mark" aria-hidden="true"></span>
    <div><h3>${escapeHtml(state.title)}</h3><p>${escapeHtml(state.message)}</p>${action}</div>
  </div>`;
}

export function createUnsavedChangesGuard({ targetWindow = globalThis.window } = {}) {
  let dirty = false;
  let installed = false;
  const beforeUnload = (event) => {
    if (!dirty) return undefined;
    event.preventDefault();
    event.returnValue = "";
    return "";
  };
  return Object.freeze({
    isDirty: () => dirty,
    markDirty: () => { dirty = true; },
    markSaved: () => { dirty = false; },
    install() {
      if (!installed && targetWindow?.addEventListener) {
        targetWindow.addEventListener("beforeunload", beforeUnload);
        installed = true;
      }
    },
    destroy() {
      if (installed && targetWindow?.removeEventListener) targetWindow.removeEventListener("beforeunload", beforeUnload);
      installed = false;
      dirty = false;
    },
    handleBeforeUnload: beforeUnload,
  });
}

export function bindUnsavedForm(form, guard) {
  if (!form?.addEventListener || !guard) throw new TypeError("ui_unsaved_form_and_guard_required");
  const markDirty = () => guard.markDirty();
  form.addEventListener("input", markDirty);
  form.addEventListener("change", markDirty);
  form.addEventListener("reset", guard.markSaved);
  return Object.freeze({
    destroy() {
      form.removeEventListener("input", markDirty);
      form.removeEventListener("change", markDirty);
      form.removeEventListener("reset", guard.markSaved);
    },
  });
}

export function bindAccessibleDialog(dialog, { initialFocusSelector, onCancel } = {}) {
  if (!dialog?.addEventListener) throw new TypeError("ui_dialog_required");
  let returnFocus = null;
  const restoreFocus = () => {
    const target = returnFocus;
    returnFocus = null;
    if (target?.isConnected && typeof target.focus === "function") target.focus();
  };
  const onCancelEvent = (event) => {
    event.preventDefault();
    if (onCancel?.() !== true) controller.close();
  };
  dialog.addEventListener("cancel", onCancelEvent);
  dialog.addEventListener("close", restoreFocus);
  const controller = Object.freeze({
    open(trigger) {
      returnFocus = trigger ?? dialog.ownerDocument?.activeElement ?? null;
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      queueMicrotask(() => {
        const target = initialFocusSelector ? dialog.querySelector(initialFocusSelector) : dialog.querySelector("button, input, select, textarea, [tabindex]:not([tabindex='-1'])");
        target?.focus();
      });
    },
    close(value = "") {
      if (typeof dialog.close === "function" && dialog.open) dialog.close(value);
      else {
        dialog.removeAttribute("open");
        restoreFocus();
      }
    },
    destroy() {
      dialog.removeEventListener("cancel", onCancelEvent);
      dialog.removeEventListener("close", restoreFocus);
      returnFocus = null;
    },
  });
  return controller;
}

export function bindUnsavedChangesDialog({ dialog, guard, discardButton, stayButton, initialFocusSelector = "[data-stay]" } = {}) {
  if (!guard || !discardButton || !stayButton) throw new TypeError("ui_unsaved_dialog_controls_required");
  let pending = null;
  const settle = (confirmed) => {
    const current = pending;
    pending = null;
    if (confirmed) guard.markSaved();
    dialogController.close(confirmed ? "discard" : "stay");
    if (confirmed) current?.navigate?.();
    current?.resolve(confirmed);
  };
  const dialogController = bindAccessibleDialog(dialog, { initialFocusSelector, onCancel: () => { settle(false); return true; } });
  const discard = () => settle(true);
  const stay = () => settle(false);
  discardButton.addEventListener("click", discard);
  stayButton.addEventListener("click", stay);
  return Object.freeze({
    request({ trigger, navigate } = {}) {
      if (!guard.isDirty()) {
        navigate?.();
        return Promise.resolve(true);
      }
      if (pending) return pending.promise;
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      pending = { promise, resolve, navigate };
      dialogController.open(trigger);
      return promise;
    },
    destroy() {
      discardButton.removeEventListener("click", discard);
      stayButton.removeEventListener("click", stay);
      dialogController.destroy();
      pending?.resolve(false);
      pending = null;
    },
  });
}

export function renderSemanticTable({ caption, columns, rows } = {}) {
  const normalizedColumns = normalizeColumns(columns);
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const head = normalizedColumns.map((column) => `<th scope="col">${escapeHtml(column.label)}</th>`).join("");
  const body = normalizedRows.map((row) => `<tr>${normalizedColumns.map((column, index) => {
    const value = formatCell(row?.[column.key]);
    return index === 0 ? `<th scope="row">${escapeHtml(value)}</th>` : `<td>${escapeHtml(value)}</td>`;
  }).join("")}</tr>`).join("");
  return `<div class="saga-report-table-region" role="region" aria-label="${escapeHtml(caption || "Data laporan")}" tabindex="0">
    <table><caption>${escapeHtml(caption || "Data laporan")}</caption><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
  </div>`;
}

export function renderReportShell(input = {}) {
  const id = safeId(input.id || "saga-report");
  const title = normalizeText(input.title) || "Laporan";
  const description = normalizeText(input.description) || "Ringkasan operasional";
  const metadata = normalizeReportMetadata(input.metadata);
  const state = input.state ? createSurfaceState(input.state) : null;
  const metric = normalizeMetricConfig(input.metric);
  const points = normalizePoints(input.points);
  const max = Math.max(1, ...points.map((point) => point.numericValue));
  const bars = points.map((point) => `<li><span>${escapeHtml(point.label)}</span><span class="saga-report-bar-track" aria-hidden="true"><span style="--saga-bar-size:${Math.max(0, Math.min(100, point.numericValue / max * 100)).toFixed(2)}%"></span></span><strong>${escapeHtml(point.formattedValue)}</strong></li>`).join("");
  const options = metric.options.map((option) => `<option value="${escapeHtml(option.value)}"${option.value === metric.value ? " selected" : ""}${option.disabled ? " disabled" : ""}>${escapeHtml(option.label)}</option>`).join("");
  const metadataHtml = REPORT_METADATA.map(([key, label]) => `<div><dt>${label}</dt><dd>${escapeHtml(metadata[key])}</dd></div>`).join("");
  const stateHtml = state ? renderSurfaceState(state) : "";
  const reportContent = state ? "" : `<figure class="saga-report-chart" aria-labelledby="${id}-chart-title"><figcaption id="${id}-chart-title">${escapeHtml(input.chartLabel || `${title} berdasarkan ${metric.label}`)}</figcaption><ul>${bars}</ul></figure>
    <details class="saga-report-table-alternative" open><summary>Lihat data sebagai tabel</summary>${renderSemanticTable({ caption: input.tableCaption || `${title} — ${metric.label}`, columns: input.columns, rows: input.rows })}</details>`;
  return `<section class="saga-ui-system saga-report-shell" aria-labelledby="${id}-title" data-report-shell="${id}">
    <header><div><p class="saga-report-eyebrow">Laporan Owner</p><h2 id="${id}-title">${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div>
      <label class="saga-report-metric" for="${id}-metric"><span>Metrik wajib</span><select id="${id}-metric" data-required-metric required>${options}</select></label>
    </header>
    <dl class="saga-report-metadata">${metadataHtml}</dl>
    <div class="saga-report-content" aria-busy="${state?.busy ?? false}">${stateHtml}${reportContent}</div>
  </section>`;
}

export function mountReportShell(root, input = {}, { onStateAction = () => {}, onMetricRecovered = () => {} } = {}) {
  if (!root?.addEventListener) throw new TypeError("ui_report_root_required");
  let config = { ...input };
  let metricBinding = null;
  const onAction = (event) => {
    const action = event.target.closest?.("[data-state-action]");
    if (action && root.contains(action)) onStateAction(action.dataset.stateAction, action);
  };
  root.addEventListener("click", onAction);
  const render = () => {
    metricBinding?.destroy();
    root.innerHTML = renderReportShell(config);
    const select = root.querySelector("[data-required-metric]");
    metricBinding = bindRequiredMetricSelect(select, {
      defaultValue: config.metric?.defaultValue,
      onRecovered: onMetricRecovered,
      onChange(result) { config = { ...config, metric: { ...config.metric, value: result.value } }; },
    });
  };
  render();
  return Object.freeze({
    update(next) { config = { ...config, ...next }; render(); },
    destroy() { metricBinding?.destroy(); root.removeEventListener("click", onAction); root.replaceChildren(); },
  });
}

function normalizeMetricOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.map((option) => {
    if (typeof option === "string") return Object.freeze({ value: normalizeText(option), label: normalizeText(option), disabled: false });
    return Object.freeze({ value: normalizeText(option?.value), label: normalizeText(option?.label) || normalizeText(option?.value), disabled: option?.disabled === true });
  }).filter((option) => option.value);
}

function normalizeMetricConfig(metric = {}) {
  const options = normalizeMetricOptions(metric.options);
  const recovered = recoverRequiredMetric({ value: metric.value, options, defaultValue: metric.defaultValue });
  return Object.freeze({ options, value: recovered.value, label: recovered.option.label });
}

function normalizeAction(action) {
  if (!action) return null;
  const id = normalizeText(action.id);
  const label = normalizeText(action.label);
  if (!id || !label) throw new Error("ui_state_action_invalid");
  return Object.freeze({ id, label });
}

function normalizeColumns(columns) {
  if (!Array.isArray(columns) || columns.length < 2) throw new Error("ui_report_columns_invalid");
  return columns.map((column) => {
    const key = normalizeText(column?.key);
    const label = normalizeText(column?.label);
    if (!key || !label) throw new Error("ui_report_column_invalid");
    return Object.freeze({ key, label });
  });
}

function normalizePoints(points) {
  if (!Array.isArray(points) || !points.length) throw new Error("ui_report_points_required");
  return points.map((point) => {
    const numericValue = Number(point?.value);
    if (!Number.isFinite(numericValue) || numericValue < 0) throw new Error("ui_report_point_value_invalid");
    return Object.freeze({
      label: normalizeText(point?.label) || "Tanpa label",
      numericValue,
      formattedValue: normalizeText(point?.formattedValue) || String(numericValue),
    });
  });
}

function normalizeReportMetadata(metadata = {}) {
  return Object.fromEntries(REPORT_METADATA.map(([key]) => [key, normalizeText(metadata?.[key]) || "Belum ditetapkan"]));
}

function formatCell(value) {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function normalizeText(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function safeId(value) {
  const id = normalizeText(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return id || "saga-report";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" })[character]);
}
