"use strict";

import { supabase } from './supabase.js'
import { loadData, daysFromNow, today } from './data.js';
import { state } from "./state.js";
import {
    initShell, nextId, isOverdue, statCard, taskRowHtml, attachTaskRowHandlers, assigneeNames,
    escapeHtml, fmtDate, drawStatusChart, getUser, getTeam, avatarHtml, taskDetailBodyHtml,
    statusLabel, toast, rerenderCurrent, closeModal, currentUser, effectiveStatus,
    tasksManagedBy, teamsInTasks, employeesInTasks, logActivity, recentActivityHtml
} from "./common.js";
import { renderPmWorksheets } from "./admin-worksheets.js";
import { emailEmployeesUpdateRequest } from "./notify.js";
import { uploadFiles, MAX_FILE_MB } from "./storage.js";
import "./file-preview.js";

/* ============================================================
    pm.js — everything specific to the project manager dashboard
    Views: overview · my projects · teams · people
    Modals: task detail (ask update, change status) · create task
    Scope: every view here is filtered down to the tasks where
    task.projectManagerId === the signed-in PM's id — a PM only
    ever sees the projects they're managing, never the whole org.
    Depends on: data.js, common.js
   ============================================================ */

/* ================= VIEW CONFIG ================= */
const PM_VIEW_TITLES = {
    "pm-overview": [
        "Overview",
        "Track everything happening across the projects you manage",
    ],
    "pm-tasks": [
        "My projects",
        "Every project you manage",
    ],
    "pm-teams": [
        "Teams",
        "Teams working on your projects",
    ],
    "pm-people": [
        "People",
        "Everyone contributing to your projects and how their work is going",
    ],
    "pm-worksheets": [
        "Worksheets",
        "Daily work reports logged against your projects",
    ],
};

function myTasks() {
    const pm = currentUser();
    return pm ? tasksManagedBy(pm.id) : [];
}

/** Activity log entries (currently just deletions) for projects this
 *  PM manages — so a task they deleted still shows up here even though
 *  it's gone from myTasks(). */
function myDeletionLog() {
    const pm = currentUser();
    if (!pm) return [];
    return state.activityLog.filter((a) => a.projectManagerId === pm.id);
}

function renderPMView(viewId) {
    if (viewId === "pm-overview") renderPMOverview();
    if (viewId === "pm-tasks") renderPMTasks();
    if (viewId === "pm-teams") renderPMTeams();
    if (viewId === "pm-people") renderPMPeople();
    if (viewId === "pm-worksheets") renderPmWorksheets();
}

function updatePMNavCounts() {
    const tasks = myTasks();
    document.getElementById("nav-count-pmtasks").textContent = tasks.length;
    document.getElementById("nav-count-pmteams").textContent = teamsInTasks(tasks).length;
}

/* ================= OVERVIEW ================= */
let pmChart = null;

function renderPMOverview() {
    const tasks = myTasks();
    const total = tasks.length;
    const inProgress = tasks.filter((t) => t.status === "in-progress").length;
    const done = tasks.filter((t) => t.status === "done").length;
    const overdue = tasks.filter(isOverdue).length;

    document.getElementById("pm-stats").innerHTML = `
    ${statCard("Total projects", total, `${teamsInTasks(tasks).length} teams · ${employeesInTasks(tasks).length} people`)}
    ${statCard("In progress", inProgress, `${Math.round((inProgress / total) * 100) || 0}% of your projects`)}
    ${statCard("Completed", done, `${Math.round((done / total) * 100) || 0}% completion rate`)}
    ${statCard("Overdue", overdue, overdue > 0 ? "Needs attention" : "All on track", overdue > 0)}
    `;

    const attn = tasks.filter((t) => isOverdue(t) || t.updateRequested);
    document.getElementById("pm-attention-list").innerHTML = attn.length
        ? attn.map(taskRowHtml).join("")
        : `<div class="empty-row">Nothing needs attention right now — everything is on track.</div>`;
    attachTaskRowHandlers("pm-attention-list", openTaskDetail);

    document.getElementById("pm-activity-list").innerHTML =
        recentActivityHtml(tasks, myDeletionLog());

    setTimeout(() => {
        pmChart = drawStatusChart("pmStatusChart", tasks, pmChart);
    }, 0);
}

