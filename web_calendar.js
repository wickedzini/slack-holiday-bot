const http = require("http");
const { URL } = require("url");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const PORT = Number(process.env.WEB_CALENDAR_PORT || 4000);
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

async function getTeamMembers() {
    const { data, error } = await supabase
        .from("team_members")
        .select("slack_user_id, employee_name")
        .eq("is_active", true)
        .order("employee_name", { ascending: true });

    if (error) {
        throw error;
    }

    return data || [];
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
        const memberRequests = approvedRequests.filter((request) => request.slack_user_id === member.slack_user_id);

        let usedWorkingDays = 0;
        for (const request of memberRequests) {
            const clipped = clipRequestToYear(request.start_date, request.end_date, currentYear);
            if (!clipped) {
                continue;
            }
            usedWorkingDays += calculateTimeOffStats(clipped.startDate, clipped.endDate).workingDays;
        }

        const color = colors[index % colors.length];
        memberColorMap.set(member.slack_user_id, color);

        memberSummaries.push({
            slack_user_id: member.slack_user_id,
            employee_name: member.employee_name,
            allowance: annualLeaveDays,
            used: usedWorkingDays,
            available: Math.max(annualLeaveDays - usedWorkingDays, 0),
            requestCount: memberRequests.length,
            requests: memberRequests.map((request) => ({
                ...request,
                totalDays: calculateTimeOffStats(request.start_date, request.end_date).totalDays,
                workingDays: calculateTimeOffStats(request.start_date, request.end_date).workingDays,
                monthLabel: monthLabel(request.start_date),
            })),
            color,
        });
    }

    const events = approvedRequests.map((request) => ({
        id: request.id,
        slackUserId: request.slack_user_id,
        employeeName: request.employee_name,
        start: request.start_date,
        end: request.end_date,
        reason: request.reason || "",
        monthLabel: monthLabel(request.start_date),
        totalDays: calculateTimeOffStats(request.start_date, request.end_date).totalDays,
        workingDays: calculateTimeOffStats(request.start_date, request.end_date).workingDays,
        color: memberColorMap.get(request.slack_user_id) || "#3E63DD",
    }));

    const totalUsedWorkingDays = memberSummaries.reduce((sum, member) => sum + member.used, 0);
    const totalAvailableWorkingDays = memberSummaries.reduce((sum, member) => sum + member.available, 0);

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
    return [
        '<!doctype html>',
        '<html lang="pl">',
        '<head>',
        '  <meta charset="utf-8" />',
        '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
        '  <title>Holiday Planner Calendar</title>',
        '  <style>',
        '    :root {',
        '      --bg: #F7F8FC;',
        '      --text: #071B52;',
        '      --muted: #6B7898;',
        '      --blue: #3E63DD;',
        '      --white: #FFFFFF;',
        '      --panel-soft: #EEF2FF;',
        '      --panel-mid: #E8EDFB;',
        '      --panel-strong: #E1E8FA;',
        '      --card-tint: #F3F6FF;',
        '      --border: rgba(7,27,82,0.08);',
        '      --shadow: none;',
        '      --radius-lg: 24px;',
        '      --radius-md: 18px;',
        '      --radius-sm: 14px;',
        '    }',
        '    * { box-sizing: border-box; }',
        '    body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }',
        '    .page { max-width: 1380px; margin: 0 auto; padding: 16px 16px 28px; }',
        '    .hero { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; gap: 12px; }',
        '    .hero h1 { margin: 0; font-size: 50px; line-height: 0.95; letter-spacing: -0.04em; font-weight: 900; }',
        '    .hero p { margin: 8px 0 0; font-size: 14px; color: var(--muted); font-weight: 600; }',
        '    .spark { font-size: 48px; line-height: 1; color: #4DC4C4; opacity: 0.9; }',
        '    .toolbar { display: grid; grid-template-columns: 1.15fr 1fr auto; gap: 10px; margin-bottom: 12px; }',
        '    .card { background: var(--white); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: none; }',
        '    .toolbar-card { padding: 10px 12px; background: rgba(255,255,255,0.72); }',
        '    .toolbar-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-bottom: 8px; font-weight: 800; }',
        '    .toolbar-controls { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }',
        '    select, button { font: inherit; }',
        '    select { width: 100%; border: 1px solid rgba(7,27,82,0.12); border-radius: 12px; padding: 12px 14px; background: white; color: var(--text); font-weight: 700; }',
        '    .chip-row { display: flex; flex-wrap: wrap; gap: 8px; max-height: 96px; overflow: auto; padding-right: 4px; }',
        '    .chip { border: 0; border-radius: 999px; padding: 7px 11px; font-size: 12px; font-weight: 800; color: var(--text); background: rgba(62,99,221,0.12); cursor: pointer; }',
        '    .chip.active { background: var(--blue); color: white; }',
        '    .btn { border: 0; background: var(--blue); color: white; padding: 10px 14px; border-radius: 12px; font-weight: 800; cursor: pointer; white-space: nowrap; }',
        '    .month-nav { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }',
        '    .month-nav-btn { border: 0; background: rgba(62,99,221,0.14); color: var(--text); width: 32px; height: 32px; border-radius: 999px; font-weight: 900; cursor: pointer; }',
        '    .month-tabs { display: flex; gap: 8px; flex-wrap: wrap; }',
        '    .month-tab { border: 0; border-radius: 999px; padding: 7px 12px; font-size: 12px; font-weight: 800; color: var(--text); background: rgba(255,255,255,0.78); cursor: pointer; }',
        '    .month-tab.active { background: var(--blue); color: white; }',
        '    .month-tab.all { background: rgba(62,99,221,0.08); }',
        '    .month-tab.all.active { background: var(--blue); color: white; }',
        '    .section-stack { display: grid; gap: 12px; }',
        '    .overview-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 18px; margin-bottom: 12px; padding: 2px 0 6px; }',
        '    .stat-card { padding: 12px 0; background: transparent; min-height: auto; border: 0; border-radius: 0; }',
        '    .stat-card.primary { grid-column: span 2; background: transparent; }',
        '    .eyebrow { color: var(--blue); font-weight: 900; font-size: 12px; margin-bottom: 10px; }',
        '    .metric { font-size: 36px; font-weight: 900; letter-spacing: -0.04em; margin: 0; line-height: 1; }',
        '    .metric.small { font-size: 28px; }',
        '    .subtext { margin-top: 8px; color: var(--muted); font-size: 13px; font-weight: 600; line-height: 1.35; }',
        '    .section-grid { display: grid; grid-template-columns: 1.62fr 0.88fr; gap: 12px; align-items: start; margin-bottom: 12px; }',
        '    .calendar-card { padding: 14px; background: linear-gradient(180deg, #F5F7FF 0%, #EDF2FF 100%); }',
        '    .section-title { margin: 0 0 4px; font-size: 24px; line-height: 1; letter-spacing: -0.03em; font-weight: 900; }',
        '    .section-subtitle { margin: 0 0 10px; color: #9AA5BF; font-size: 13px; font-weight: 700; }',
        '    .calendar-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; margin-bottom: 10px; }',
        '    .legend { display: flex; flex-wrap: wrap; gap: 8px; }',
        '    .legend-item { display: inline-flex; align-items: center; gap: 7px; padding: 5px 9px; border-radius: 999px; background: rgba(255,255,255,0.76); font-size: 11px; font-weight: 800; }',
        '    .swatch { width: 12px; height: 12px; border-radius: 999px; display: inline-block; flex: none; }',
        '    .calendar-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 6px; }',
        '    .weekday { padding: 4px 6px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); font-weight: 900; }',
        '    .day { min-height: 78px; background: rgba(255,255,255,0.88); border: 1px solid rgba(7,27,82,0.06); border-radius: 12px; padding: 7px; display: flex; flex-direction: column; gap: 5px; }',
        '    .day.empty { opacity: 0.35; background: rgba(255,255,255,0.45); }',
        '    .day-number { font-size: 13px; font-weight: 900; }',
        '    .leave-pill { border-radius: 9px; padding: 4px 7px; color: white; font-size: 10px; font-weight: 800; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
        '    .member-list-card { padding: 14px; background: #FFFFFF; max-height: 560px; overflow: auto; }',
        '    .member-grid { display: grid; gap: 12px; }',
        '    .member-card { padding: 12px 0 14px; border-radius: 0; background: transparent; border: 0; border-bottom: 1px solid rgba(7,27,82,0.08); }',
        '    .member-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; }',
        '    .member-name { font-size: 16px; font-weight: 900; margin: 0; }',
        '    .member-role { color: var(--muted); font-size: 12px; font-weight: 700; margin-top: 2px; }',
        '    .badge { padding: 5px 9px; border-radius: 999px; background: rgba(62,99,221,0.12); font-weight: 900; color: var(--blue); font-size: 10px; flex: none; }',
        '    .mini-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }',
        '    .mini-box { background: #F6F8FE; border-radius: 12px; padding: 9px; }',
        '    .mini-label { font-size: 11px; font-weight: 800; color: var(--muted); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.08em; }',
        '    .mini-value { font-size: 18px; font-weight: 900; line-height: 1; }',
        '    .table-card { padding: 14px; background: #FFFFFF; }',
        '    table { width: 100%; border-collapse: collapse; overflow: hidden; background: transparent; border-radius: 0; border: 0; }',
        '    thead th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); padding: 10px 8px 12px; border-bottom: 1px solid rgba(7,27,82,0.08); }',
        '    tbody td { padding: 12px 8px; border-bottom: 1px solid rgba(7,27,82,0.06); font-size: 14px; font-weight: 700; vertical-align: top; }',
        '    tbody tr:last-child td { border-bottom: 0; }',
        '    .muted { color: var(--muted); }',
        '    .empty-state { padding: 14px; border-radius: 14px; background: rgba(255,255,255,0.72); color: var(--muted); font-weight: 800; text-align: center; }',
        '    @media (max-width: 1200px) { .overview-grid { grid-template-columns: repeat(2, 1fr); } .stat-card.primary { grid-column: span 2; } .section-grid { grid-template-columns: 1fr; } .toolbar { grid-template-columns: 1fr; } }',
        '    @media (max-width: 760px) { .page { padding: 14px 10px 24px; } .hero h1 { font-size: 40px; } .overview-grid { grid-template-columns: 1fr; } .stat-card.primary { grid-column: span 1; } .calendar-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .mini-stats { grid-template-columns: 1fr; } .month-nav { width: 100%; } .month-tabs { width: calc(100% - 80px); overflow: auto; flex-wrap: nowrap; } table, thead, tbody, tr, th, td { display: block; } thead { display: none; } tbody td { padding: 10px 12px; } }',
        '  </style>',
        '</head>',
        '<body>',
        '  <div class="page">',
        '    <section class="hero">',
        '      <div>',
        '        <h1>Overview</h1>',
        '        <p>Visual team leave dashboard for managers</p>',
        '      </div>',
        '      <div class="spark">✦</div>',
        '    </section>',
        '    <section class="toolbar">',
        '      <div class="card toolbar-card"><div class="toolbar-label">View</div><div class="toolbar-controls"><div class="month-nav"><button class="month-nav-btn" id="prevMonthBtn" type="button">←</button><div class="month-tabs" id="monthTabs"></div><button class="month-nav-btn" id="nextMonthBtn" type="button">→</button></div></div></div>',
        '      <div class="card toolbar-card"><div class="toolbar-label">Filter people</div><div class="chip-row" id="memberChips"></div></div>',
        '      <div class="card toolbar-card"><div class="toolbar-label">Actions</div><div class="toolbar-controls"><button class="btn" id="resetFilters">Reset filters</button></div></div>',
        '    </section>',
        '    <section class="section-grid">',
        '      <div class="card calendar-card">',
        '        <div class="calendar-head">',
        '          <div><h2 class="section-title">Calendar</h2><p class="section-subtitle">Visual month view of all approved time off</p></div>',
        '          <div class="legend" id="legend"></div>',
        '        </div>',
        '        <div class="calendar-grid" id="calendarGrid"></div>',
        '      </div>',
        '      <div class="section-stack">',
        '        <div class="card member-list-card">',
        '          <h2 class="section-title">People</h2>',
        '          <p class="section-subtitle">Allowance and usage overview</p>',
        '          <div class="member-grid" id="memberCards"></div>',
        '        </div>',
        '      </div>',
        '    </section>',
        '    <section class="overview-grid" id="overviewCards"></section>',
        '    <section class="card table-card">',
        '      <h2 class="section-title">All approved time off</h2>',
        '      <p class="section-subtitle">Complete list with filters applied</p>',
        '      <div id="eventsTable"></div>',
        '    </section>',
        '  </div>',
        '  <script>',
        '    const state = { data: null, selectedMonth: null, selectedMembers: new Set() };',
        '    const weekdayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];',
        '    function uniqueMonths(events) {',
        '      const labels = Array.from(new Set(events.map(function (event) { return event.monthLabel; })));',
        '      const current = new Date();',
        '      const currentYear = current.getFullYear();',
        '      const fallbackYear = labels.length ? new Date(labels[0] + " 1").getFullYear() : currentYear;',
        '      const year = Number.isFinite(fallbackYear) ? fallbackYear : currentYear;',
        '      const allMonths = [];',
        '      for (let month = 0; month < 12; month += 1) {',
        '        allMonths.push(new Date(Date.UTC(year, month, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "Europe/Warsaw" }));',
        '      }',
        '      return allMonths;',
        '    }',
        '    function monthStartFromLabel(label) { const date = new Date(label + " 1"); return new Date(Date.UTC(date.getFullYear(), date.getMonth(), 1)); }',
        '    function getFilteredEvents() {',
        '      if (!state.data) return [];',
        '      return state.data.events.filter(function (event) {',
        '        const monthOk = !state.selectedMonth || event.monthLabel === state.selectedMonth;',
        '        const memberOk = state.selectedMembers.size === 0 || state.selectedMembers.has(event.slackUserId);',
        '        return monthOk && memberOk;',
        '      });',
        '    }',
        '    function getFilteredMembers() {',
        '      if (!state.data) return [];',
        '      if (state.selectedMembers.size === 0) return state.data.members;',
        '      return state.data.members.filter(function (member) { return state.selectedMembers.has(member.slack_user_id); });',
        '    }',
        '    function renderOverviewCards() {',
        '      const container = document.getElementById("overviewCards");',
        '      const events = getFilteredEvents();',
        '      const members = getFilteredMembers();',
        '      const used = members.reduce(function (sum, member) { return sum + member.used; }, 0);',
        '      const available = members.reduce(function (sum, member) { return sum + member.available; }, 0);',
        '      const requests = events.length;',
        '      const percentUsed = members.length ? Math.round((used / Math.max(used + available, 1)) * 100) : 0;',
        '      container.innerHTML = ',
        '        "<div class=\\"card stat-card primary\\"><div class=\\"eyebrow\\">• Total team members</div><p class=\\"metric\\">" + members.length + "</p><div class=\\"subtext\\">Active people visible in this view.</div></div>" +',
        '        "<div class=\\"card stat-card\\"><div class=\\"eyebrow\\">• Approved requests</div><p class=\\"metric small\\">" + requests + "</p><div class=\\"subtext\\">Total approved leave entries after filters.</div></div>" +',
        '        "<div class=\\"card stat-card\\"><div class=\\"eyebrow\\">• Used working days</div><p class=\\"metric small\\">" + used + "</p><div class=\\"subtext\\">Used in " + state.data.currentYear + ".</div></div>" +',
        '        "<div class=\\"card stat-card\\"><div class=\\"eyebrow\\">• Available working days</div><p class=\\"metric small\\">" + available + "</p><div class=\\"subtext\\">Still available this year.</div></div>" +',
        '        "<div class=\\"card stat-card\\"><div class=\\"eyebrow\\">• Utilization rate</div><p class=\\"metric small\\">" + percentUsed + "%</p><div class=\\"subtext\\">Used share of total visible allowance.</div></div>";',
        '    }',
        '    function renderMonthTabs() {',
        '      const container = document.getElementById("monthTabs");',
        '      const months = uniqueMonths(state.data.events);',
        '      if (typeof state.selectedMonth === "undefined") state.selectedMonth = null;',
        '      container.innerHTML = ["<button class=\\"month-tab all " + (!state.selectedMonth ? "active" : "") + "\\" data-month=\\"\\" type=\\"button\\">All</button>"].concat(months.map(function (month) {',
        '        return "<button class=\\"month-tab " + (month === state.selectedMonth ? "active" : "") + "\\" data-month=\\"" + month + "\\" type=\\"button\\">" + month + "</button>";',
        '      })).join("");',
        '      container.querySelectorAll(".month-tab").forEach(function (button) {',
        '        button.addEventListener("click", function () {',
        '          const value = button.getAttribute("data-month"); state.selectedMonth = value || null;',
        '          renderAll();',
        '        });',
        '      });',
        '      const prevBtn = document.getElementById("prevMonthBtn");',
        '      const nextBtn = document.getElementById("nextMonthBtn");',
        '      const currentIndex = state.selectedMonth ? months.indexOf(state.selectedMonth) : -1;',
        '      prevBtn.disabled = currentIndex <= 0;',
        '      nextBtn.disabled = currentIndex !== -1 && currentIndex >= months.length - 1;',
        '      prevBtn.style.opacity = prevBtn.disabled ? "0.45" : "1";',
        '      nextBtn.style.opacity = nextBtn.disabled ? "0.45" : "1";',
        '      prevBtn.onclick = function () {',
        '        if (currentIndex === -1) {',
        '          state.selectedMonth = months[months.length - 1] || null;',
        '          renderAll();',
        '          return;',
        '        }',
        '        if (currentIndex > 0) {',
        '          state.selectedMonth = months[currentIndex - 1];',
        '          renderAll();',
        '        }',
        '      };',
        '      nextBtn.onclick = function () {',
        '        if (currentIndex === -1) {',
        '          state.selectedMonth = months[0] || null;',
        '          renderAll();',
        '          return;',
        '        }',
        '        if (currentIndex < months.length - 1) {',
        '          state.selectedMonth = months[currentIndex + 1];',
        '          renderAll();',
        '        }',
        '      };',
        '    }',
        '    function renderMemberChips() {',
        '      const container = document.getElementById("memberChips");',
        '      container.innerHTML = state.data.members.map(function (member) {',
        '        return "<button class=\\"chip " + (state.selectedMembers.has(member.slack_user_id) ? "active" : "") + "\\" data-id=\\"" + member.slack_user_id + "\\" type=\\"button\\">" + member.employee_name + "</button>";',
        '      }).join("");',
        '      container.querySelectorAll(".chip").forEach(function (button) {',
        '        button.addEventListener("click", function () {',
        '          const id = button.getAttribute("data-id");',
        '          if (state.selectedMembers.has(id)) state.selectedMembers.delete(id); else state.selectedMembers.add(id);',
        '          renderAll();',
        '        });',
        '      });',
        '    }',
        '    function renderLegend() {',
        '      const container = document.getElementById("legend");',
        '      const members = getFilteredMembers().slice(0, 8);',
        '      container.innerHTML = members.map(function (member) {',
        '        return "<span class=\\"legend-item\\"><span class=\\"swatch\\" style=\\"background:" + member.color + "\\"></span>" + member.employee_name + "</span>";',
        '      }).join("");',
        '    }',
        '    function renderCalendar() {',
        '      const grid = document.getElementById("calendarGrid");',
        '      const events = getFilteredEvents();',
        '      if (!state.selectedMonth) { grid.innerHTML = "<div class=\\"empty-state\\">Choose a month above to see the calendar view.</div>"; return; }',
        '      const start = monthStartFromLabel(state.selectedMonth);',
        '      const month = start.getUTCMonth();',
        '      const year = start.getUTCFullYear();',
        '      const lastDay = new Date(Date.UTC(year, month + 1, 0));',
        '      const weekdayOffset = (start.getUTCDay() + 6) % 7;',
        '      const dayCells = [];',
        '      for (let i = 0; i < weekdayOffset; i += 1) { dayCells.push("<div class=\\"day empty\\"></div>"); }',
        '      for (let day = 1; day <= lastDay.getUTCDate(); day += 1) {',
        '        const date = new Date(Date.UTC(year, month, day));',
        '        const iso = date.toISOString().slice(0, 10);',
        '        const matching = events.filter(function (event) { return iso >= event.start && iso <= event.end; });',
        '        const pills = matching.slice(0, 2).map(function (event) {',
        '          return "<div class=\\"leave-pill\\" style=\\"background:" + event.color + "\\" title=\\"" + event.employeeName + ": " + event.start + " → " + event.end + "\\">" + event.employeeName + "</div>";',
        '        }).join("");',
        '        const more = matching.length > 2 ? "<div class=\\"muted\\" style=\\"font-size:11px;font-weight:800;\\\">+" + (matching.length - 2) + " more</div>" : "";',
        '        dayCells.push("<div class=\\"day\\"><div class=\\"day-number\\">" + String(day).padStart(2, "0") + "</div>" + (pills || "<div class=\\\\\\"muted\\\\\\" style=\\\\\\"font-size:12px;font-weight:700;\\\\\\">—</div>") + more + "</div>");',
        '      }',
        '      grid.innerHTML = weekdayLabels.map(function (label) { return "<div class=\\"weekday\\">" + label + "</div>"; }).join("") + dayCells.join("");',
        '    }',
        '    function renderMemberCards() {',
        '      const container = document.getElementById("memberCards");',
        '      const members = getFilteredMembers();',
        '      if (!members.length) { container.innerHTML = "<div class=\\"empty-state\\">No team members for current filter.</div>"; return; }',
        '      container.innerHTML = members.map(function (member, index) {',
        '        return "<div class=\\"member-card\\"><div class=\\"member-head\\"><div><h3 class=\\"member-name\\">" + (index + 1) + ". " + member.employee_name + "</h3><div class=\\"member-role\\">" + member.requestCount + " approved request(s)</div></div><span class=\\"badge\\">" + member.allowance + " allowance</span></div><div class=\\"mini-stats\\"><div class=\\"mini-box\\"><div class=\\"mini-label\\">Used</div><div class=\\"mini-value\\">" + member.used + "</div></div><div class=\\"mini-box\\"><div class=\\"mini-label\\">Available</div><div class=\\"mini-value\\">" + member.available + "</div></div><div class=\\"mini-box\\"><div class=\\"mini-label\\">Requests</div><div class=\\"mini-value\\">" + member.requestCount + "</div></div></div></div>";',
        '      }).join("");',
        '    }',
        '    function renderEventsTable() {',
        '      const container = document.getElementById("eventsTable");',
        '      const events = getFilteredEvents();',
        '      if (!events.length) { container.innerHTML = "<div class=\\"empty-state\\">No approved time off for selected filters.</div>"; return; }',
        '      container.innerHTML = "<table><thead><tr><th>Employee</th><th>Start</th><th>End</th><th>Duration</th><th>Month</th><th>Details</th></tr></thead><tbody>" +',
        '        events.map(function (event) {',
        '          return "<tr><td><strong>" + event.employeeName + "</strong></td><td>" + event.start + "</td><td>" + event.end + "</td><td>" + event.totalDays + " day(s) · " + event.workingDays + " working day(s)</td><td>" + event.monthLabel + "</td><td class=\\"muted\\">" + (event.reason || "No details") + "</td></tr>";',
        '        }).join("") + "</tbody></table>";',
        '    }',
        '    function renderAll() { renderMonthTabs(); renderMemberChips(); renderOverviewCards(); renderLegend(); renderCalendar(); renderMemberCards(); renderEventsTable(); }',
        '    async function boot() {',
        '      const response = await fetch("/api/dashboard-data");',
        '      const data = await response.json();',
        '      state.data = data;',
        '      state.selectedMonth = null;',
        '      document.getElementById("resetFilters").addEventListener("click", function () { state.selectedMembers = new Set(); renderAll(); });',
        '      renderAll();',
        '    }',
        '    boot().catch(function (error) { console.error(error); document.body.innerHTML = "<div style=\\"padding:40px;font-family:Inter,sans-serif;color:#071B52;\\">Could not load calendar dashboard.</div>"; });',
        '  </script>',
        '</body>',
        '</html>',
    ].join("\n");
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