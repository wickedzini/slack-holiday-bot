const http = require("http");
const { URL } = require("url");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const PORT = Number(process.env.PORT || process.env.WEB_CALENDAR_PORT || 4000);
const DEFAULT_ANNUAL_LEAVE_DAYS = 26;
const USER_ALLOWANCE_OVERRIDE_TABLE = "user_leave_allowances";

const POLISH_DATE_FORMAT = new Intl.DateTimeFormat("pl-PL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Warsaw",
});

function parseDateOnly(dateString) {
    const [year, month, day] = dateString.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day));
}

function addUtcDays(date, days) {
    const next = new Date(date.getTime());
    next.setUTCDate(next.getUTCDate() + days);
    return next;
}

function formatDateForStorage(date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function formatDate(dateString) {
    return POLISH_DATE_FORMAT.format(new Date(`${dateString}T12:00:00Z`));
}

function monthLabel(dateString) {
    return new Date(`${dateString}T12:00:00Z`).toLocaleDateString("en-US", {
        month: "long",
        year: "numeric",
        timeZone: "Europe/Warsaw",
    });
}

function getEasterSunday(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(Date.UTC(year, month - 1, day));
}

function getPolishPublicHolidaySet(year) {
    const easterSunday = getEasterSunday(year);
    const easterMonday = addUtcDays(easterSunday, 1);
    const corpusChristi = addUtcDays(easterSunday, 60);

    return new Set([
        `${year}-01-01`,
        `${year}-01-06`,
        `${year}-05-01`,
        `${year}-05-03`,
        formatDateForStorage(easterMonday),
        formatDateForStorage(corpusChristi),
        `${year}-08-15`,
        `${year}-11-01`,
        `${year}-11-11`,
        `${year}-12-25`,
        `${year}-12-26`,
    ]);
}

function calculateTimeOffStats(startDateString, endDateString) {
    const start = parseDateOnly(startDateString);
    const end = parseDateOnly(endDateString);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
        return { totalDays: 0, workingDays: 0 };
    }

    const holidaySets = new Map();
    let totalDays = 0;
    let workingDays = 0;

    for (let current = new Date(start.getTime()); current <= end; current = addUtcDays(current, 1)) {
        totalDays += 1;
        const year = current.getUTCFullYear();
        if (!holidaySets.has(year)) {
            holidaySets.set(year, getPolishPublicHolidaySet(year));
        }

        const iso = formatDateForStorage(current);
        const dayOfWeek = current.getUTCDay();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
        const isHoliday = holidaySets.get(year).has(iso);

        if (!isWeekend && !isHoliday) {
            workingDays += 1;
        }
    }

    return { totalDays, workingDays };
}

function clipRequestToYear(startDateString, endDateString, year) {
    const requestStart = parseDateOnly(startDateString);
    const requestEnd = parseDateOnly(endDateString);
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const yearEnd = new Date(Date.UTC(year, 11, 31));

    const start = requestStart > yearStart ? requestStart : yearStart;
    const end = requestEnd < yearEnd ? requestEnd : yearEnd;

    if (end < start) {
        return null;
    }

    return {
        startDate: formatDateForStorage(start),
        endDate: formatDateForStorage(end),
    };
}

async function getAnnualLeaveDaysLimit() {
    const { data, error } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", "annual_leave_days")
        .maybeSingle();

    if (error) {
        console.error("Failed to load annual leave days:", error);
        return DEFAULT_ANNUAL_LEAVE_DAYS;
    }

    const parsed = Number(data?.value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ANNUAL_LEAVE_DAYS;
}

async function getUserAnnualLeaveAllowance(slackUserId, year) {
    const { data, error } = await supabase
        .from(USER_ALLOWANCE_OVERRIDE_TABLE)
        .select("annual_days")
        .eq("slack_user_id", slackUserId)
        .eq("year", year)
        .maybeSingle();

    if (error) {
        console.error("Failed to load user allowance override:", error);
        return null;
    }

    return data ? Number(data.annual_days) : null;
}

// In-memory cache so we don't hammer Slack on every page load
const avatarCache = new Map();

async function fetchSlackAvatarUrl(slackUserId) {
    if (avatarCache.has(slackUserId)) return avatarCache.get(slackUserId);
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
        console.log(`[avatar] SLACK_BOT_TOKEN not set — skipping Slack fetch for ${slackUserId}`);
        return null;
    }
    try {
        console.log(`[avatar] Fetching from Slack API for user ${slackUserId}`);
        const res = await fetch(
            `https://slack.com/api/users.info?user=${encodeURIComponent(slackUserId)}`,
            { headers: { Authorization: `Bearer ${token}` } },
        );
        const json = await res.json();
        if (!json.ok) {
            console.log(`[avatar] Slack API error for ${slackUserId}: ${json.error}`);
            avatarCache.set(slackUserId, null);
            return null;
        }
        const url = json.user?.profile?.image_48 || json.user?.profile?.image_72 || null;
        console.log(`[avatar] ${slackUserId} → ${url ? url : "no image found in profile"}`);
        avatarCache.set(slackUserId, url);
        return url;
    } catch (err) {
        console.log(`[avatar] Exception fetching avatar for ${slackUserId}: ${err.message}`);
        avatarCache.set(slackUserId, null);
        return null;
    }
}

