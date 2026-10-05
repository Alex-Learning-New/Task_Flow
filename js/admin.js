"use strict";

import { supabase } from './supabase.js'
import { loadData, daysFromNow, today } from './data.js';
import { state } from "./state.js";
import {
    initShell, nextId, isOverdue, statCard, taskRowHtml, attachTaskRowHandlers, assigneeNames,
    escapeHtml, fmtDate, drawStatusChart, getUser, getTeam, avatarHtml, taskDetailBodyHtml,
    statusLabel, toast, rerenderCurrent, closeModal, tasksFor, effectiveStatus,
    currentUser, logActivity, recentActivityHtml
} from "./common.js";
import { renderAdminWorksheets } from "./admin-worksheets.js";
import { emailEmployeesUpdateRequest } from "./notify.js";
import { uploadFiles, MAX_FILE_MB } from "./storage.js";
import "./file-preview.js";

/* ============================================================
    admin.js — everything specific to the admin dashboard
    Views: overview · all tasks · teams · employees · departments
    Modals: task detail (admin controls) · create task · create team · edit team
    Depends on: data.js, common.js
   ============================================================ */

/* ================= VIEW CONFIG ================= */
const ADMIN_VIEW_TITLES = {
    "admin-overview": [
        "Overview",
        "Track everything happening across your workspace",
    ],
    "admin-tasks": [
        "All projects",
        "Every project you\u2019ve assigned, across every employee and team",
    ],
    "admin-teams": [
        "Teams",
        "Group employees and assign work to them together",
    ],
    "admin-people": [
        "Employees",
        "Everyone on your workspace and how their work is going",
    ],
    "admin-departments": ["Departments", "Where everyone belongs"],
    "admin-worksheets": ["Worksheets", "Daily work reports submitted by employees"],
};

function renderAdminView(viewId) {
    if (viewId === "admin-overview") renderAdminOverview();
    if (viewId === "admin-tasks") renderAdminTasks();
    if (viewId === "admin-teams") renderAdminTeams();
    if (viewId === "admin-people") renderAdminPeople();
    if (viewId === "admin-departments") renderDepartments();
    if (viewId === "admin-worksheets") renderAdminWorksheets();
}

function updateAdminNavCounts() {
    document.getElementById("nav-count-tasks").textContent = state.tasks.length;
    document.getElementById("nav-count-teams").textContent = state.teams.length;
}

/* ================= OVERVIEW ================= */
let adminChart = null;

function renderAdminOverview() {
    const tasks = state.tasks;
    const total = tasks.length;
    const inProgress = tasks.filter((t) => t.status === "in-progress").length;
    const done = tasks.filter((t) => t.status === "done").length;
    const overdue = tasks.filter(isOverdue).length;

    document.getElementById("admin-stats").innerHTML = `
    ${statCard("Total projects", total, `${state.teams.length} teams · ${state.users.filter((u) => u.role === "employee").length} employees`)}
    ${statCard("In progress", inProgress, `${Math.round((inProgress / total) * 100) || 0}% of all projects`)}
    ${statCard("Completed", done, `${Math.round((done / total) * 100) || 0}% completion rate`)}
    ${statCard("Overdue", overdue, overdue > 0 ? "Needs attention" : "All on track", overdue > 0)}
    `;

    const attn = tasks.filter((t) => isOverdue(t) || t.updateRequested);
    document.getElementById("admin-attention-list").innerHTML = attn.length
        ? attn.map(taskRowHtml).join("")
        : `<div class="empty-row">Nothing needs attention right now — everything is on track.</div>`;
    attachTaskRowHandlers("admin-attention-list", openTaskDetail);

    document.getElementById("admin-activity-list").innerHTML =
        recentActivityHtml(tasks, state.activityLog);

    setTimeout(() => {
        adminChart = drawStatusChart("adminStatusChart", state.tasks, adminChart);
    }, 0);
}

/* ================= ALL TASKS ================= */
let taskFilter = "all";

