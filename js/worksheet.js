"use strict";

import { supabase } from "./supabase.js";
import { currentUser, tasksFor, toast, escapeHtml } from "./common.js";
import { loadData } from "./data.js";
import { uploadFiles, MAX_FILE_MB } from "./storage.js";
import { emailProjectManager } from "./notify.js";

/* ============================================================
   worksheet.js — the employee "Daily Worksheet" tab
   Sections: 01 Work Information · 02 Working Time ·
             03 Project Files · 04 Remarks
   On submit the worksheet is saved to the `worksheets` table
   (files go to the `worksheet-files` storage bucket), and the
   admin can read it under the Worksheets tab.
   ============================================================ */

let built = false;
let pendingFiles = [];

/* ---------- helpers ---------- */
function localDate(d = new Date()) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function prettyDate(d = new Date()) {
    return d.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
    });
}

function minutesBetween(start, end) {
    if (!start || !end) return null;

    const [sh, sm] = start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);

    const startMins = sh * 60 + sm;
    const endMins = eh * 60 + em;

    let total = endMins - startMins;

    if (total <= 0) return null;

    // Lunch break: 1:00 PM - 2:00 PM
    const lunchStart = 13 * 60;
    const lunchEnd = 14 * 60;

    const overlap =
        Math.max(
            0,
            Math.min(endMins, lunchEnd) -
            Math.max(startMins, lunchStart)
        );

    total -= overlap;

    return total;
}

function formatDuration(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h && m) return `${h} hr ${m} min`;
    if (h) return `${h} hr`;
    return `${m} min`;
}

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const $ = (id) => document.getElementById(id);

/* ---------- markup ---------- */
function projectOptionsHtml(selected = "") {
    const u = currentUser();
    const tasks = tasksFor(u.id).filter((t) => t.status !== "done");

    return (
        `<option value="" disabled ${selected ? "" : "selected"}>Select Project</option>` +
        tasks
            .map(
                (t) =>
                    `<option value="${escapeHtml(String(t.id))}" ${String(t.id) === selected ? "selected" : ""}>${escapeHtml(t.title)}</option>`,
            )
            .join("") +
        `<option value="__other" ${selected === "__other" ? "selected" : ""}>Other / General work</option>`
    );
}

function formHtml() {
    return `
    <div class="ws-page">

      <div class="ws-header">
        <div>
          <h2>Add Today's Work</h2>
          <p>Enter the details of the work you completed today.</p>
        </div>
        <div class="ws-today">
          <span>Today's Date</span>
          <b id="ws-today-label">${prettyDate()}</b>
        </div>
      </div>

      <!-- 01 -->
      <section class="ws-card">
        <div class="ws-card-head">
          <div class="ws-num">01</div>
          <div><h3>Work Information</h3><p>Tell us what you worked on.</p></div>
        </div>
        <div class="row-2">
          <div class="field">
            <label for="ws-date">Date</label>
            <input type="date" id="ws-date" value="${localDate()}" max="${localDate()}" />
          </div>
          <div class="field">
            <label for="ws-project">Project</label>
            <select id="ws-project">${projectOptionsHtml()}</select>
          </div>
        </div>
        <div class="field">
          <label for="ws-title">Work Title</label>
          <input type="text" id="ws-title" placeholder="Example: Completed motor testing" />
        </div>
        <div class="field">
          <label for="ws-desc">Work Description</label>
          <textarea id="ws-desc" placeholder="Describe what you worked on, what you completed, problems faced, etc."></textarea>
        </div>
      </section>

      <!-- 02 -->
      <section class="ws-card">
        <div class="ws-card-head">
          <div class="ws-num">02</div>
          <div><h3>Working Time</h3><p>Enter your working hours.</p></div>
        </div>
        <div class="row-2">
          <div class="field">
            <label for="ws-start">Start Time</label>
            <input type="time" id="ws-start" value="09:30"/>
          </div>
          <div class="field">
            <label for="ws-end">End Time</label>
            <input type="time" id="ws-end" value="18:30"/>
          </div>
        </div>
        <div class="row-2">
          <div class="field">
            <label for="ws-total">Total Hours</label>
            <input type="text" id="ws-total" class="ws-readonly" placeholder="Automatically calculated" readonly />
          </div>
          <div class="field">
            <label for="ws-status">Work Status</label>
            <select id="ws-status">
              <option value="" disabled selected>Select Status</option>
              <option value="completed">Completed</option>
              <option value="in-progress">In Progress</option>
              <option value="pending">Pending</option>
              <option value="blocked">Blocked</option>
            </select>
          </div>
        </div>
        <div class="field hidden" id="ws-progress-wrap">
          <label for="ws-progress">Project Progress</label>
          <div class="slider-row">
            <input type="range" min="0" max="100" step="5" id="ws-progress" value="0" />
            <div class="pct" id="ws-progress-pct">0%</div>
          </div>
          <span class="hint">Updates the selected project's progress, so your admin and project manager see it too.</span>
        </div>
      </section>

      <!-- 03 -->
      <section class="ws-card">
        <div class="ws-card-head">
          <div class="ws-num">03</div>
          <div><h3>Project Files</h3><p>Upload photos, documents or project files.</p></div>
        </div>
        <div class="ws-dropzone" id="ws-dropzone">
          <input type="file" id="ws-file-input" class="hidden" multiple />
          <div class="ws-drop-icon">📁</div>
          <b>Upload your work</b>
          <span>Select files from your computer (max ${MAX_FILE_MB} MB each)</span>
          <button type="button" class="btn btn-lime btn-sm" id="ws-choose-files">Choose Files</button>
        </div>
        <div class="ws-file-list" id="ws-file-list"></div>
      </section>

      <!-- 04 -->
      <section class="ws-card">
        <div class="ws-card-head">
          <div class="ws-num">04</div>
          <div><h3>Remarks</h3><p>Add any additional information.</p></div>
        </div>
        <div class="field">
          <label for="ws-remarks">Remarks</label>
          <textarea id="ws-remarks" placeholder="Any additional notes..."></textarea>
        </div>
      </section>

      <p class="error-text" id="ws-error"></p>

      <div class="ws-actions">
        <button type="button" class="btn btn-ghost" id="ws-reset">Clear</button>
        <button type="button" class="btn btn-lime" id="ws-submit">Submit Worksheet</button>
      </div>

    </div>`;
}