async function getTeamMembers() {
    const { data, error } = await supabase
        .from("team_members")
        .select("slack_user_id, employee_name, avatar_url")
        .eq("is_active", true)
        .order("employee_name", { ascending: true });

    if (error) {
        // Fallback if avatar_url column doesn't exist yet
        if (error.code === "42703") {
            const fallback = await supabase
                .from("team_members")
                .select("slack_user_id, employee_name")
                .eq("is_active", true)
                .order("employee_name", { ascending: true });
            if (fallback.error) throw fallback.error;
            return (fallback.data || []).map((m) => ({ ...m, avatar_url: null }));
        }
        throw error;
    }

    const members = data || [];
    // Fill missing avatar_urls live from Slack API (cached per process lifetime)
    if (process.env.SLACK_BOT_TOKEN) {
        const missing = members.filter((m) => !m.avatar_url);
        console.log(`[avatar] ${members.length} members total, ${missing.length} missing avatar_url in DB`);
        await Promise.all(
            missing.map(async (m) => {
                m.avatar_url = await fetchSlackAvatarUrl(m.slack_user_id);
            }),
        );
    } else {
        console.log("[avatar] SLACK_BOT_TOKEN not set — avatars will fall back to initials");
    }
    return members;
}

async function getApprovedRequests() {
    const { data, error } = await supabase
        .from("time_off_requests")
        .select("id, slack_user_id, employee_name, start_date, end_date, reason, status, created_at")
        .eq("status", "approved")
        .order("start_date", { ascending: true });

    if (error) {
        throw error;
    }

    return data || [];
}

async function buildDashboardData() {
    const currentYear = new Date().getFullYear();
    const [globalAnnualLeaveDays, teamMembers, approvedRequests] = await Promise.all([
        getAnnualLeaveDaysLimit(),
        getTeamMembers(),
        getApprovedRequests(),
    ]);

    const colors = [
        "#3E63DD",
        "#7C9EF4",
        "#91C8FF",
        "#8D8AF8",
        "#53C3C5",
        "#4F6BED",
        "#A6BFFF",
        "#6E83FA",
        "#6AD3D1",
        "#9CB2F7",
    ];

    const memberSummaries = [];
    const memberColorMap = new Map();

    for (const [index, member] of teamMembers.entries()) {
        const allowanceOverride = await getUserAnnualLeaveAllowance(member.slack_user_id, currentYear);
        const annualLeaveDays = allowanceOverride ?? globalAnnualLeaveDays;
        const memberRequests = approvedRequests.filter((r) => r.slack_user_id === member.slack_user_id);

        let usedWorkingDays = 0;
        for (const request of memberRequests) {
            const clipped = clipRequestToYear(request.start_date, request.end_date, currentYear);
            if (!clipped) continue;
            usedWorkingDays += calculateTimeOffStats(clipped.startDate, clipped.endDate).workingDays;
        }

        const color = colors[index % colors.length];
        memberColorMap.set(member.slack_user_id, color);

        memberSummaries.push({
            slack_user_id: member.slack_user_id,
            employee_name: member.employee_name,
            avatar_url: member.avatar_url || null,
            allowance: annualLeaveDays,
            used: usedWorkingDays,
            available: Math.max(annualLeaveDays - usedWorkingDays, 0),
            requestCount: memberRequests.length,
            requests: memberRequests.map((r) => ({
                ...r,
                totalDays: calculateTimeOffStats(r.start_date, r.end_date).totalDays,
                workingDays: calculateTimeOffStats(r.start_date, r.end_date).workingDays,
                monthLabel: monthLabel(r.start_date),
            })),
            color,
        });
    }

    const events = approvedRequests.map((r) => ({
        id: r.id,
        slackUserId: r.slack_user_id,
        employeeName: r.employee_name,
        start: r.start_date,
        end: r.end_date,
        reason: r.reason || "",
        monthLabel: monthLabel(r.start_date),
        totalDays: calculateTimeOffStats(r.start_date, r.end_date).totalDays,
        workingDays: calculateTimeOffStats(r.start_date, r.end_date).workingDays,
        color: memberColorMap.get(r.slack_user_id) || "#3E63DD",
    }));

    const totalUsedWorkingDays = memberSummaries.reduce((sum, m) => sum + m.used, 0);
    const totalAvailableWorkingDays = memberSummaries.reduce((sum, m) => sum + m.available, 0);

    return {
        generatedAt: new Date().toISOString(),
        currentYear,
        totals: {
            teamMembers: memberSummaries.length,
            approvedRequests: events.length,
            usedWorkingDays: totalUsedWorkingDays,
            availableWorkingDays: totalAvailableWorkingDays,
            annualAllowance: globalAnnualLeaveDays,
        },
        members: memberSummaries,
        events,
    };
}