function renderAdminTasks() {
    const bar = document.getElementById("task-filter-bar");
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
                `<button class="btn btn-sm ${taskFilter === key ? "btn-primary" : "btn-ghost"}" data-filter="${key}">${label}</button>`,
        )
        .join("");
    bar.querySelectorAll("button").forEach(
        (b) =>
        (b.onclick = () => {
            taskFilter = b.dataset.filter;
            renderAdminTasks();
        }),
    );

    const list = state.tasks.filter((t) =>
        taskFilter === "all" ? true : effectiveStatus(t) === taskFilter,
    );
    document.getElementById("admin-task-list").innerHTML = list.length
        ? list.map(taskRowHtml).join("")
        : `<div class="empty-row">No projects match this filter.</div>`;
    attachTaskRowHandlers("admin-task-list", openTaskDetail);
}

/* ================= TEAMS ================= */
let editingTeamId = null;

function renderAdminTeams() {
    document.getElementById("admin-team-grid").innerHTML =
        state.teams
            .map((team) => {
                const members = team.member_ids.map(getUser).filter(Boolean);
                const teamTasks = state.tasks.filter(
                    (t) => t.assigneeType === "team" && t.assigneeId === team.id,
                );
                return `
                    <div class="team-card">
                    <h4>${escapeHtml(team.name)}</h4>

                    <div class="tcount">
                        ${members.length} member${members.length !== 1 ? "s" : ""}
                        ·
                        ${teamTasks.length} team project${teamTasks.length !== 1 ? "s" : ""}
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

                    <div style="margin-top:16px;display:flex;gap:8px;">
                        <button class="btn btn-sm btn-ghost edit-team-btn"
                                data-team="${team.id}">
                        Edit Members
                        </button>

                        <button class="btn btn-sm btn-danger delete-team-btn"
                                data-team="${team.id}">
                        Delete
                        </button>
                    </div>
                    </div>`;
            })
            .join("") ||
        `<div class="empty-row">No teams yet. Create one to assign work to a whole group.</div>`;

    document.querySelectorAll(".edit-team-btn").forEach((btn) => {
        btn.addEventListener("click", () => openEditTeam(btn.dataset.team));
    });
    document.querySelectorAll(".delete-team-btn").forEach((btn) => {
        btn.addEventListener("click", () => deleteTeam(btn.dataset.team));
    });
}

function openEditTeam(teamId) {
    const team = getTeam(teamId);
    if (!team) return;

    editingTeamId = teamId;
    document.getElementById("edit-team-name").value = team.name;

    document.getElementById("edit-team-members").innerHTML = state.users
        .filter((u) => u.role === "employee")
        .map(
            (u) => `
      <label class="checkbox-item">
        <input type="checkbox"
               value="${u.id}"
               ${team.member_ids.includes(u.id) ? "checked" : ""}>
        ${escapeHtml(u.name)}
      </label>
    `,
        )
        .join("");

    document.getElementById("modal-edit-team").classList.remove("hidden");
}

document
    .getElementById("form-edit-team")
    .addEventListener("submit", async function (e) {
        e.preventDefault();

        const team = getTeam(editingTeamId);
        const updatedMembers = [
            ...document.querySelectorAll("#edit-team-members input:checked"),
        ].map((i) => i.value);

        const { error } = await supabase
            .from("teams")
            .update({
                name: document.getElementById("edit-team-name").value.trim(),
                member_ids: updatedMembers
            })
            .eq("id", editingTeamId);

        if (error) {
            toast(error.message, "error");
            return;
        }

        await loadData();
        rerenderCurrent();

        closeModal("modal-edit-team");
        rerenderCurrent();
        toast("Team updated.", "success");
    });