/* ---------- files ---------- */
function renderFileList() {
    const el = $("ws-file-list");
    el.innerHTML = pendingFiles
        .map(
            (f, i) => `<div class="ws-file-chip">
        <span class="ws-file-name">📎 ${escapeHtml(f.name)}</span>
        <span class="ws-file-size">${formatSize(f.size)}</span>
        <button type="button" class="ws-file-remove" data-i="${i}" title="Remove">✕</button>
      </div>`,
        )
        .join("");

    el.querySelectorAll(".ws-file-remove").forEach((b) =>
        b.addEventListener("click", () => {
            pendingFiles.splice(Number(b.dataset.i), 1);
            renderFileList();
        }),
    );
}

function addFiles(fileList) {
    for (const f of fileList) {
        if (f.size > MAX_FILE_MB * 1024 * 1024) {
            toast(`${f.name} is larger than ${MAX_FILE_MB} MB.`, "error");
            continue;
        }
        const dup = pendingFiles.some((p) => p.name === f.name && p.size === f.size);
        if (!dup) pendingFiles.push(f);
    }
    renderFileList();
}

/* ---------- task progress ---------- */
function taskById(val) {
    if (!val || val === "__other") return null;
    return tasksFor(currentUser().id).find((t) => String(t.id) === val) || null;
}

function syncProgress() {
    const task = taskById($("ws-project").value);
    $("ws-progress-wrap").classList.toggle("hidden", !task);
    if (task) {
        const p = task.progress ?? 0;
        $("ws-progress").value = p;
        $("ws-progress-pct").textContent = `${p}%`;
    }
}

/* ---------- total hours ---------- */
function updateTotal() {
    const mins = minutesBetween($("ws-start").value, $("ws-end").value);
    $("ws-total").value = mins ? formatDuration(mins) : "";
}

/* ---------- reset ---------- */
function resetForm() {
    $("ws-date").value = localDate();
    $("ws-project").innerHTML = projectOptionsHtml();
    $("ws-title").value = "";
    $("ws-desc").value = "";
    $("ws-start").value = "";
    $("ws-end").value = "";
    $("ws-total").value = "";
    $("ws-status").value = "";
    $("ws-remarks").value = "";
    $("ws-progress-wrap").classList.add("hidden");
    $("ws-file-input").value = "";
    $("ws-error").textContent = "";
    pendingFiles = [];
    renderFileList();
}

