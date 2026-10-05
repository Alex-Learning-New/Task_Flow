"use strict";

import { loadDatabase, loadData} from "./data.js";
import { state } from "./state.js";
import { openStoredFile } from "./storage.js";

/* ============================================================
   common.js — shared by index.html, admin.html and employee.html
   Load order: data.js → common.js → (login.js | admin.js | employee.js)
   ============================================================ */

// const STATE_KEY = "taskflow_state_v1";
const SESSION_KEY = "taskflow_session_v1";

/* ================= AVATARS & FORMATTING ================= */
const AVATAR_COLORS = [
    "#8EC5FF",
    "#8FE0B0",
    "#FFD48A",
    "#FF9FA8",
    "#C4B5FD",
    "#9FE0F5",
    "#FFB5D8",
];

export function colorFor(id) {
    let h = 0;
    for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function initials(name) {
    return name
        .split(" ")
        .map((p) => p[0])
        .slice(0, 2)
        .join("")
        .toUpperCase();
}

export function avatarHtml(user, size) {
    const cls = size === "lg" ? "avatar avatar-lg" : "avatar";
    const inner = user.avatar_url
        ? `<img src="${escapeHtml(user.avatar_url)}" alt="" loading="lazy" />`
        : initials(user.name);
    return `<div class="${cls}" style="background:${colorFor(user.id)}">${inner}</div>`;
}

export function escapeHtml(s) {
    return String(s || "").replace(
        /[&<>"']/g,
        (c) =>
            ({
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#39;",
            })[c],
    );
}

export function today() {
    return new Date().toISOString().slice(0, 10);
}

export function fmtDate(d) {
    const dt = new Date(d + "T00:00:00");
    return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/* ================= STATE ================= */
// const state = {
//     users: [],
//     teams: [],
//     projectManagers: [],
//     tasks: [],
//     currentUser: null,
// };

// export function saveState() {
//     try {
//         localStorage.setItem(
//             STATE_KEY,
//             JSON.stringify({
//                 users: state.users,
//                 teams: state.teams,
//                 projectManagers: state.projectManagers,
//                 tasks: state.tasks,
//             }),
//         );
//     } catch (e) {
//         /* storage unavailable, continue in-memory */
//     }
// }

// export function loadState() {
//     try {
//         const raw = localStorage.getItem(STATE_KEY);
//         if (raw) {
//             const parsed = JSON.parse(raw);
//             state.users = parsed.users || seedUsers;
//             state.teams = parsed.teams || seedTeams;
//             state.projectManagers = parsed.projectManagers || seedProjectManagers;
//             state.tasks = parsed.tasks || seedTasks;
//         }
//     } catch (e) {
//         /* fall back to seed */
//     }

//     // Older saved data may contain tasks without a project manager
//     let migrated = false;
//     state.tasks.forEach((task) => {
//         if (!task.projectManagerId) {
//             task.projectManagerId = Math.random() > 0.5 ? "pm1" : "pm2";
//             migrated = true;
//         }
//     });
//     if (migrated) saveState();
// }

/* ================= SESSION ================= */
// The session lives in sessionStorage so it survives the redirect from
// the login page to admin.html / employee.html, but ends with the tab.
export function getSessionUserId() {
    try {
        return sessionStorage.getItem(SESSION_KEY);
    } catch (e) {
        return null;
    }
}

export function setSession(userId) {
    try {
        sessionStorage.setItem(SESSION_KEY, userId);
    } catch (e) {
        /* ignore */
    }
}

export function clearSession() {
    try {
        sessionStorage.removeItem(SESSION_KEY);
    } catch (e) {
        /* ignore */
    }
}

export function pageForRole(role) {
    if (role === "admin") return "admin.html";
    if (role === "project-manager") return "pm.html";
    return "employee.html";
}

/** Looks a person up by id across both the users table and the
 *  project_managers table, and tags the result with a `role` so the
 *  rest of the app can treat admins, employees and PMs the same way. */
export function findPerson(id) {
    const user = getUser(id);
    if (user) return user;

    const pm = getProjectManager(id);
    if (pm) return { ...pm, role: "project-manager" };

    return null;
}

/** Returns the signed-in user if they have the required role, otherwise
 *  sends them back to the login page and returns null. */
export function requireRole(role) {
    const person = findPerson(getSessionUserId());
    if (!person || person.role !== role) {
        window.location.replace("index.html");
        return null;
    }
    return person;
}

/* ================= LOOKUPS & TASK HELPERS ================= */
export function getUser(id) {
    return state.users.find((u) => u.id === id);
}
export function getTeam(id) {
    return state.teams.find((t) => t.id === id);
}
export function getProjectManager(id) {
    return state.projectManagers.find((pm) => pm.id === id);
}
export function currentUser() {
    return findPerson(state.currentUser);
}

/** All tasks a project manager is overseeing, regardless of who the
 *  actual assignee (employee/team) is. */
export function tasksManagedBy(pmId) {
    return state.tasks.filter((t) => t.projectManagerId === pmId);
}

/** Distinct teams that appear among a set of tasks. */
export function teamsInTasks(tasks) {
    const ids = new Set(
        tasks.filter((t) => t.assigneeType === "team").map((t) => t.assigneeId),
    );
    return state.teams.filter((t) => ids.has(t.id));
}

/** Distinct employees that appear among a set of tasks, whether assigned
 *  directly or as part of an assigned team. */
export function employeesInTasks(tasks) {
    const ids = new Set();
    tasks.forEach((t) => {
        if (t.assigneeType === "employee") {
            ids.add(t.assigneeId);
        } else if (t.assigneeType === "team") {
            const team = getTeam(t.assigneeId);
            (team?.member_ids || []).forEach((uid) => ids.add(uid));
        }
    });
    return state.users.filter((u) => ids.has(u.id));
}

/** Records an event (currently just task deletions) to the activity_log
 *  table so it can still show up in "recent activity" feeds after the
 *  task itself is gone. Never throws — a logging failure shouldn't block
 *  the action that triggered it. */
export async function logActivity({ type, taskTitle, actor, projectManagerId }) {
    try {
        await supabase.from("activity_log").insert({
            type,
            task_title: taskTitle,
            actor_id: actor?.id || null,
            actor_name: actor?.name || "Someone",
            actor_role: actor?.role || null,
            project_manager_id: projectManagerId || null,
            date: today(),
        });
    } catch (e) {
        console.error(e);
    }
}

export function isOverdue(t) {
    return t.status !== "done" && t.due < today();
}
export function effectiveStatus(t) {
    return isOverdue(t) ? "overdue" : t.status;
}
export function statusLabel(s) {
    return (
        {
            todo: "To do",
            "in-progress": "In progress",
            review: "In review",
            done: "Done",
            overdue: "Overdue",
        }[s] || s
    );
}

export function assigneeNames(t) {
    if (t.assigneeType === "project-manager") {
        const pm = getProjectManager(t.assigneeId);
        return pm ? [{ id: pm.id, name: pm.name }] : [];
    }
    if (t.assigneeType === "employee") {
        const u = getUser(t.assigneeId);
        return u ? [u] : [];
    }
    const team = getTeam(t.assigneeId);
    if (!team) return [];
    return team.member_ids.map(getUser).filter(Boolean);
}

export function tasksFor(userId) {

    const user = getUser(userId);

    // console.log("Current User:", user);
    // console.log("User Team:", user?.teamId);
    // console.log("All Tasks:", state.tasks);

    const result = state.tasks.filter(task => {

        if (task.assigneeType === "employee") {
            return task.assigneeId === userId;
        }

        if (task.assigneeType === "team") {
            return user.teamIds?.includes(task.assigneeId);
        }

        return false;
    });

    // console.log("My Tasks:", result);

    return result;
}


/* ================= TOASTS ================= */
export function toast(message, type = "info") {
    const svg = (paths) =>
        `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${paths}</svg>`;
    const icons = {
        success: svg('<path d="M20 6L9 17l-5-5"/>'),
        error: svg(
            '<circle cx="12" cy="12" r="10"/><path d="M15 9L9 15"/><path d="M9 9L15 15"/>',
        ),
        info: svg(
            '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
        ),
    };

    const wrap = document.getElementById("toast-wrap");
    const el = document.createElement("div");
    el.className = `toast toast-${type}`;
    el.innerHTML = icons[type] + message;
    wrap.appendChild(el);

    setTimeout(() => {
        el.style.opacity = "0";
        el.style.transform = "translateX(30px)";
        setTimeout(() => el.remove(), 250);
    }, 3000);
}

/* ================= SHARED UI FRAGMENTS ================= */
export function statCard(label, num, delta, warn) {
    return `<div class="stat-card"><div class="label">${label}</div><div class="num" style="${warn ? "color:var(--coral)" : ""}">${num}</div><div class="delta">${delta}</div></div>`;
}

export function taskRowHtml(t) {
    const es = effectiveStatus(t);
    const assignees = assigneeNames(t);
    const stack = assignees
        .slice(0, 3)
        .map(
            (u) =>
                avatarHtml(u),
        )
        .join("");
    return `<div class="task-row status-${es === "overdue" ? "overdue" : t.status}" data-task="${t.id}">
    <div class="task-main">
        <div class="t-title">${escapeHtml(t.title)} ${t.updateRequested ? '<span class="req-badge">• update requested</span>' : ""}</div>
        <div class="t-meta">
        <span class="badge badge-${es === "overdue" ? "overdue" : t.status.replace("in-progress", "progress")}"><span class="dot"></span>${statusLabel(es)}</span>
        <span>${t.assigneeType === "team" ? "👥 " + (getTeam(t.assigneeId)?.name || "Team") : assignees[0]?.name || "Unassigned"}</span>
        <span>Due ${fmtDate(t.due)}</span>
    </div>
    </div>
    <div class="task-progress-mini">
        <div class="pbar"><div style="width:${t.progress}%"></div></div>
        <div class="progress-num">${t.progress}%</div>
    </div>
    <div class="assignee-stack">${stack}</div>
  </div>`;
}

/** Shared "recent activity" feed used by both the admin and PM overview
 *  pages: task report/assignment events plus any activity_log entries
 *  (currently just task deletions), merged and sorted by date. Deletions
 *  have to come from a persisted log since the task itself is gone by
 *  the time this renders. */
export function recentActivityHtml(tasks, activityLog = []) {
    const taskEvents = tasks.map((t) => {
        const lastReport = t.reports[t.reports.length - 1];
        const names = assigneeNames(t)
            .map((u) => u.name)
            .join(", ");
        return {
            date: lastReport?.date || t.created,
            html: `<div style="display:flex;gap:12px;padding:10px 0;border-bottom:1px solid var(--line);">
        <div style="width:6px;height:6px;border-radius:50%;background:var(--lime-dark);margin-top:7px;flex:none;"></div>
        <div style="flex:1;font-size:13.5px;">
        <b>${escapeHtml(names || "Unassigned")}</b> ${lastReport ? "submitted an update on" : "was assigned"} <b>${escapeHtml(t.title)}</b>
        <div class="hint" style="margin-top:2px;">${fmtDate(lastReport?.date || t.created)}</div>
        </div>
    </div>`,
        };
    });

    const deletionEvents = activityLog.map((a) => ({
        date: a.date,
        html: `<div style="display:flex;gap:12px;padding:10px 0;border-bottom:1px solid var(--line);">
        <div style="width:6px;height:6px;border-radius:50%;background:var(--coral);margin-top:7px;flex:none;"></div>
        <div style="flex:1;font-size:13.5px;">
        <b>${escapeHtml(a.actorName || "Someone")}</b>${a.actorRole === "project-manager" ? " (PM)" : ""} deleted <b>${escapeHtml(a.taskTitle || "a project")}</b>
        <div class="hint" style="margin-top:2px;">${fmtDate(a.date)}</div>
        </div>
    </div>`,
    }));

    const merged = [...taskEvents, ...deletionEvents]
        .sort((x, y) => (y.date || "").localeCompare(x.date || ""))
        .slice(0, 5);

    return merged.length
        ? merged.map((e) => e.html).join("")
        : `<div class="empty-row">No activity yet.</div>`;
}

/** Makes every task row inside a container open the detail modal. */
export function attachTaskRowHandlers(containerId, onOpen) {
    document
        .getElementById(containerId)
        .querySelectorAll(".task-row")
        .forEach((row) => {
            row.addEventListener("click", () => onOpen(row.dataset.task));
        });
}

export function filesHtml(t) {
    if (!t.files.length)
        return `<div class="hint" style="padding:6px 0 4px;">No files uploaded yet.</div>`;
    return t.files
        .map(
            (f) => `<div class="file-item">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
    ${f.path ? `<a href="#" class="fname" data-file-path="${escapeHtml(f.path)}" data-file-bucket="${escapeHtml(f.bucket || "")}">${escapeHtml(f.name)}</a>` : `<span class="fname">${escapeHtml(f.name)}</span>`}<span class="fdate">${fmtDate(f.date)}</span>
  </div>`,
        )
        .join("");
}

export function reportsHtml(t) {
    if (!t.reports.length)
        return `<div class="hint" style="padding:6px 0 4px;">No reports submitted yet.</div>`;
    return [...t.reports]
        .reverse()
        .map(
            (r) => `<div class="report-item">
    <div class="r-meta"><b>${escapeHtml(r.author || "")}</b> · ${fmtDate(r.date)}</div>
    <div class="r-text">${escapeHtml(r.text)}</div>
  </div>`,
        )
        .join("");
}

/** The read-only part of the task detail modal, identical for both roles.
 *  Each role adds its own controls and footer on top of this. */
export function taskDetailBodyHtml(t, { alwaysShowFiles = false } = {}) {
    const es = effectiveStatus(t);
    const assignedTo =
        t.assigneeType === "team"
            ? getTeam(t.assigneeId)?.name || "Team"
            : assigneeNames(t)[0]?.name || "—";
    const pmName = getProjectManager(t.projectManagerId)?.name || "Not Assigned";

    let body = "";
    if (t.updateRequested) {
        body += `<div class="update-banner"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>An update has been requested on this project.</div>`;
    }
    body += `<p style="color:var(--ink-soft);font-size:14.5px;line-height:1.6;margin-top:0;">${escapeHtml(t.description || "No description provided.")}</p>`;
    body += `<div class="detail-meta-grid">
    <div class="mi"><div class="k">Status</div><div class="v"><span class="badge badge-${es === "overdue" ? "overdue" : t.status.replace("in-progress", "progress")}"><span class="dot"></span>${statusLabel(es)}</span></div></div>
    <div class="mi"><div class="k">Priority</div><div class="v" style="text-transform:capitalize;">${escapeHtml(t.priority)}</div></div>
    <div class="mi"><div class="k">Due date</div><div class="v">${fmtDate(t.due)}</div></div>
    <div class="mi"><div class="k">Assigned to</div><div class="v">${escapeHtml(assignedTo)}</div></div>
    <div class="mi"><div class="k">Project Manager</div><div class="v">${escapeHtml(pmName)}</div></div>
  </div>`;

    body += `<div class="section-title">Progress</div>
  <div class="pbar" style="height:9px;margin-bottom:6px;"><div style="width:${t.progress}%"></div></div>
  <div class="progress-num" style="font-size:13px;">${t.progress}% complete</div>`;

    if (t.files.length || alwaysShowFiles) {
        body += `<div class="section-title">Files</div><div id="td-files">${filesHtml(t)}</div>`;
    }

    body += `<div class="section-title">Reports & updates</div><div id="td-reports">${reportsHtml(t)}</div>`;
    return body;
}

/* ================= STATUS CHART ================= */
/* WWDC-style 3D ring. Drawn as plain SVG (no chart library needed): each
   status is a thick arc with round end-caps, tilted back and stacked
   layer-by-layer to give it depth. */
const STATUS_CHART_KEYS = ["todo", "in-progress", "review", "done", "overdue"];
const STATUS_CHART_LABELS = ["To Do", "In Progress", "Review", "Done", "Overdue"];
const STATUS_CHART_COLORS = ["#8e8e93", "#0a84ff", "#ff9f0a", "#30d158", "#ff453a"];
const CHART_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif';

/* --- look & feel: tweak these --- */
const RING = {
    W: 420, H: 244,      // drawing size
    CX: 210, CY: 104,    // centre of the ring's top face
    R: 108,              // radius of the ring's centre line
    T: 34,               // ring thickness (also = corner roundness: caps are T/2 radius)
    TILT: 0.62,          // 1 = flat top-down, lower = more tilted
    DEPTH: 24,           // 3D thickness in px
    GAP: 7,              // visible gap between segments
};

function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const c = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
    return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

function arcPath(a0, a1, r) {
    const p = (a) => `${(r * Math.cos(a)).toFixed(2)} ${(r * Math.sin(a)).toFixed(2)}`;
    return `M ${p(a0)} A ${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${p(a1)}`;
}

let chartStyleAdded = false;
function ensureChartStyles() {
    if (chartStyleAdded) return;
    chartStyleAdded = true;
    const st = document.createElement("style");
    st.textContent = `
    .tf-chart{position:relative;width:100%;max-width:440px;margin:0 auto;font-family:${CHART_FONT}}
    .tf-chart svg{display:block;width:100%;height:auto;overflow:visible}
    .tf-ring{transform-origin:50% 45%;animation:tf-in .7s cubic-bezier(.2,.8,.2,1) both}
    @keyframes tf-in{from{opacity:0;transform:translateY(10px) scale(.94)}to{opacity:1;transform:none}}
    .tf-seg{transition:transform .28s cubic-bezier(.2,.8,.2,1),filter .2s}
    .tf-seg.hov{transform:translateY(-11px);filter:brightness(1.07)}
    .tf-legend{display:flex;flex-wrap:wrap;justify-content:center;gap:8px 16px;margin-top:6px}
    .tf-leg{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:500;color:#424245;cursor:default}
    .tf-leg i{width:10px;height:10px;border-radius:50%;display:inline-block}
    .tf-leg b{color:#8e8e93;font-weight:600}
    .tf-leg.hov{color:#1d1d1f}
    .tf-tip{position:absolute;pointer-events:none;opacity:0;transition:opacity .15s;z-index:5;
      background:rgba(255,255,255,.92);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
      border-radius:12px;padding:9px 12px;font-size:13px;color:#1d1d1f;white-space:nowrap;
      box-shadow:0 6px 24px rgba(0,0,0,.16),0 1px 3px rgba(0,0,0,.08)}
    .tf-tip.on{opacity:1}
    .tf-tip span{color:#6e6e73}`;
    document.head.appendChild(st);
}

/** Pure function: returns the chart markup for a set of counts (one per status). */
function buildStatusChartHtml(counts) {
    const { W, H, CX, CY, R, T, TILT, DEPTH, GAP } = RING;
    const total = counts.reduce((a, b) => a + b, 0);

    const segs = STATUS_CHART_LABELS.map((name, i) => ({
        i, name, count: counts[i], color: STATUS_CHART_COLORS[i],
    })).filter((s) => s.count > 0);

    // a "shape" is what we draw per layer: an arc with round caps, or a full ring
    let angle = -Math.PI / 2;
    const shapes = segs.map((s) => {
        const span = (s.count / total) * Math.PI * 2;
        const start = angle;
        angle += span;
        const inset = (T / 2 + GAP / 2) / R;
        let a0 = start + inset, a1 = start + span - inset;
        if (a1 <= a0) { a0 = start + span / 2; a1 = a0 + 0.001; } // tiny slice → round dot
        return { ...s, a0, a1 };
    });
    const full = total === 0 || shapes.length === 1;
    if (total === 0) shapes.push({ i: -1, name: "No projects", count: 0, color: "#e5e5ea" });

    const draw = (sh, color, extra = "") =>
        full
            ? `<circle r="${R}" fill="none" stroke="${color}" stroke-width="${T}" class="tf-seg" data-i="${sh.i}" ${extra}/>`
            : `<path d="${arcPath(sh.a0, sh.a1, R)}" fill="none" stroke="${color}" stroke-width="${T}" stroke-linecap="round" class="tf-seg" data-i="${sh.i}" ${extra}/>`;

    // bottom layer first → top face last
    let layers = "";
    for (let d = DEPTH; d >= 0; d--) {
        const paths = shapes
            .map((sh) => {
                const color = d === 0 ? sh.color : shade(sh.color, 0.82 - 0.2 * (d / DEPTH));
                return draw(sh, color);
            })
            .join("");
        layers += `<g transform="translate(${CX},${CY + d}) scale(1,${TILT})">${paths}</g>`;
    }

    // soft highlight along the top edge for a glassy, rounded look
    const shine = shapes
        .map((sh) => {
            if (full) {
                return `<circle r="${R + T * 0.14}" fill="none" stroke="#fff" stroke-opacity=".22" stroke-width="${T * 0.3}" class="tf-seg" data-i="${sh.i}" pointer-events="none"/>`;
            }
            const extra = (T * 0.32) / R;
            const a0 = sh.a0 + extra, a1 = Math.max(sh.a1 - extra, a0 + 0.001);
            return `<path d="${arcPath(a0, a1, R + T * 0.14)}" fill="none" stroke="#fff" stroke-opacity=".22" stroke-width="${T * 0.3}" stroke-linecap="round" class="tf-seg" data-i="${sh.i}" pointer-events="none"/>`;
        })
        .join("");

    const shadowRx = R + T / 2 + 6;
    const svg = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Project status: ${total} projects">
      <defs><filter id="tf-blur" x="-30%" y="-60%" width="160%" height="220%"><feGaussianBlur stdDeviation="9"/></filter></defs>
      <ellipse cx="${CX}" cy="${CY + DEPTH + 10}" rx="${shadowRx}" ry="${shadowRx * TILT * 0.9}" fill="#000" opacity=".16" filter="url(#tf-blur)"/>
      <g class="tf-ring">
        ${layers}
        <g transform="translate(${CX},${CY}) scale(1,${TILT})">${shine}</g>
      </g>
      <text x="${CX}" y="${CY + 10}" text-anchor="middle" font-family='${CHART_FONT}' font-size="40" font-weight="700" fill="#1d1d1f">${total}</text>
      <text x="${CX}" y="${CY + 32}" text-anchor="middle" font-family='${CHART_FONT}' font-size="13" font-weight="500" fill="#6e6e73">${total === 1 ? "Project" : "Projects"}</text>
    </svg>`;

    const legend = STATUS_CHART_LABELS.map(
        (n, i) => `<span class="tf-leg" data-i="${i}"><i style="background:${STATUS_CHART_COLORS[i]}"></i>${n} <b>${counts[i]}</b></span>`,
    ).join("");

    return `<div class="tf-chart">${svg}<div class="tf-tip"></div><div class="tf-legend">${legend}</div></div>`;
}

/** Draws (or redraws) the 3D status ring into the container. */
export function drawStatusChart(containerId, tasks) {
    const host = document.getElementById(containerId);
    if (!host) return;
    ensureChartStyles();

    const counts = STATUS_CHART_KEYS.map(
        (key) => tasks.filter((t) => effectiveStatus(t) === key).length,
    );
    const total = counts.reduce((a, b) => a + b, 0);
    host.innerHTML = buildStatusChartHtml(counts);

    const root = host.querySelector(".tf-chart");
    const tip = root.querySelector(".tf-tip");
    const setHover = (i) => {
        root.querySelectorAll(".hov").forEach((n) => n.classList.remove("hov"));
        if (i == null || i < 0) return;
        root.querySelectorAll(`.tf-seg[data-i="${i}"], .tf-leg[data-i="${i}"]`).forEach((n) => n.classList.add("hov"));
    };

    root.addEventListener("mousemove", (e) => {
        const el = e.target.closest?.(".tf-seg, .tf-leg");
        const i = el ? Number(el.dataset.i) : null;
        setHover(i);
        if (el && i >= 0 && total) {
            const box = root.getBoundingClientRect();
            tip.innerHTML = `<b style="color:${STATUS_CHART_COLORS[i]}">●</b> <b>${STATUS_CHART_LABELS[i]}</b><br><span>${counts[i]} project${counts[i] === 1 ? "" : "s"} · ${Math.round((counts[i] / total) * 100)}%</span>`;
            tip.style.left = `${Math.min(e.clientX - box.left + 14, box.width - 140)}px`;
            tip.style.top = `${e.clientY - box.top - 52}px`;
            tip.classList.add("on");
        } else {
            tip.classList.remove("on");
        }
    });
    root.addEventListener("mouseleave", () => {
        setHover(null);
        tip.classList.remove("on");
    });
}

/* ================= ID GENERATION ================= */
/** Next free id for a table whose ids look like "k7" / "t3".
 *  Uses the highest number in use (not the row count), so deleting a
 *  task or team can never make a new id collide with an existing one. */
export async function nextId(table, prefix) {
    const { data, error } = await supabase.from(table).select("id");
    if (error) throw error;

    const max = (data || []).reduce((m, row) => {
        const n = parseInt(String(row.id).replace(/^\D+/, ""), 10);
        return Number.isFinite(n) ? Math.max(m, n) : m;
    }, 0);

    return `${prefix}${max + 1}`;
}

/* ================= STORED FILE LINKS ================= */
// Any element with data-file-path opens that file through a short-lived
// signed URL (see storage.js). Works for task files and worksheet files.
document.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-file-path]");
    if (!el) return;
    e.preventDefault();
    try {
        await openStoredFile({
            name: el.textContent.trim(),
            path: el.dataset.filePath,
            bucket: el.dataset.fileBucket || undefined,
        });
    } catch (err) {
        toast(err.message, "error");
    }
});

/* ================= CONFIRM DIALOG ================= */
let confirmPending = null;

/**
 * Promise-based confirmation dialog (reuses the .modal styles, so it picks
 * up the glass theme automatically). Resolves true on confirm, false on
 * cancel / Esc / backdrop click. Only one can be open at a time.
 */
export function confirmDialog({
    title = "Are you sure?",
    message = "",
    confirmText = "Confirm",
    cancelText = "Cancel",
} = {}) {
    if (confirmPending) return confirmPending;

    confirmPending = new Promise((resolve) => {
        const previouslyFocused = document.activeElement;

        const bd = document.createElement("div");
        bd.className = "modal-backdrop";
        bd.style.zIndex = "10000";
        bd.innerHTML = `
          <div class="modal" role="alertdialog" aria-modal="true"
               aria-labelledby="cf-title" aria-describedby="cf-msg"
               style="max-width:420px;margin-top:30vh">
            <div class="modal-head"><h3 id="cf-title">${escapeHtml(title)}</h3></div>
            <div class="modal-body" id="cf-msg"
                 style="font-size:14.5px;line-height:1.55;color:var(--ink-soft)">${escapeHtml(message)}</div>
            <div class="modal-foot">
              <button type="button" class="btn btn-ghost" data-cf="cancel">${escapeHtml(cancelText)}</button>
              <button type="button" class="btn btn-lime" data-cf="ok">${escapeHtml(confirmText)}</button>
            </div>
          </div>`;

        const cancelBtn = bd.querySelector('[data-cf="cancel"]');
        const okBtn = bd.querySelector('[data-cf="ok"]');

        const close = (result) => {
            window.removeEventListener("keydown", onKey, true);
            bd.remove();
            confirmPending = null;
            if (previouslyFocused?.focus) previouslyFocused.focus();
            resolve(result);
        };

        // Capture phase so Esc closes only this dialog, not the ones underneath
        const onKey = (e) => {
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close(false);
            } else if (e.key === "Tab") {
                // keep focus inside the dialog
                const first = cancelBtn;
                const last = okBtn;
                if (e.shiftKey && document.activeElement === first) {
                    e.preventDefault();
                    last.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault();
                    first.focus();
                }
            }
        };

        cancelBtn.addEventListener("click", () => close(false));
        okBtn.addEventListener("click", () => close(true));
        bd.addEventListener("click", (e) => {
            if (e.target === bd) close(false);
        });
        window.addEventListener("keydown", onKey, true);

        document.body.appendChild(bd);
        cancelBtn.focus(); // safest default: Enter does NOT sign out
    });

    return confirmPending;
}

/** Ends the session and returns to the login page. */
export function signOut() {
    try {
        sessionStorage.removeItem(`taskflow.view.${state.currentUser}`);
    } catch (e) {
        /* ignore */
    }
    clearSession();
    window.location.replace("index.html");
}

/** Asks before signing out. Resolves true if the user agreed (and signs out). */
export async function confirmSignOut() {
    const ok = await confirmDialog({
        title: "Sign out?",
        message:
            "You'll be returned to the login page. Anything you haven't submitted yet, such as a worksheet in progress, will be lost.",
        confirmText: "Sign out",
        cancelText: "Stay signed in",
    });
    if (ok) signOut();
    return ok;
}

/**
 * Stops the browser Back button / swipe-back from silently leaving the
 * dashboard. A guard history entry is added after the first user
 * interaction (Chrome ignores entries created without one). Pressing Back
 * then asks for confirmation; "Stay signed in" puts the guard back.
 */
function installBackGuard() {
    const GUARD = { taskflowGuard: true };
    let armed = false;

    const arm = () => {
        if (history.state?.taskflowGuard) return;
        history.pushState(GUARD, "", window.location.href);
    };

    const armOnFirstInteraction = () => {
        if (armed) return;
        armed = true;
        arm();
        ["pointerdown", "keydown", "touchstart"].forEach((t) =>
            window.removeEventListener(t, armOnFirstInteraction, true),
        );
    };
    ["pointerdown", "keydown", "touchstart"].forEach((t) =>
        window.addEventListener(t, armOnFirstInteraction, {
            capture: true,
            passive: true,
        }),
    );

    window.addEventListener("popstate", async (e) => {
        if (e.state?.taskflowGuard) return; // landed on the guard itself
        const signedOut = await confirmSignOut();
        if (!signedOut) arm(); // stay: re-add the guard (runs inside the click's user activation)
    });
}

/* ================= MODAL HELPERS ================= */
export function closeModal(id) {
    document.getElementById(id).classList.add("hidden");
}

export function initModals() {
    document.querySelectorAll(".modal-backdrop").forEach((bd) => {
        bd.addEventListener("click", (e) => {
            if (e.target === bd) bd.classList.add("hidden");
        });
        bd.querySelectorAll("[data-close]").forEach((b) =>
            b.addEventListener("click", () => bd.classList.add("hidden")),
        );
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape")
            document
                .querySelectorAll(".modal-backdrop")
                .forEach((bd) => bd.classList.add("hidden"));
    });
}

/* ================= APP SHELL (sidebar, nav, topbar) ================= */
let shell = null;

const ROLE_LABELS = {
    admin: "Admin",
    employee: "Employee",
    "project-manager": "Project Manager",
};

const EXTRA_VIEW_TITLES = {
    profile: ["My profile", "Your photo, contact details and password"],
};

/* Remember which view is open so a page reload returns to it.
   sessionStorage = per tab, cleared when the tab closes or on sign-out. */
const viewKey = () => `taskflow.view.${state.currentUser}`;

function savedView() {
    try {
        const id = sessionStorage.getItem(viewKey());
        return id && document.getElementById("view-" + id) ? id : null;
    } catch (e) {
        return null;
    }
}

function rememberView(viewId) {
    try {
        sessionStorage.setItem(viewKey(), viewId);
    } catch (e) {
        /* ignore */
    }
}

/** Repaints the sidebar footer (photo/initials, name, role) from the
 *  signed-in person. Call again after the profile changes. */
export function refreshSidebarUser() {
    const user = currentUser();
    if (!user) return;
    const avatar = document.getElementById("sidebar-avatar");
    avatar.style.background = colorFor(user.id);
    avatar.innerHTML = user.avatar_url
        ? `<img src="${escapeHtml(user.avatar_url)}" alt="" />`
        : escapeHtml(initials(user.name));
    document.getElementById("sidebar-name").textContent = user.name;
    document.getElementById("sidebar-role").textContent =
        ROLE_LABELS[user.role] || user.role;
}

/** Avatar + name + role in the sidebar footer open the profile page. */
function makeSidebarUserClickable() {
    const foot = document.querySelector(".sidebar-foot");
    const avatar = document.getElementById("sidebar-avatar");
    const who = foot?.querySelector(".who");
    if (!foot || !avatar || !who || foot.querySelector(".sidebar-user")) return;

    const link = document.createElement("div");
    link.className = "sidebar-user";
    link.setAttribute("role", "button");
    link.tabIndex = 0;
    link.title = "View profile";
    foot.insertBefore(link, avatar);
    link.append(avatar, who);

    const open = () => goView("profile");
    link.addEventListener("click", open);
    link.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open();
        }
    });
}

/* ================= LIVE UPDATES ================= */
let liveStarted = false;
let refreshTimer = null;
let refreshing = false;

// views that should not be redrawn under the user (forms / own data loads)
const NO_LIVE_REFRESH = new Set(["profile"]);

async function liveRefresh() {
    if (refreshing) return;
    refreshing = true;
    try {
        await loadData();
        const active = document.querySelector(".nav-item.active");
        const viewId = active?.dataset.view;
        if (viewId && !NO_LIVE_REFRESH.has(viewId)) rerenderCurrent();
    } catch (e) {
        console.warn("[live] refresh failed:", e);
    } finally {
        refreshing = false;
    }
}

// Many events can arrive at once (e.g. "ask update" touches several tasks),
// so wait a moment and refresh once.
function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(liveRefresh, 400);
}

export function startLiveUpdates() {
    if (liveStarted) return;
    liveStarted = true;

    supabase
        .channel("taskflow-live")
        .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, scheduleRefresh)
        .on("postgres_changes", { event: "*", schema: "public", table: "activity_log" }, scheduleRefresh)
        .subscribe((status) => {
            if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
                console.warn("[live] realtime unavailable, relying on polling");
            }
        });

    // Safety net: poll every 30s while the tab is visible, and refresh
    // when the user comes back to the tab.
    setInterval(() => {
        if (!document.hidden) scheduleRefresh();
    }, 30000);
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) scheduleRefresh();
    });
}

/**
 * Sets up the page shell for admin.html / employee.html.
 *
 * config = {
 *   role:          "admin" | "employee"  — anyone else is sent to login
 *   defaultView:   view id to open first
 *   titles:        { [viewId]: [title, subtitle] }
 *   topbarActions: { [viewId]: { label, onClick } }   (optional)
 *   render:        (viewId) => void      — draws a view
 *   updateNavCounts: () => void          — refreshes sidebar badges
 * }
 */
export function initShell(config) {
    const user = requireRole(config.role);
    if (!user) return null;

    shell = config;
    state.currentUser = user.id;

    refreshSidebarUser();
    makeSidebarUserClickable();

    document.getElementById("logout-btn").addEventListener("click", () => {
        confirmSignOut();
    });

    installBackGuard();

    // Signing out in another tab, or using the back button after logout
    window.addEventListener("pageshow", (e) => {
        if (e.persisted) requireRole(config.role);
    });

    /* mobile sidebar */
    const sidebar = document.getElementById("sidebar");
    const scrim = document.getElementById("sidebar-scrim");
    const menuBtn = document.getElementById("menu-btn");
    menuBtn.addEventListener("click", () => {
        sidebar.classList.toggle("open");
        scrim.classList.toggle("show");
    });
    scrim.addEventListener("click", closeSidebar);
    const checkMobile = () =>
        menuBtn.classList.toggle("hidden", window.innerWidth > 880);
    checkMobile();
    window.addEventListener("resize", checkMobile);

    /* nav */
    document.querySelectorAll(".nav-item").forEach((btn) => {
        btn.addEventListener("click", () => goView(btn.dataset.view));
    });

    
    initModals();
    goView(savedView() || config.defaultView);
    startLiveUpdates();
    return user;
}

export function closeSidebar() {
    document.getElementById("sidebar").classList.remove("open");
    document.getElementById("sidebar-scrim").classList.remove("show");
}

export function goView(viewId) {
    document
        .querySelectorAll(".view")
        .forEach((v) => v.classList.add("hidden"));
    document.getElementById("view-" + viewId).classList.remove("hidden");
    document
        .querySelectorAll(".nav-item")
        .forEach((b) => b.classList.toggle("active", b.dataset.view === viewId));

    document
        .querySelector(".sidebar-user")
        ?.classList.toggle("active", viewId === "profile");

    const [title, sub] = shell.titles[viewId] || EXTRA_VIEW_TITLES[viewId] || ["", ""];
    document.getElementById("topbar-title").textContent = title;
    document.getElementById("topbar-sub").textContent = sub;

    rememberView(viewId);
    renderTopbarActions(viewId);
    renderView(viewId);
    closeSidebar();
    window.scrollTo(0, 0);
}

export function renderTopbarActions(viewId) {
    const el = document.getElementById("topbar-actions");
    el.innerHTML = "";
    const action = shell.topbarActions?.[viewId];
    if (!action) return;
    const b = document.createElement("button");
    b.className = "btn btn-lime";
    b.textContent = action.label;
    b.onclick = action.onClick;
    el.appendChild(b);
}

export function renderView(viewId) {
    if (viewId === "profile") {
        mountProfile();
        return;
    }
    shell.render(viewId);
    shell.updateNavCounts();
}

export function rerenderCurrent() {
    const active = document.querySelector(".nav-item.active");
    if (active) renderView(active.dataset.view);
}

import { supabase } from './supabase.js';
import { mountProfile } from "./profile.js";

export async function initializeApp() {

    const db = await loadDatabase();

    state.users = db.users;
    state.teams = db.teams;
    state.tasks = db.tasks;
    state.projectManagers = db.projectManagers;
    state.departments = db.departments;
    state.activityLog = db.activityLog;

}

// export async function loadDatabase() {

//     const { data: users } =
//         await supabase.from('users').select('*');

//         const { data: teams } =
//         await supabase.from('teams').select('*');

//     const { data: projectManagers } =
//         await supabase.from('project_managers').select('*');

//     const { data: tasks } =
//     await supabase.from('tasks').select('*');

//     state.users = (users || []).map(u => ({
//         ...u,
//         pos: u.position,
//         teamId: u.team_id
//     }));

//     state.teams = (teams || []).map(t => ({
//         ...t,
//         member_ids: t.member_ids || []
//     }));

//     state.projectManagers = projectManagers || [];

//     state.tasks = (tasks || []).map(task => ({
//         ...task,
//         assigneeType: task.assignee_type,
//         assigneeId: task.assignee_id,
//         projectManagerId: task.project_manager_id,
//         updateRequested: task.update_requested
//     }));

//     console.log(users);
//     console.log(teams);
//     console.log(projectManagers);
//     console.log(tasks);
// }

await initializeApp();

export { state };