/* ================= MY PROJECTS ================= */
let pmTaskFilter = "all";

function renderPMTasks() {
    const tasks = myTasks();

    const bar = document.getElementById("pm-task-filter-bar");
    const filters = [
        ["all", "All"],
        ["todo", "To do"],
        ["in-progress", "In progress"],
        ["review", "In review"],
        ["done", "Done"],
        ["overdue", "Overdue"],
    ];
    bar.innerHTML = filters
        .map(
            ([key, label]) =>
                `<button class="btn btn-sm ${pmTaskFilter === key ? "btn-primary" : "btn-ghost"}" data-filter="${key}">${label}</button>`,
        )
        .join("");
    bar.querySelectorAll("button").forEach(
        (b) =>
        (b.onclick = () => {
            pmTaskFilter = b.dataset.filter;
            renderPMTasks();
        }),
    );

    const list = tasks.filter((t) =>
        pmTaskFilter === "all" ? true : effectiveStatus(t) === pmTaskFilter,
    );
    document.getElementById("pm-task-list").innerHTML = list.length
        ? list.map(taskRowHtml).join("")
        : `<div class="empty-row">No projects match this filter.</div>`;
    attachTaskRowHandlers("pm-task-list", openTaskDetail);
}

/* ================= TEAMS (read-only) ================= */
function renderPMTeams() {
    const tasks = myTasks();
    const teams = teamsInTasks(tasks);

    document.getElementById("pm-team-grid").innerHTML = teams.length
        ? teams
            .map((team) => {
                const members = (team.member_ids || []).map(getUser).filter(Boolean);
                const teamTasks = tasks.filter(
                    (t) => t.assigneeType === "team" && t.assigneeId === team.id,
                );
                return `
                    <div class="team-card">
                    <h4>${escapeHtml(team.name)}</h4>

                    <div class="tcount">
                        ${members.length} member${members.length !== 1 ? "s" : ""}
                        ·
                        ${teamTasks.length} task${teamTasks.length !== 1 ? "s" : ""} under your management
                    </div>

                    <div class="team-members">
                        ${members
                        .map(
                            (u) => `
                            <div class="member-chip">
                            ${avatarHtml(u)}
                            ${escapeHtml(u.name.split(" ")[0])}
                            </div>
                        `,
                        )
                        .join("") ||
                    '<span class="hint">No members yet</span>'
                    }
                    </div>
                    </div>`;
            })
            .join("")
        : `<div class="empty-row">No teams are working on your projects yet.</div>`;
}