async function deleteTeam(teamId) {
    const team = getTeam(teamId);
    if (!team) return;
    if (!confirm(`Delete "${team.name}" ?`)) return;

    state.users.forEach((u) => {
        if (u.teamId === teamId) u.teamId = null;
    });
    state.tasks = state.tasks.filter(
        (t) => !(t.assigneeType === "team" && t.assigneeId === teamId),
    );
    const { error } = await supabase
        .from("teams")
        .delete()
        .eq("id", teamId);

    if (error) {
        toast(error.message, "error");
        return;
    }

    await loadData();
    rerenderCurrent();
    toast("Team deleted.", "error");
}

/* ---------- create team ---------- */
const selectedMembers = new Set();

function openCreateTeam() {
    selectedMembers.clear();
    document.getElementById("form-create-team").reset();

    renderSelectedMembers();
    renderTeamMemberList();

    document.getElementById("cteam-search").oninput = function () {
        renderTeamMemberList(this.value);
    };

    document.getElementById("modal-create-team").classList.remove("hidden");
}

function renderTeamMemberList(search = "") {
    const term = search.toLowerCase();

    document.getElementById("cteam-members").innerHTML = state.users
        .filter((u) => u.role === "employee")
        .filter((u) => {
            const name = (u.name || "").toLowerCase();
            const dept = (u.department || "").toLowerCase();
            return name.includes(term) || dept.includes(term);
        })
        .map(
            (u) => `
            <label class="checkbox-item">
                <input type="checkbox" value="${u.id}" ${selectedMembers.has(u.id) ? "checked" : ""}>
                ${avatarHtml(u)}
                <div>
                    <div>${escapeHtml(u.name)}</div>
                    <small class="hint">${escapeHtml(u.department || "No Department")}</small>
                </div>
            </label>
        `,
        )
        .join("");

    document.querySelectorAll("#cteam-members input").forEach((cb) => {
        cb.addEventListener("change", () => {
            if (cb.checked) selectedMembers.add(cb.value);
            else selectedMembers.delete(cb.value);
            renderSelectedMembers();
        });
    });
}

function renderSelectedMembers() {
    const wrap = document.getElementById("selected-members-bar");

    if (!selectedMembers.size) {
        wrap.innerHTML = '<span class="hint">No members selected</span>';
        return;
    }

    wrap.innerHTML = [...selectedMembers]
        .map((id) => {
            const user = getUser(id);
            return `
                <div class="selected-chip">
                ${avatarHtml(user)}
                <span>${escapeHtml(user.name)}</span>
                <button class="remove" data-remove="${id}">X</button>
                </div>
            `;
        })
        .join("");

    wrap.querySelectorAll("[data-remove]").forEach((btn) => {
        btn.addEventListener("click", () => {
            selectedMembers.delete(btn.dataset.remove);
            renderSelectedMembers();
            renderTeamMemberList(document.getElementById("cteam-search").value);
        });
    });
}

document
    .getElementById("form-create-team")
    .addEventListener("submit", async function (e) {
        e.preventDefault();

        const name = document.getElementById("cteam-name").value.trim();

        const existingTeam = state.teams.find(
            (t) => t.name.toLowerCase() === name.toLowerCase(),
        );
        if (existingTeam) {
            toast("A team with this name already exists.", "error");
            return;
        }

        const member_ids = Array.from(
            document.querySelectorAll("#cteam-members input:checked"),
        ).map((c) => c.value);
        if (!member_ids.length) {
            toast("Select at least one member.");
            return;
        }

        // const id = "t" + Math.random().toString(36).slice(2, 8);
        let newTeamId;
        try {
            newTeamId = await nextId("teams", "t");
        } catch (e) {
            toast(e.message, "error");
            return;
        }

        const { error } = await supabase
            .from("teams")
            .insert({
                id: newTeamId,
                name,
                member_ids: member_ids
            });

        if (error) {
            toast(error.message, "error");
            return;
        }

        await loadData();

        rerenderCurrent();

        closeModal("modal-create-team");
        toast("Team created.", "success");
        rerenderCurrent();
    });