/* ---------- submit ---------- */
async function submitWorksheet() {
    const u = currentUser();
    const errEl = $("ws-error");
    errEl.textContent = "";

    const workDate = $("ws-date").value;
    const projectVal = $("ws-project").value;
    const workTitle = $("ws-title").value.trim();
    const description = $("ws-desc").value.trim();
    const start = $("ws-start").value;
    const end = $("ws-end").value;
    const status = $("ws-status").value;
    const remarks = $("ws-remarks").value.trim();

    if (!workDate) return (errEl.textContent = "Please choose a date.");
    if (!projectVal) return (errEl.textContent = "Please select a project.");
    if (!workTitle) return (errEl.textContent = "Please enter a work title.");
    if (!description) return (errEl.textContent = "Please describe the work you did.");
    if (!start || !end) return (errEl.textContent = "Please enter your start and end time.");

    const mins = minutesBetween(start, end);
    if (!mins) return (errEl.textContent = "End time must be later than start time.");
    if (!status) return (errEl.textContent = "Please select a work status.");

    const task = taskById(projectVal);
    const progress = task ? parseInt($("ws-progress").value, 10) : null;

    if (task && progress === (task.progress ?? 0)) {
        return (errEl.textContent =
            "Project progress has not changed. Please update the progress before submitting.");
    }

    if (task) {
        const progress = parseInt($("ws-progress").value, 10);

        if (status === "completed" && progress < 100) {
            return (errEl.textContent =
                "Work status cannot be Completed unless project progress is 100%.");
        }
    }

    const btn = $("ws-submit");
    btn.disabled = true;
    btn.textContent = "Submitting…";

    try {
        const files = await uploadFiles(pendingFiles, `worksheets/${u.id}`);

        files.forEach((file) => {
            file.uploadedAt = new Date().toISOString();
            file.uploadedBy = { id: u.id, name: u.name, role: u.role };
        });

        const { error } = await supabase.from("worksheets").insert({
            user_id: u.id,
            user_name: u.name,
            work_date: workDate,
            task_id: task ? String(task.id) : null,
            project_title: task ? task.title : "Other / General work",
            project_manager_id: task?.projectManagerId || null,
            work_title: workTitle,
            description,
            start_time: start,
            end_time: end,
            total_hours: Math.round((mins / 60) * 100) / 100,
            work_status: status,
            task_progress: progress,
            files,
            remarks: remarks || null,
        });
        if (error) throw error;

        /* also move the linked task forward, same rules as the task modal */
        let taskWarning = "";
        if (task) {
            let newStatus = task.status;
            if (progress === 100) newStatus = "done";
            else if (progress > 0 && task.status === "todo") newStatus = "in-progress";

            const { error: taskErr } = await supabase
                .from("tasks")
                .update({
                    progress,
                    status: newStatus,
                    update_requested: false,
                    reports: [
                        ...(task.reports || []),
                        {
                            text: `${workTitle} — ${description}`,
                            date: workDate,
                            author: u.name,
                        },
                    ],
                })
                .eq("id", task.id);
            console.log("[ws] email check", {
                taskId: task?.id,
                pm: task?.projectManagerId,
                oldProgress: task?.progress,
                newProgress: progress,
            });

            if (taskErr) taskWarning = taskErr.message;
            else if (progress !== (task.progress ?? 0)) {
                /* tell the project manager (runs in the background) */
                emailProjectManager(task, {
                    employeeId: u.id,
                    oldProgress: task.progress ?? 0,
                    newProgress: progress,
                    note: `${workTitle} — ${description}`,
                    source: "daily worksheet",
                    work: { start, end, minutes: mins },
                });
            }
        }

        await loadData();

        if (taskWarning) {
            toast(`Worksheet saved, but the project progress wasn't updated: ${taskWarning}`, "error");
        } else {
            toast(
                task
                    ? "Worksheet submitted and project progress updated."
                    : "Worksheet submitted — your admin can now view it.",
                "success",
            );
        }
        resetForm();
        window.scrollTo(0, 0);
    } catch (e) {
        errEl.textContent = e.message || "Couldn't submit the worksheet.";
        toast(errEl.textContent, "error");
    } finally {
        btn.disabled = false;
        btn.textContent = "Submit Worksheet";
    }
}

/* ---------- mount ---------- */
function bind() {
    $("ws-project").addEventListener("change", syncProgress);
    $("ws-progress").addEventListener("input", () => {
        $("ws-progress-pct").textContent = `${$("ws-progress").value}%`;
    });
    $("ws-start").addEventListener("input", updateTotal);
    $("ws-end").addEventListener("input", updateTotal);

    const zone = $("ws-dropzone");
    const input = $("ws-file-input");

    $("ws-choose-files").addEventListener("click", (e) => {
        e.stopPropagation();
        input.click();
    });
    zone.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
        addFiles(input.files);
        input.value = "";
    });

    ["dragenter", "dragover"].forEach((ev) =>
        zone.addEventListener(ev, (e) => {
            e.preventDefault();
            zone.classList.add("drag");
        }),
    );
    ["dragleave", "drop"].forEach((ev) =>
        zone.addEventListener(ev, (e) => {
            e.preventDefault();
            zone.classList.remove("drag");
        }),
    );
    zone.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));

    $("ws-reset").addEventListener("click", resetForm);
    $("ws-submit").addEventListener("click", submitWorksheet);
}

/** Builds the form the first time the tab opens; on later visits it only
 *  refreshes the project list and date, so half-typed work isn't lost when
 *  the employee switches tabs. */
export function mountWorksheet() {
    const root = $("emp-worksheet-content");
    if (!root) return;

    if (!built) {
        root.innerHTML = formHtml();
        bind();
        built = true;
        return;
    }

    const sel = $("ws-project");
    const keep = sel.value;
    sel.innerHTML = projectOptionsHtml(keep);
    if (!sel.value) $("ws-progress-wrap").classList.add("hidden");
    $("ws-today-label").textContent = prettyDate();
    $("ws-date").max = localDate();
}