function renderHtml() {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Team Leave</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #F5F5F5; color: #111; -webkit-font-smoothing: antialiased; }
    .page { max-width: 1440px; margin: 0 auto; padding: 28px 24px 56px; display: flex; flex-direction: column; gap: 12px; }

    .header { display: flex; align-items: baseline; gap: 12px; padding-bottom: 4px; }
    .header-title { font-size: 18px; font-weight: 700; letter-spacing: -0.02em; }
    .header-sub { font-size: 12px; color: #999; font-weight: 500; }

    .filter-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .chip { border: 1px solid #E0E0E0; border-radius: 999px; padding: 5px 12px; font-size: 12px; font-weight: 600; color: #333; background: #fff; cursor: pointer; line-height: 1; font-family: inherit; }
    .chip:hover { border-color: #bbb; }
    .chip.active { border-color: #111; background: #111; color: #fff; }
    .btn-ghost { border: 1px solid #E0E0E0; background: transparent; color: #999; padding: 5px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit; margin-left: auto; }
    .btn-ghost:hover { border-color: #bbb; color: #555; }

    .card { background: #fff; border: 1px solid #E8E8E8; border-radius: 16px; overflow: hidden; }
    .card-hd { padding: 16px 20px 14px; display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .card-title { font-size: 13px; font-weight: 700; letter-spacing: -0.01em; }
    .card-sub { font-size: 11px; color: #999; margin-top: 2px; font-weight: 500; }
    .btn-sm { border: 1px solid #E0E0E0; background: #fff; color: #333; padding: 6px 12px; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit; white-space: nowrap; }
    .btn-sm:hover { background: #F5F5F5; }

    /* ── Timeline table (table = reliable sticky columns) ── */
    .timeline-wrap { overflow-x: auto; overflow-y: visible; }
    /* table-layout: fixed + <colgroup> = correct column widths regardless of row structure */
    .tl-table { border-collapse: collapse; table-layout: fixed; border-top: 1px solid #EBEBEB; border-left: 1px solid #EBEBEB; }
    .tl-table th, .tl-table td { padding: 0; border-right: 1px solid #EBEBEB; border-bottom: 1px solid #EBEBEB; }
    .tl-name { position: sticky; left: 0; z-index: 2; background: #fff; }
    .tl-month-corner { background: #F8F8F8 !important; height: 22px; z-index: 3 !important; }
    .tl-month-th { background: #F8F8F8; height: 22px; font-size: 10px; font-weight: 700; color: #555; text-transform: uppercase; letter-spacing: 0.07em; padding: 0 8px !important; white-space: nowrap; overflow: hidden; text-align: left; vertical-align: middle; }
    .tl-month-sep { border-right: 2px solid #999 !important; }
    .tl-day-th { height: 40px; text-align: center; vertical-align: middle; }
    .tl-day-th.weekend { background: #FAFAFA; }
    .tl-day-th.today { background: #EEF3FF; }
    .tl-day-th.today .tl-dow { color: #2563EB; opacity: 0.6; }
    .tl-day-th.today .tl-day { color: #2563EB; font-weight: 800; }
    .tl-day-th.month-start { border-left: 2px solid #999 !important; }
    .tl-dow { display: block; font-size: 8px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #ccc; line-height: 1; }
    .tl-day { display: block; font-size: 11px; font-weight: 600; color: #aaa; line-height: 1.5; }
    .tl-name-inner { display: flex; align-items: center; gap: 8px; padding: 0 12px; height: 40px; }
    .tl-team-label { height: 40px; vertical-align: middle; }
    .tl-cell { height: 40px; position: relative; }
    .tl-cell.weekend { background: #FAFAFA; }
    .tl-cell.leave { background: #EEF3FF; }
    .tl-cell.leave::after { content: ""; position: absolute; left: 3px; right: 3px; top: 50%; height: 12px; transform: translateY(-50%); border-radius: 999px; background: #BFCFFA; }
    .tl-cell.today { box-shadow: inset 2px 0 0 #2563EB, inset -2px 0 0 #2563EB; }
    .tl-cell.month-start { border-left: 2px solid #999 !important; }
    .av { width: 24px; height: 24px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; color: #fff; font-size: 8px; font-weight: 800; flex: none; }
    .av-img { width: 24px; height: 24px; border-radius: 50%; object-fit: cover; flex: none; display: block; }
    .pname { font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #222; }

    /* ── Stats ── */
    .stats-row { display: grid; grid-template-columns: repeat(5, 1fr); }
    .stat-box { padding: 16px 20px; border-right: 1px solid #E8E8E8; }
    .stat-box:last-child { border-right: 0; }
    .stat-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; color: #aaa; margin-bottom: 6px; }
    .stat-value { font-size: 24px; font-weight: 800; letter-spacing: -0.04em; line-height: 1; color: #111; }
    .stat-desc { font-size: 11px; color: #bbb; margin-top: 3px; font-weight: 500; }

    /* ── Events grouped by month ── */
    .evt-count { background: #F0F0F0; border-radius: 999px; padding: 1px 7px; font-size: 10px; font-weight: 700; color: #888; margin-left: 4px; }
    table.evt-table { width: 100%; border-collapse: collapse; }
    table.evt-table thead th { text-align: left; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em; color: #ccc; padding: 12px 20px 10px; border-bottom: 1px solid #F0F0F0; }
    table.evt-table tbody td { padding: 10px 20px; border-top: 1px solid #F7F7F7; font-size: 13px; font-weight: 500; color: #333; }
    table.evt-table .evt-month-row td { background: #FAFAFA; padding: 6px 20px; font-size: 10px; font-weight: 700; color: #999; text-transform: uppercase; letter-spacing: 0.07em; border-top: 1px solid #EBEBEB; }
    .empty { padding: 32px 20px; text-align: center; color: #bbb; font-size: 13px; }

    /* ── People balances ── */
    .p-row { display: grid; grid-template-columns: 200px 1fr 120px; align-items: center; gap: 16px; padding: 12px 20px; border-bottom: 1px solid #F7F7F7; }
    .p-row:last-child { border-bottom: 0; }
    .p-identity { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .p-name { font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .p-bar-wrap { display: flex; align-items: center; gap: 10px; }
    .p-bar-track { flex: 1; height: 5px; background: #F0F0F0; border-radius: 999px; overflow: hidden; }
    .p-bar-fill { height: 100%; background: #2563EB; border-radius: 999px; transition: width 0.4s; }
    .p-nums { text-align: right; white-space: nowrap; }
    .p-used { font-size: 13px; font-weight: 700; color: #111; }
    .p-total { font-size: 12px; color: #bbb; font-weight: 500; }
    .p-avail { font-size: 11px; color: #aaa; margin-top: 1px; }

    @media (max-width: 900px) { .stats-row { grid-template-columns: repeat(2, 1fr); } .stat-box { border-bottom: 1px solid #E8E8E8; } .p-row { grid-template-columns: 160px 1fr 90px; gap: 10px; } }
    @media (max-width: 500px) { .page { padding: 16px 12px 40px; } .stats-row { grid-template-columns: 1fr; } .p-row { grid-template-columns: 1fr auto; } .p-bar-wrap { display: none; } }
  </style>
</head>
<body>
  <div class="page">
    <div class="header">
      <span class="header-title" id="headerTitle">Team Leave</span>
      <span class="header-sub" id="headerSub">Loading…</span>
    </div>

    <div class="filter-bar">
      <div id="memberChips" style="display:contents"></div>
      <button class="btn-ghost" id="resetFilters">Reset</button>
    </div>

    <div class="card">
      <div class="card-hd">
        <div><div class="card-title">Team Timeline</div><div class="card-sub">Full year · scroll horizontally · avatars stay pinned</div></div>
        <button class="btn-sm" id="jumpToday">Jump to Today</button>
      </div>
      <div class="timeline-wrap"><div id="timelineGrid"></div></div>
    </div>

    <div class="card stats-row" id="statsRow"></div>

    <div class="card" id="leaveCard">
      <div class="card-hd" style="border-bottom:1px solid #F0F0F0">
        <div><div class="card-title">All approved leave</div><div class="card-sub">Grouped by month · empty months hidden</div></div>
      </div>
      <div id="eventsTable"></div>
    </div>

    <div class="card" id="balancesCard">
      <div class="card-hd" style="border-bottom:1px solid #F0F0F0">
        <div><div class="card-title">Leave balances</div><div class="card-sub">Days used vs allowance per person</div></div>
      </div>
      <div id="peopleSection"></div>
    </div>
  </div>
  <script>
    var state = { data: null, selectedMembers: new Set() };

    function getFilteredEvents() {
      if (!state.data) return [];
      return state.data.events.filter(function (e) {
        return state.selectedMembers.size === 0 || state.selectedMembers.has(e.slackUserId);
      });
    }

    function getFilteredMembers() {
      if (!state.data) return [];
      if (state.selectedMembers.size === 0) return state.data.members;
      return state.data.members.filter(function (m) { return state.selectedMembers.has(m.slack_user_id); });
    }

    function fmtDate(iso) {
      var p = iso.split("-");
      return p[2] + "." + p[1] + "." + p[0];
    }

    function avatarHtml(member, cls) {
      var initials = member.employee_name.split(/\s+/).map(function (p) { return p[0] || ""; }).join("").slice(0, 2).toUpperCase();
      return member.avatar_url
        ? '<img src="' + member.avatar_url + '" class="' + (cls || "av-img") + '" alt="' + member.employee_name + '">'
        : '<span class="' + (cls ? cls.replace("av-img", "av") : "av") + '" style="background:' + member.color + '">' + initials + '</span>';
    }

    function renderStats() {
      var container = document.getElementById("statsRow");
      var members = getFilteredMembers();
      var events = getFilteredEvents();
      var used = members.reduce(function (s, m) { return s + m.used; }, 0);
      var available = members.reduce(function (s, m) { return s + m.available; }, 0);
      var pct = members.length ? Math.round(used / Math.max(used + available, 1) * 100) : 0;
      function sb(label, value, desc) {
        return '<div class="stat-box"><div class="stat-label">' + label + '</div><div class="stat-value">' + value + '</div><div class="stat-desc">' + desc + '</div></div>';
      }
      container.innerHTML =
        sb("Members", members.length, "active") +
        sb("Requests", events.length, "approved") +
        sb("Used", used, "working days") +
        sb("Available", available, "working days") +
        sb("Utilization", pct + "%", "of allowance");
    }

    function renderMemberChips() {
      var container = document.getElementById("memberChips");
      if (!state.data) return;
      container.innerHTML = state.data.members.map(function (m) {
        return '<button class="chip ' + (state.selectedMembers.has(m.slack_user_id) ? "active" : "") + '" data-id="' + m.slack_user_id + '">' + m.employee_name + '</button>';
      }).join("");
      container.querySelectorAll(".chip").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var id = btn.getAttribute("data-id");
          if (state.selectedMembers.has(id)) state.selectedMembers.delete(id); else state.selectedMembers.add(id);
          renderAll();
        });
      });
    }

    function jumpToToday() {
      var wrap = document.querySelector(".timeline-wrap");
      var el = document.getElementById("timeline-today");
      if (!wrap || !el) return;
      var wrapRect = wrap.getBoundingClientRect();
      var elRect = el.getBoundingClientRect();
      var target = wrap.scrollLeft + elRect.left - wrapRect.left - wrapRect.width / 2 + elRect.width / 2;
      wrap.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
    }

    function renderTimeline() {
      var container = document.getElementById("timelineGrid");
      var members = getFilteredMembers();
      if (!state.data) return;
      var year = state.data.currentYear;
      var todayIso = new Date().toISOString().slice(0, 10);
      var dowNames = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

      var monthsData = [];
      var totalDays = 0;
      for (var m = 0; m < 12; m += 1) {
        var daysInMonth = new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
        var monthName = new Date(Date.UTC(year, m, 1)).toLocaleDateString("en-US", { month: "long", timeZone: "Europe/Warsaw" });
        var days = [];
        for (var d = 1; d <= daysInMonth; d += 1) {
          var dateObj = new Date(Date.UTC(year, m, d));
          var iso = year + "-" + String(m + 1).padStart(2, "0") + "-" + String(d).padStart(2, "0");
          days.push({ iso: iso, day: d, dow: dateObj.getUTCDay() });
          totalDays += 1;
        }
        monthsData.push({ name: monthName, days: days });
      }

      // Build as <table> — sticky first column is reliable in tables across all browsers.
      // <colgroup> is required so table-layout:fixed actually uses our widths
      // (widths on cells in row 2+ are ignored in fixed layout; row 1 uses colspan so no individual widths).
      var COL_W = 50; // px per day — table-layout:fixed needs explicit table width to not shrink
      var NAME_W = 190;
      var tableW = NAME_W + totalDays * COL_W;
      var html = '<table class="tl-table" style="width:' + tableW + 'px">';
      html += '<colgroup><col style="width:' + NAME_W + 'px"><col span="' + totalDays + '" style="width:' + COL_W + 'px"></colgroup>';

      // Row 1: month labels with colspan
      html += '<thead><tr>';
      html += '<th class="tl-name tl-month-corner"></th>';
      monthsData.forEach(function (month, mi) {
        var isLast = mi === monthsData.length - 1;
        html += '<th class="tl-month-th' + (isLast ? '' : ' tl-month-sep') + '" colspan="' + month.days.length + '">' + month.name + '</th>';
      });
      html += '</tr>';

      // Row 2: day + weekday headers
      html += '<tr>';
      html += '<th class="tl-name tl-team-label"><div class="tl-name-inner"><span style="font-size:10px;font-weight:700;color:#aaa">Team</span></div></th>';
      monthsData.forEach(function (month, mi) {
        month.days.forEach(function (d, di) {
          var isWeekend = d.dow === 0 || d.dow === 6;
          var isToday = d.iso === todayIso;
          var isMonthStart = mi > 0 && di === 0;
          var cls = "tl-day-col tl-day-th" + (isToday ? " today" : "") + (isWeekend ? " weekend" : "") + (isMonthStart ? " month-start" : "");
          html += '<th class="' + cls + '"' + (isToday ? ' id="timeline-today"' : '') + '>';
          html += '<span class="tl-dow">' + dowNames[d.dow] + '</span><span class="tl-day">' + d.day + '</span>';
          html += '</th>';
        });
      });
      html += '</tr></thead>';

      // Member rows
      html += '<tbody>';
      members.forEach(function (member) {
        html += '<tr>';
        html += '<td class="tl-name"><div class="tl-name-inner">' + avatarHtml(member, "av-img") + '<span class="pname">' + member.employee_name + '</span></div></td>';
        monthsData.forEach(function (month, mi) {
          month.days.forEach(function (d, di) {
            var onLeave = member.requests.some(function (req) { return d.iso >= req.start_date && d.iso <= req.end_date; });
            var isWeekend = d.dow === 0 || d.dow === 6;
            var isToday = d.iso === todayIso;
            var isMonthStart = mi > 0 && di === 0;
            var cls = "tl-day-col tl-cell" + (onLeave ? " leave" : "") + (isToday ? " today" : "") + (isWeekend ? " weekend" : "") + (isMonthStart ? " month-start" : "");
            html += '<td class="' + cls + '" title="' + member.employee_name + ' \u00b7 ' + d.iso + '"></td>';
          });
        });
        html += '</tr>';
      });
      html += '</tbody></table>';

      container.innerHTML = html;
    }

    function renderEventsTable() {
      var container = document.getElementById("eventsTable");
      var events = getFilteredEvents();
      if (!events.length) {
        container.innerHTML = '<div class="empty">No approved leave for the selected filters.</div>';
        return;
      }
      var groups = {};
      var order = [];
      events.forEach(function (e) {
        var key = e.start.slice(0, 7);
        if (!groups[key]) { groups[key] = []; order.push(key); }
        groups[key].push(e);
      });
      var todayKey = new Date().toISOString().slice(0, 7);
      // Single table — header once at top, month separator rows between groups
      var html = '<table class="evt-table"><thead><tr><th>Employee</th><th>Dates</th><th>Days (working)</th><th>Reason</th></tr></thead><tbody>';
      order.forEach(function (key) {
        var grp = groups[key];
        var label = key === todayKey
          ? "This month"
          : new Date(key + "-01T12:00:00Z").toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "Europe/Warsaw" });
        html += '<tr class="evt-month-row"><td colspan="4">' + label + '<span class="evt-count">' + grp.length + '</span></td></tr>';
        grp.forEach(function (e) {
          html += '<tr><td><strong style="color:#111;font-weight:700">' + e.employeeName + '</strong></td>' +
            '<td>' + fmtDate(e.start) + ' \u2192 ' + fmtDate(e.end) + '</td>' +
            '<td>' + e.totalDays + ' (' + e.workingDays + ')</td>' +
            '<td style="color:#bbb">' + (e.reason || '\u2014') + '</td></tr>';
        });
      });
      html += '</tbody></table>';
      container.innerHTML = html;
    }

    function renderPeopleSection() {
      var container = document.getElementById("peopleSection");
      var members = getFilteredMembers();
      if (!members.length) { container.innerHTML = '<div class="empty">No members.</div>'; return; }
      container.innerHTML = members.map(function (m) {
        var pct = Math.min(Math.round(m.used / Math.max(m.allowance, 1) * 100), 100);
        return '<div class="p-row">' +
          '<div class="p-identity">' + avatarHtml(m, "av-img") + '<span class="p-name">' + m.employee_name + '</span></div>' +
          '<div class="p-bar-wrap"><div class="p-bar-track"><div class="p-bar-fill" style="width:' + pct + '%"></div></div></div>' +
          '<div class="p-nums"><div class="p-used">' + m.used + ' <span class="p-total">/ ' + m.allowance + ' days</span></div><div class="p-avail">' + m.available + ' remaining</div></div>' +
          '</div>';
      }).join("");
    }

    function renderAll() {
      renderMemberChips();
      renderStats();
      renderTimeline();
      renderEventsTable();
      renderPeopleSection();
    }

    async function boot() {
      var response = await fetch("/api/dashboard-data");
      var data = await response.json();
      state.data = data;
      document.getElementById("headerTitle").textContent = "Team Leave \u00b7 " + data.currentYear;
      document.getElementById("headerSub").textContent = data.members.length + " members";
      document.getElementById("resetFilters").addEventListener("click", function () { state.selectedMembers = new Set(); renderAll(); });
      document.getElementById("jumpToday").addEventListener("click", jumpToToday);
      renderAll();
      window.requestAnimationFrame(jumpToToday);
    }

    boot().catch(function (err) {
      console.error(err);
      document.body.innerHTML = '<div style="padding:48px;font-family:Inter,sans-serif;color:#111">Could not load dashboard.</div>';
    });
  </script>
</body>
</html>`;
}

async function handleApiDashboardData(res) {
    try {
        const payload = await buildDashboardData();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(payload));
    } catch (error) {
        console.error("Dashboard API failed:", error);
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Could not load dashboard data." }));
    }
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/api/dashboard-data") {
        await handleApiDashboardData(res);
        return;
    }

    if (url.pathname === "/" || url.pathname === "/calendar") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderHtml());
        return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
});

server.listen(PORT, () => {
    console.log(`🌴 Web calendar running on http://localhost:${PORT}`);
});