/* ================= EMPLOYEES ================= */
function renderAdminPeople() {
    const departments = [
        ...new Set(
            state.users.filter((u) => u.role === "employee").map((u) => u.department),
        ),
    ];

    const deptFilter = document.getElementById("department-filter");
    const currentDept = deptFilter.value || "all";
    deptFilter.innerHTML =
        '<option value="all">All Departments</option>' +
        departments.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
    deptFilter.value = currentDept;

    const search =
        document.getElementById("employee-search")?.value?.toLowerCase() || "";
    const department = deptFilter.value || "all";
    const assignment =
        document.getElementById("assignment-filter")?.value || "all";

    const employees = state.users.filter((u) => {
        if (u.role !== "employee") return false;

        const myTasks = tasksFor(u.id);

        const matchesSearch =
            u.name.toLowerCase().includes(search) ||
            u.department.toLowerCase().includes(search);
        const matchesDepartment = department === "all" || u.department === department;
        const matchesAssignment =
            assignment === "all" ||
            (assignment === "assigned" ? myTasks.length > 0 : myTasks.length === 0);

        return matchesSearch && matchesDepartment && matchesAssignment;
    });

    document.getElementById("admin-people-table").innerHTML = employees
        .map((u) => {
            const myTasks = tasksFor(u.id);
            const open = myTasks.filter((t) => t.status !== "done").length;
            const done = myTasks.filter((t) => t.status === "done").length;
            const avg = myTasks.length
                ? Math.round(myTasks.reduce((s, t) => s + t.progress, 0) / myTasks.length)
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
        .join("");

    document
        .getElementById("admin-people-table")
        .querySelectorAll("[data-askupdate]")
        .forEach((btn) => {
            btn.addEventListener("click", async () => {
                const uid = btn.dataset.askupdate;
                const myTasks = tasksFor(uid).filter((t) => t.status !== "done");
                if (!myTasks.length) {
                    toast("No open projects to request an update on.");
                    return;
                }
                const ids = myTasks.map(t => t.id);

                const { error } = await supabase
                    .from("tasks")
                    .update({
                        update_requested: true
                    })
                    .in("id", ids);

                if (error) {
                    toast(error.message, "error");
                    return;
                }

                await loadData();

                toast(`Update requested from ${getUser(uid).name}.`);

                /* email just this employee, listing their open projects */
                emailEmployeesUpdateRequest({
                    taskIds: ids,
                    employeeIds: [uid],
                    requesterId: currentUser().id,
                });
            });
        });
}

/* ---------- create employee ---------- */
function openCreateEmployee() {
    document.getElementById("form-create-employee").reset();

    const departments = [
        ...new Set(
            state.users
                .filter((u) => u.role === "employee" && u.department)
                .map((u) => u.department),
        ),
    ];
    document.getElementById("cemp-dept-list").innerHTML = departments
        .map((d) => `<option value="${escapeHtml(d)}"></option>`)
        .join("");

    document.getElementById("modal-create-employee").classList.remove("hidden");
}

document
    .getElementById("form-create-employee")
    .addEventListener("submit", async function (e) {
        e.preventDefault();

        const name = document.getElementById("cemp-name").value.trim();
        const email = document.getElementById("cemp-email").value.trim().toLowerCase();
        const department = document.getElementById("cemp-dept").value.trim();

        if (state.users.some((u) => (u.email || "").toLowerCase() === email)) {
            toast("An employee with this email already exists.", "error");
            return;
        }

        let newUserId;
        try {
            newUserId = await nextId("users", "u");
        } catch (err) {
            toast(err.message, "error");
            return;
        }

        const { error } = await supabase.from("users").insert({
            id: newUserId,
            name,
            email,
            department,
            role: "employee",
        });

        if (error) {
            toast(error.message, "error");
            return;
        }

        await loadData();
        closeModal("modal-create-employee");
        rerenderCurrent();
        toast("Employee added.", "success");
    });

// Filter controls live in static markup, so wire them once
document.getElementById("employee-search").addEventListener("input", renderAdminPeople);
document.getElementById("department-filter").addEventListener("change", renderAdminPeople);
document.getElementById("assignment-filter").addEventListener("change", renderAdminPeople);

/* ================= DEPARTMENTS ================= */
function renderDepartments() {
    const container = document.getElementById("department-grid");
    const departments = {};

    state.users
        .filter((u) => u.role === "employee")
        .forEach((user) => {
            const dept = user.department || "Unassigned";
            if (!departments[dept]) departments[dept] = [];
            departments[dept].push(user);
        });

    container.innerHTML = Object.entries(departments)
        .map(
            ([dept, users]) => `
            <div class="department-card">
                <h3>${escapeHtml(dept)}</h3>
                <div class="department-count">${users.length}</div>
                <div class="department-members">
                    ${users
                    .map(
                        (u) => `<span class="department-member">${escapeHtml(u.name)}</span>`,
                    )
                    .join("")}
                </div>
            </div>
        `,
        )
        .join("");
}

/* ================= TASK DETAIL (admin controls) ================= */
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

    document.getElementById("td-ask-update").addEventListener("click", async () => {
        const btn = document.getElementById("td-ask-update");
        btn.disabled = true;

        const { error } = await supabase
            .from("tasks")
            .update({ update_requested: true })
            .eq("id", t.id);

        if (error) {
            toast(error.message, "error");
            btn.disabled = false;
            return;
        }

        await loadData();

        toast("Update requested.", "success");
        openTaskDetail(taskId);
        rerenderCurrent();

        /* email everyone assigned to this project */
        emailEmployeesUpdateRequest({
            taskIds: [t.id],
            requesterId: currentUser().id,
        });
    });

    document.getElementById("td-delete-task").addEventListener("click", async () => {
        const confirmed = confirm(
            `Delete project "${t.title}"?\n\nThis action cannot be undone.`,
        );
        if (!confirmed) return;

        await supabase
            .from("tasks")
            .delete()
            .eq("id", t.id);

        await logActivity({
            type: "task_deleted",
            taskTitle: t.title,
            actor: currentUser(),
            projectManagerId: t.projectManagerId,
        });

        await loadData();
        rerenderCurrent();

        closeModal("modal-task-detail");
        rerenderCurrent();
        toast("Project deleted.", "error");
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

            await logActivity({
                type: "update_requested",
                taskTitle: t.title,            // in the People table, loop over the tasks instead
                actor: currentUser(),
                projectManagerId: t.projectManagerId,
            });

            toast("Status updated.", "success");
            openTaskDetail(taskId);
            rerenderCurrent();
        });

    document.getElementById("modal-task-detail").classList.remove("hidden");
}

/* ================= CREATE TASK ================= */
let pendingTaskFiles = [];

function openCreateTask() {
    document.getElementById("ct-assignee-pm").innerHTML =
        `<option value="">Select a Project Manager</option>` +
        state.projectManagers
            .map((pm) => `<option value="${pm.id}">${escapeHtml(pm.name)}</option>`)
            .join("");

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

function workloadLevel(activeTasks) {
    if (activeTasks <= 3) return "Available";
    if (activeTasks <= 7) return "Busy";
    return "Overloaded";
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

        const projectManagerId = document.getElementById("ct-assignee-pm").value;
        if (!projectManagerId) {
            toast("Please select a Project Manager.");
            return;
        }

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

            project_manager_id: projectManagerId,

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
    role: "admin",
    defaultView: "admin-overview",
    titles: ADMIN_VIEW_TITLES,
    topbarActions: {
        "admin-overview": { label: "+ New project", onClick: openCreateTask },
        "admin-tasks": { label: "+ New project", onClick: openCreateTask },
        "admin-teams": { label: "+ New team", onClick: openCreateTeam },
        "admin-people": { label: "+ New employee", onClick: openCreateEmployee },
    },
    render: renderAdminView,
    updateNavCounts: updateAdminNavCounts,
});