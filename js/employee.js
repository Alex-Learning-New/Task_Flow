"use strict";

import { supabase } from "./supabase.js";
import { state } from "./state.js";
import { loadData, daysFromNow, today } from "./data.js";
import {
    initShell,
    currentUser,
    statCard,
    taskRowHtml,
    attachTaskRowHandlers,
    drawStatusChart,
    toast,
    rerenderCurrent,
    closeModal,
    tasksFor,
    taskDetailBodyHtml,
    getTeam,
    getUser,
    escapeHtml,
    avatarHtml,
} from "./common.js";
import { emailProjectManager } from "./notify.js";
import { mountWorksheet } from "./worksheet.js";
import { uploadFiles, MAX_FILE_MB } from "./storage.js";
import "./file-preview.js";

window.currentUser = currentUser;
window.state = state;

/* ============================================================
    employee.js — everything specific to the employee dashboard
    Views: my tasks · my team
    Modals: task detail (progress slider, file upload, report)
    Depends on: data.js, common.js
   ============================================================ */

/* ================= VIEW CONFIG ================= */
const EMPLOYEE_VIEW_TITLES = {
    "emp-mytasks": ["My tasks", "Everything assigned to you or your team"],
    "emp-worksheet": ["Daily Worksheet", "Record and submit your daily work"],
    "emp-team": ["My team", "The people you work alongside"],
};

function renderEmployeeView(viewId) {
    if (viewId === "emp-mytasks") renderEmpTasks();
    if (viewId === "emp-worksheet") mountWorksheet();
    if (viewId === "emp-team") renderEmpTeam();
}

function updateEmployeeNavCounts() {
    const u = currentUser();

    if (!u) return;

    document.getElementById("nav-count-mytasks").textContent = tasksFor(
        u.id,
    ).length;

    document.getElementById("nav-count-myteam").textContent = (
        u.teamId || []
    ).length;
}

/* ================= MY TASKS ================= */
let employeeChart = null;

function renderEmpTasks() {
    const u = currentUser();
    const myTasks = tasksFor(u.id);
    const open = myTasks.filter((t) => t.status !== "done").length;
    const done = myTasks.filter((t) => t.status === "done").length;
    const requested = myTasks.filter((t) => t.updateRequested).length;

    document.getElementById("emp-stats").innerHTML = `
    ${statCard("Assigned to you", myTasks.length, u.teamId?.length ? "Includes team tasks" : "Individual tasks")}
    ${statCard("Open", open, `${done} completed`)}
    ${statCard("Update requests", requested, requested > 0 ? "Admin is waiting on these" : "You\u2019re all caught up", requested > 0)}
  `;

    document.getElementById("emp-task-list").innerHTML = myTasks.length
        ? myTasks.map(taskRowHtml).join("")
        : `<div class="empty-row">Nothing assigned yet. New tasks will show up here.</div>`;
    attachTaskRowHandlers("emp-task-list", openTaskDetail);

    setTimeout(() => {
        employeeChart = drawStatusChart(
            "empStatusChart",
            tasksFor(u.id),
            employeeChart,
        );
    }, 0);
}

/* ================= MY TEAM ================= */
function renderEmpTeam() {
    const u = currentUser();
    const el = document.getElementById("emp-team-content");

    if (!u.teamId || u.teamId.length === 0) {
        el.innerHTML = `
        <div class="panel">
            <div class="empty-row">
                You're not part of any team.
            </div>
        </div>`;
        return;
    }

    const teams = state.teams.filter((team) => u.teamId?.includes(team.id));

    el.innerHTML = `

    <div class="panel">

        <div class="team-grid">

            ${teams
            .map(
                (team) => `

                <div class="team-card"
                    data-team="${team.id}">

                    <h4>${escapeHtml(team.name)}</h4>

                    <p>${(team.member_ids || []).length} Members</p>

                </div>

            `,
            )
            .join("")}

        </div>

    </div>

    <div id="selected-team-area"></div>

    `;

    document.querySelectorAll(".team-card").forEach((card) => {
        if (teams.length) {
            showTeamDetails(teams[0].id);
        }

        card.addEventListener("click", () => {
            showTeamDetails(card.dataset.team);
        });
    });
}

function showTeamDetails(teamId) {
    const team = getTeam(teamId);

    if (!team) return;

    const members = (team.member_ids || []).map(getUser).filter(Boolean);

    const teamTasks = state.tasks.filter(
        (t) => t.assignee_type === "team" && t.assignee_id === teamId,
    );

    document.getElementById("selected-team-area").innerHTML = `

    <div class="panel">

        <div class="panel-head">
            <h3>${escapeHtml(team.name)}</h3>
        </div>

        <div class="panel-body">

            <h4>Members</h4>

            <div class="team-members">

                ${members
            .map(
                (m) => `
                    <div class="member-chip">
                        ${avatarHtml(m)}
                        ${escapeHtml(m.name)}
                    </div>
                `,
            )
            .join("")}

            </div>

            <h4 style="margin-top:20px">
                Team Tasks
            </h4>

            <div id="team-task-list">

                ${teamTasks.length
            ? teamTasks.map(taskRowHtml).join("")
            : '<div class="empty-row">No tasks</div>'
        }

            </div>

            <div class="team-message-box">
                <div class="team-message-header">
                    <h4>Team Announcement</h4>
                    <span>Visible to all team members</span>
                </div>

                <textarea
                    id="team-message"
                    placeholder="Share updates, blockers, meeting notes, or announcements..."
                ></textarea>

                <div class="team-message-actions">
                    <span id="message-char-count">0/500</span>

                <button
                    class="btn btn-lime"
                    id="send-team-message">
                    Send to Team
                </button>
                </div>
            </div>

        </div>

    </div>
    `;

    attachTaskRowHandlers("team-task-list", openTaskDetail);
}