/* ================= PEOPLE (read-only) ================= */
function renderPMPeople() {
    const tasks = myTasks();
    const people = employeesInTasks(tasks);

    const departments = [...new Set(people.map((u) => u.department))];
    const deptFilter = document.getElementById("pm-department-filter");
    const currentDept = deptFilter.value || "all";
    deptFilter.innerHTML =
        '<option value="all">All Departments</option>' +
        departments.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
    deptFilter.value = currentDept;

    const search =
        document.getElementById("pm-employee-search")?.value?.toLowerCase() || "";
    const department = deptFilter.value || "all";

    const filtered = people.filter((u) => {
        const matchesSearch =
            u.name.toLowerCase().includes(search) ||
            (u.department || "").toLowerCase().includes(search);
        const matchesDepartment = department === "all" || u.department === department;
        return matchesSearch && matchesDepartment;
    });

    /** Tasks this employee has under THIS PM's projects specifically
     *  (directly assigned, or via a team they belong to). */
    function tasksUnderMe(user) {
        return tasks.filter((t) => {
            if (t.assigneeType === "employee") return t.assigneeId === user.id;
            if (t.assigneeType === "team") {
                const team = getTeam(t.assigneeId);
                return team?.member_ids?.includes(user.id);
            }
            return false;
        });
    }

    document.getElementById("pm-people-table").innerHTML = filtered
        .map((u) => {
            const uTasks = tasksUnderMe(u);
            const open = uTasks.filter((t) => t.status !== "done").length;
            const done = uTasks.filter((t) => t.status === "done").length;
            const avg = uTasks.length
                ? Math.round(uTasks.reduce((s, t) => s + t.progress, 0) / uTasks.length)
                : 0;
            const team = getTeam(u.teamId);
            return `<tr>
        <td><div style="display:flex;align-items:center;gap:10px;">${avatarHtml(u)}<b>${escapeHtml(u.name)}</b></div></td>
        <td>${escapeHtml(u.department)}</td>
        <td>${team ? escapeHtml(team.name) : '<span class="hint">No team</span>'}</td>
        <td>${open}</td>
        <td>${done}</td>
        <td style="width:140px;"><div class="pbar"><div style="width:${avg}%"></div></div><div class="progress-num">${avg}%</div></td>
        <td><button class="btn btn-sm ${open === 0 ? "btn-disabled" : "btn-ghost"}" data-askupdate="${u.id}" ${open === 0 ? "disabled" : ""}> ${open === 0 ? "No Active Projects" : "Ask for Update"}</button></td></tr>`;
        })
        .join("") || `<tr><td colspan="7"><div class="empty-row">No one is working on your projects yet.</div></td></tr>`;

    document
        .getElementById("pm-people-table")
        .querySelectorAll("[data-askupdate]")
        .forEach((btn) => {
            btn.addEventListener("click", async () => {
                const uid = btn.dataset.askupdate;
                const user = getUser(uid);
                const openTasks = tasksUnderMe(user).filter((t) => t.status !== "done");
                if (!openTasks.length) {
                    toast("No open projects to request an update on.");
                    return;
                }
                const ids = openTasks.map((t) => t.id);

                const { error } = await supabase
                    .from("tasks")
                    .update({ update_requested: true })
                    .in("id", ids);

                if (error) {
                    toast(error.message, "error");
                    return;
                }

                await loadData();
                rerenderCurrent();

                toast(`Update requested from ${user.name}.`);

                /* email just this employee, listing their open projects */
                emailEmployeesUpdateRequest({
                    taskIds: ids,
                    employeeIds: [uid],
                    requesterId: currentUser().id,
                });
            });
        });
}

document.getElementById("pm-employee-search").addEventListener("input", renderPMPeople);
document.getElementById("pm-department-filter").addEventListener("change", renderPMPeople);

/* ================= TASK DETAIL ================= */
function openTaskDetail(taskId) {
    const t = state.tasks.find((x) => x.id === taskId);
    if (!t) return;

    document.getElementById("td-title").textContent = t.title;
    document.getElementById("td-body").innerHTML = taskDetailBodyHtml(t);

    const foot = document.getElementById("td-foot");
    foot.innerHTML = `
    <button class="btn btn-danger" id="td-delete-task">Delete Project</button>

    <button class="btn ${t.updateRequested ? "btn-ghost" : "btn-danger"}"
        id="td-ask-update"
        ${t.updateRequested ? "disabled" : ""}>
        ${t.updateRequested ? "Update requested" : "Ask for update"}
    </button>

    <select id="td-status-select" class="btn btn-ghost" style="padding:10px 12px;">
        ${["todo", "in-progress", "review", "done"]
            .map(
                (s) => `
            <option value="${s}" ${t.status === s ? "selected" : ""}>
                ${statusLabel(s)}
            </option>
        `,
            )
            .join("")}
    </select>
    `;

    document.getElementById("td-delete-task").addEventListener("click", async () => {
        const confirmed = confirm(
            `Delete project "${t.title}"?\n\nThis action cannot be undone.`,
        );
        if (!confirmed) return;

        const pm = currentUser();

        await supabase
            .from("tasks")
            .delete()
            .eq("id", t.id);

        await logActivity({
            type: "task_deleted",
            taskTitle: t.title,
            actor: pm,
            projectManagerId: t.projectManagerId,
        });

        await logActivity({
            type: "update_requested",
            taskTitle: t.title,            // in the People table, loop over the tasks instead
            actor: currentUser(),
            projectManagerId: t.projectManagerId,
        });

        await loadData();
        rerenderCurrent();

        closeModal("modal-task-detail");
        rerenderCurrent();
        toast("Project deleted.", "error");
    });

    document.getElementById("td-ask-update").addEventListener("click", async () => {
        const { error } = await supabase
            .from("tasks")
            .update({ update_requested: true })
            .eq("id", t.id);

        if (error) {
            toast(error.message, "error");
            return;
        }

        await loadData();
        rerenderCurrent();

        toast("Update requested.", "success");
        openTaskDetail(taskId);

        /* email everyone assigned to this project */
        emailEmployeesUpdateRequest({
            taskIds: [t.id],
            requesterId: currentUser().id,
        });
    });

    document
        .getElementById("td-status-select")
        .addEventListener("change", async (e) => {
            const { error } = await supabase
                .from("tasks")
                .update({ status: e.target.value })
                .eq("id", t.id);

            if (error) {
                toast(error.message, "error");
                return;
            }

            await loadData();
            rerenderCurrent();

            toast("Status updated.", "success");
            openTaskDetail(taskId);
        });

    document.getElementById("modal-task-detail").classList.remove("hidden");
}

/* ================= CREATE TASK ================= */
let pendingTaskFiles = [];

function openCreateTask() {
    document.getElementById("ct-assignee-employee").innerHTML =
        `<option value="">Select an Employee</option>` +
        state.users
            .filter((u) => u.role === "employee")
            .map((u) => `<option value="${u.id}">${escapeHtml(u.name)}</option>`)
            .join("");

    document.getElementById("ct-assignee-team").innerHTML =
        `<option value="">Select a Team</option>` +
        state.teams
            .map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`)
            .join("");

    document.getElementById("form-create-task").reset();
    pendingTaskFiles = [];
    renderTaskFileList();
    document.getElementById("assignment-preview").innerHTML = "";
    document.getElementById("ct-assignee-employee-wrap").classList.remove("hidden");
    document.getElementById("ct-assignee-team-wrap").classList.add("hidden");
    document.getElementById("ct-due").value = daysFromNow(7);
    document.getElementById("modal-create-task").classList.remove("hidden");
}

/* ---------- attachments ---------- */
const uploadZone = document.getElementById("ct-upload-zone");
const fileInput = document.getElementById("ct-file-input");

uploadZone.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", (e) => {
    [...e.target.files].forEach((file) => {
        if (file.size > MAX_FILE_MB * 1024 * 1024) {
            toast(`${file.name} is larger than ${MAX_FILE_MB} MB.`, "error");
        } else {
            pendingTaskFiles.push(file);
        }
    });
    fileInput.value = "";
    renderTaskFileList();
});

function renderTaskFileList() {
    document.getElementById("ct-file-list").innerHTML = pendingTaskFiles
        .map(
            (file, index) => `
        <div class="file-chip">
            <span>📎 ${escapeHtml(file.name)}</span>
            <span class="file-remove" data-remove-file="${index}">✕</span>
        </div>
    `,
        )
        .join("");

    document.querySelectorAll("[data-remove-file]").forEach((el) => {
        el.addEventListener("click", () => {
            pendingTaskFiles.splice(Number(el.dataset.removeFile), 1);
            renderTaskFileList();
        });
    });
}

/* ---------- assign-to switch + workload preview ---------- */
document
    .getElementById("ct-assignee-employee")
    .addEventListener("change", renderAssignmentPreview);
document
    .getElementById("ct-assignee-team")
    .addEventListener("change", renderAssignmentPreview);

document.querySelectorAll('input[name="ct-assign-type"]').forEach((r) => {
    r.addEventListener("change", () => {
        const isTeam =
            document.querySelector('input[name="ct-assign-type"]:checked').value ===
            "team";
        document
            .getElementById("ct-assignee-employee-wrap")
            .classList.toggle("hidden", isTeam);
        document
            .getElementById("ct-assignee-team-wrap")
            .classList.toggle("hidden", !isTeam);
        renderAssignmentPreview();
    });
});

function getAssignmentSummary(type, id) {
    const tasks = state.tasks.filter(
        (t) => t.assigneeType === type && t.assigneeId === id,
    );

    return {
        total: tasks.length,
        todo: tasks.filter((t) => t.status === "todo").length,
        progress: tasks.filter((t) => t.status === "in-progress").length,
        review: tasks.filter((t) => t.status === "review").length,
        done: tasks.filter((t) => t.status === "done").length,
        overdue: tasks.filter(isOverdue).length,
        tasks,
    };
}

function renderAssignmentPreview() {
    const type = document.querySelector(
        'input[name="ct-assign-type"]:checked',
    ).value;

    const id =
        type === "employee"
            ? document.getElementById("ct-assignee-employee").value
            : document.getElementById("ct-assignee-team").value;

    const preview = document.getElementById("assignment-preview");

    if (!id) {
        preview.innerHTML = "";
        return;
    }

    const summary = getAssignmentSummary(type, id);
    const title =
        type === "employee" ? getUser(id)?.name || "" : getTeam(id)?.name || "";

    preview.innerHTML = `
        <div class="panel-head">
            <h3>Current Workload</h3>
        </div>

        <div class="panel-body" style="margin-left:10px">

            <div style="margin-bottom:12px;">
                <strong>${escapeHtml(title)}</strong>
            </div>

            <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:15px;">
                <div><b>${summary.todo}</b><div class="hint">Todo</div></div>
                <div><b>${summary.progress}</b><div class="hint">Progress</div></div>
                <div><b>${summary.review}</b><div class="hint">Review</div></div>
                <div><b>${summary.done}</b><div class="hint">Done</div></div>
                <div style="color:var(--coral)"><b>${summary.overdue}</b><div class="hint">Overdue</div></div>
            </div>

            <div><strong>Active Projects (${summary.total})</strong></div>

            <div style="margin-top:10px;">
                ${summary.tasks.length
            ? summary.tasks
                .slice(0, 5)
                .map(
                    (t) => `
                        <div style="padding:8px;border-bottom:1px solid var(--line);">
                            <div>${escapeHtml(t.title)}</div>
                            <small>${statusLabel(effectiveStatus(t))} • ${t.progress}%</small>
                        </div>
                    `,
                )
                .join("")
            : '<div class="hint">No projects assigned.</div>'
        }
            </div>

            ${summary.tasks.length > 5
            ? `<div class="hint" style="margin-top:8px;">+${summary.tasks.length - 5} more projects</div>`
            : ""
        }
        </div>
    `;
}

/* ---------- submit ---------- */
document
    .getElementById("form-create-task")
    .addEventListener("submit", async function (e) {
        e.preventDefault();

        const type = document.querySelector(
            'input[name="ct-assign-type"]:checked',
        ).value;

        const assigneeId =
            type === "employee"
                ? document.getElementById("ct-assignee-employee").value
                : document.getElementById("ct-assignee-team").value;

        if (!assigneeId) {
            toast(
                type === "employee"
                    ? "Please select an employee."
                    : "Please select a team.",
            );
            return;
        }

        const pm = currentUser();

        let newTaskId;
        try {
            newTaskId = await nextId("tasks", "k");
        } catch (e) {
            toast(e.message, "error");
            return;
        }

        let uploadedFiles = [];
        try {
            uploadedFiles = await uploadFiles(pendingTaskFiles, `tasks/${newTaskId}`);
        } catch (e) {
            toast(e.message, "error");
            return;
        }

        uploadedFiles.forEach(file => {
            file.uploadedAt = new Date().toISOString();

            file.uploadedBy = {
                id: currentUser().id,
                name: currentUser().name,
                role: currentUser().role
            };
        });

        const taskData = {
            id: newTaskId,
            title: document.getElementById("ct-title").value.trim(),
            description: document.getElementById("ct-desc").value.trim(),

            assignee_type: type,
            assignee_id: assigneeId,

            project_manager_id: pm.id,

            status: "todo",
            progress: 0,

            priority: document.getElementById("ct-priority").value,

            due: document.getElementById("ct-due").value,

            created: today(),

            update_requested: false,

            files: uploadedFiles,
            reports: []
        };

        const { error } = await supabase
            .from("tasks")
            .insert(taskData);

        if (error) {
            toast(error.message, "error");
            return;
        }

        await loadData();
        rerenderCurrent();

        pendingTaskFiles = [];
        fileInput.value = "";
        renderTaskFileList();
        document.getElementById("form-create-task").reset();

        toast("Project created successfully.", "success");
        closeModal("modal-create-task");
        rerenderCurrent();
    });

/* ================= START ================= */

await loadData();

initShell({
    role: "project-manager",
    defaultView: "pm-overview",
    titles: PM_VIEW_TITLES,
    topbarActions: {
        "pm-overview": { label: "+ New project", onClick: openCreateTask },
        "pm-tasks": { label: "+ New project", onClick: openCreateTask },
    },
    render: renderPMView,
    updateNavCounts: updatePMNavCounts,
});