/* ================= TASK DETAIL (employee controls) ================= */
function openTaskDetail(taskId) {
    const t = state.tasks.find((x) => x.id === taskId);
    if (!t) return;
    const u = currentUser();

    document.getElementById("td-title").textContent = t.title;

    const body = document.getElementById("td-body");
    body.innerHTML = taskDetailBodyHtml(t, { alwaysShowFiles: true });

    /* progress slider + file upload + report, added under the read-only details */
    const controls = document.createElement("div");
    controls.innerHTML = `
      <div class="section-title">Update your progress</div>
      <div class="slider-row">
        <input type="range" min="0" max="100" step="5" id="td-progress-slider" value="${t.progress}">
        <div class="pct" id="td-progress-pct">${t.progress}%</div>
      </div>
      <div class="section-title">Upload files</div>
      <div class="upload-zone" id="td-upload-zone">
        <input type="file" id="td-file-input" class="hidden" multiple>
        <span id="td-upload-label">Click to attach files (max ${MAX_FILE_MB} MB each) — your admin and project manager can open them</span>
      </div>
      <div class="section-title">Add a report</div>
      <textarea id="td-report-text" placeholder="What did you get done? Any blockers?" style="width:100%;border:1.5px solid var(--line);border-radius:10px;padding:11px 13px;font-size:14px;min-height:70px;font-family:inherit;"></textarea>
    `;
    body.appendChild(controls);

    document.getElementById("td-foot").innerHTML =
        `<button class="btn btn-lime" id="td-save-update">Save update</button>`;

    const slider = document.getElementById("td-progress-slider");
    slider.addEventListener("input", () => {
        document.getElementById("td-progress-pct").textContent = slider.value + "%";
    });

    const uploadZone = document.getElementById("td-upload-zone");
    const fileInput = document.getElementById("td-file-input");
    let pendingFiles = [];

    uploadZone.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", (e) => {
        pendingFiles = [...e.target.files].filter((f) => {
            if (f.size > MAX_FILE_MB * 1024 * 1024) {
                toast(`${f.name} is larger than ${MAX_FILE_MB} MB.`, "error");
                return false;
            }
            return true;
        });
        document.getElementById("td-upload-label").textContent = pendingFiles.length
            ? "📎 " + pendingFiles.map((f) => f.name).join(", ") + " — will attach on save"
            : "Click to attach files (max " + MAX_FILE_MB + " MB each)";
    });

    document
        .getElementById("td-save-update")
        .addEventListener("click", async () => {
            const saveBtn = document.getElementById("td-save-update");
            if (saveBtn.disabled) return;
            saveBtn.disabled = true;
            saveBtn.textContent = "Saving…";
            const reenable = () => {
                saveBtn.disabled = false;
                saveBtn.textContent = "Save update";
            };

            const newProgress = parseInt(slider.value, 10);
            const reportText = document.getElementById("td-report-text").value.trim();

            let newStatus = t.status;

            if (newProgress === 100) newStatus = "done";
            else if (newProgress > 0 && t.status === "todo")
                newStatus = "in-progress";

            const updatedFiles = [...(t.files || [])];

            if (pendingFiles.length) {  
                try {
                    updatedFiles.push(...(await uploadFiles(pendingFiles, `tasks/${t.id}`)));
                } catch (e) {
                    toast(e.message, "error");
                    reenable();
                    return;
                }

                const uploaded = await uploadFiles(pendingFiles, `tasks/${t.id}`);
                uploaded.forEach((file) => { /* uploadedAt / uploadedBy */ });
                updatedFiles.push(...uploaded);
                
            }

            const updatedReports = [...(t.reports || [])];

            const progressChanged = newProgress !== t.progress;
            if (reportText || progressChanged || pendingFiles.length) {
                updatedReports.push({
                    text: reportText || `Progress updated from ${t.progress}% to ${newProgress}%`,
                    date: today(),
                    at: new Date().toISOString(),
                    author: u.name,
                });
            }

            // if (reportText) {
            //     updatedReports.push({
            //         text: reportText,
            //         date: today(),
            //         author: u.name,
            //     });
            // }

            const { error } = await supabase
                .from("tasks")
                .update({
                    progress: newProgress,
                    status: newStatus,
                    update_requested: false,
                    files: updatedFiles,
                    reports: updatedReports,
                })
                .eq("id", t.id);

            if (error) {
                toast(error.message, "error");
                reenable();
                return;
            }

            await loadData();

            toast("Update saved.", "success");

            emailProjectManager(t, { employeeId: u.id, oldProgress: t.progress, newProgress, note: reportText, source: "project update" });

            closeModal("modal-task-detail");

            rerenderCurrent();
        });

    document.getElementById("modal-task-detail").classList.remove("hidden");
}

/* ================= START ================= */
initShell({
    role: "employee",
    defaultView: "emp-mytasks",
    titles: EMPLOYEE_VIEW_TITLES,
    render: renderEmployeeView,
    updateNavCounts: updateEmployeeNavCounts,
});