const { App } = require("@slack/bolt");
const { createClient } = require("@supabase/supabase-js");

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
});

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const MANAGER_IDS_KEY = "manager_user_ids";
const ANNUAL_LEAVE_DAYS_KEY = "annual_leave_days";
const DEFAULT_ANNUAL_LEAVE_DAYS = 26;
const USER_ALLOWANCE_OVERRIDE_TABLE = "user_leave_allowances";

const HOME_VIEW_KEY_PREFIX = "home_view_";
const HOME_VIEW_USER = "user";
const HOME_VIEW_MANAGER = "manager";

const POLISH_MONTH_FORMAT = new Intl.DateTimeFormat("pl-PL", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Warsaw",
});

const POLISH_WEEKDAY_FORMAT = new Intl.DateTimeFormat("pl-PL", {
    weekday: "long",
    timeZone: "Europe/Warsaw",
});

function parseDateOnly(dateString) {
    const [year, month, day] = dateString.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day));
}

function formatDateForStorage(date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function addUtcDays(date, days) {
    const next = new Date(date.getTime());
    next.setUTCDate(next.getUTCDate() + days);
    return next;
}

function formatDate(dateString) {
    return POLISH_MONTH_FORMAT.format(new Date(`${dateString}T12:00:00Z`));
}

function capitalizeFirstLetter(value) {
    if (!value) {
        return value;
    }
    return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatDateWithWeekday(dateString) {
    const date = new Date(`${dateString}T12:00:00Z`);
    const formattedDate = formatDate(dateString);
    const weekday = capitalizeFirstLetter(POLISH_WEEKDAY_FORMAT.format(date));
    return `${formattedDate} (${weekday})`;
}

function monthLabel(dateString) {
    return new Date(`${dateString}T12:00:00Z`).toLocaleDateString("en-US", {
        month: "long",
        year: "numeric",
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

function getPolishPublicHolidayEntries(year) {
    const easterSunday = getEasterSunday(year);
    const easterMonday = addUtcDays(easterSunday, 1);
    const corpusChristi = addUtcDays(easterSunday, 60);

    return [
        { date: `${year}-01-01`, name: "Nowy Rok" },
        { date: `${year}-01-06`, name: "Trzech Króli" },
        { date: `${year}-05-01`, name: "Święto Pracy" },
        { date: `${year}-05-03`, name: "Święto Konstytucji 3 Maja" },
        { date: formatDateForStorage(easterMonday), name: "Poniedziałek Wielkanocny" },
        { date: formatDateForStorage(corpusChristi), name: "Boże Ciało" },
        { date: `${year}-08-15`, name: "Wniebowzięcie Najświętszej Maryi Panny" },
        { date: `${year}-11-01`, name: "Wszystkich Świętych" },
        { date: `${year}-11-11`, name: "Narodowe Święto Niepodległości" },
        { date: `${year}-12-25`, name: "Boże Narodzenie (pierwszy dzień)" },
        { date: `${year}-12-26`, name: "Boże Narodzenie (drugi dzień)" },
    ].sort((a, b) => a.date.localeCompare(b.date));
}

function buildHolidayListText(year) {
    const entries = getPolishPublicHolidayEntries(year);
    const lines = entries.map((entry) => `• ${formatDateWithWeekday(entry.date)} — ${entry.name}`);
    return `*Polish public holidays ${year}*\n\n${lines.join("\n")}`;
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

function buildDurationText(startDateString, endDateString) {
    const { totalDays, workingDays } = calculateTimeOffStats(startDateString, endDateString);
    return `${totalDays} day(s) · ${workingDays} working day(s)`;
}

function buildReadableStatusMessage(emoji, title, employeeName, startDate, endDate, reason = "") {
    const reasonLine = reason && reason.trim() ? `\n📝 ${reason.trim()}` : "";
    return `${emoji} *${title}*\n\n👤 *${employeeName}*\n📅 ${formatDateWithWeekday(startDate)} → ${formatDateWithWeekday(endDate)}\n⏳ ${buildDurationText(startDate, endDate)}${reasonLine}`;
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

function buildUpcomingGroupedText(rows) {
    if (!rows.length) {
        return "No approved upcoming time off.";
    }

    const grouped = rows.reduce((acc, row) => {
        const label = monthLabel(row.start_date);
        if (!acc[label]) {
            acc[label] = [];
        }
        acc[label].push(row);
        return acc;
    }, {});

    return Object.entries(grouped)
        .map(([label, items]) => {
            const lines = items.map(
                (item) => `• *${item.employee_name}* — ${formatDateWithWeekday(item.start_date)} → ${formatDateWithWeekday(item.end_date)} (${buildDurationText(item.start_date, item.end_date)})`,
            );
            return `*${label}*\n${lines.join("\n")}`;
        })
        .join("\n\n");
}

async function getSlackDisplayName(client, userId, fallback = "Unknown user") {
    try {
        const result = await client.users.info({ user: userId });
        const user = result.user || {};
        const profile = user.profile || {};

        return (
            profile.display_name ||
            profile.real_name ||
            user.real_name ||
            user.name ||
            fallback
        );
    } catch (error) {
        console.error("Failed to fetch Slack display name:", error);
        return fallback;
    }
}

async function getSettingValue(key) {
    const { data, error } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", key)
        .maybeSingle();

    if (error) {
        throw error;
    }

    return data ? data.value : null;
}

async function setSettingValue(key, value) {
    const { error } = await supabase
        .from("app_settings")
        .upsert(
            {
                key,
                value,
                updated_at: new Date().toISOString(),
            },
            { onConflict: "key" },
        );

    if (error) {
        throw error;
    }
}

async function isWorkspaceOwner(client, userId) {
    try {
        const result = await client.users.info({ user: userId });
        const user = result.user || {};
        return Boolean(user.is_owner || user.is_primary_owner);
    } catch (error) {
        console.error("Failed to verify workspace owner:", error);
        return false;
    }
}

async function getManagerIds() {
    try {
        const value = await getSettingValue(MANAGER_IDS_KEY);
        return Array.isArray(value) ? value.filter(Boolean) : [];
    } catch (error) {
        console.error("Failed to load managers from app_settings:", error);
        return [];
    }
}

async function saveManagerIds(managerIds) {
    await setSettingValue(MANAGER_IDS_KEY, managerIds);
}

async function getAnnualLeaveDaysLimit() {
    try {
        const value = await getSettingValue(ANNUAL_LEAVE_DAYS_KEY);
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ANNUAL_LEAVE_DAYS;
    } catch (error) {
        console.error("Failed to load annual leave limit:", error);
        return DEFAULT_ANNUAL_LEAVE_DAYS;
    }
}

async function saveAnnualLeaveDaysLimit(days) {
    await setSettingValue(ANNUAL_LEAVE_DAYS_KEY, Number(days));
}

// --- Per-user per-year allowance helpers ---
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

async function setUserAnnualLeaveAllowance(slackUserId, year, days) {
    const { error } = await supabase
        .from(USER_ALLOWANCE_OVERRIDE_TABLE)
        .upsert(
            {
                slack_user_id: slackUserId,
                year,
                annual_days: Number(days),
                updated_at: new Date().toISOString(),
            },
            { onConflict: "slack_user_id,year" },
        );

    if (error) {
        throw error;
    }
}

async function getHomeViewPreference(userId) {
    try {
        const value = await getSettingValue(`${HOME_VIEW_KEY_PREFIX}${userId}`);
        return value === HOME_VIEW_MANAGER ? HOME_VIEW_MANAGER : HOME_VIEW_USER;
    } catch (error) {
        console.error("Failed to load home view preference:", error);
        return HOME_VIEW_USER;
    }
}

async function setHomeViewPreference(userId, viewName) {
    await setSettingValue(`${HOME_VIEW_KEY_PREFIX}${userId}`, viewName);
}

async function getUpcomingApprovedTimeOff() {
    const today = new Date().toISOString().slice(0, 10);

    const { data, error } = await supabase
        .from("time_off_requests")
        .select("id, slack_user_id, employee_name, start_date, end_date, reason, status")
        .eq("status", "approved")
        .gte("end_date", today)
        .order("start_date", { ascending: true });

    if (error) {
        throw error;
    }

    return data || [];
}

async function getPendingTimeOffRequests() {
    const { data, error } = await supabase
        .from("time_off_requests")
        .select("id, slack_user_id, employee_name, start_date, end_date, reason, status, created_at")
        .eq("status", "pending")
        .order("created_at", { ascending: true });

    if (error) {
        throw error;
    }

    return data || [];
}

async function getEditableRequestsForUser(slackUserId) {
    const today = new Date().toISOString().slice(0, 10);

    const { data, error } = await supabase
        .from("time_off_requests")
        .select("id, slack_user_id, employee_name, start_date, end_date, reason, status, created_at")
        .eq("slack_user_id", slackUserId)
        .in("status", ["approved", "pending"])
        .gte("end_date", today)
        .order("start_date", { ascending: true });

    if (error) {
        throw error;
    }

    return data || [];
}

async function getApprovedRequestsForUserInYear(slackUserId, year) {
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;

    const { data, error } = await supabase
        .from("time_off_requests")
        .select("id, start_date, end_date, status")
        .eq("slack_user_id", slackUserId)
        .eq("status", "approved")
        .lte("start_date", yearEnd)
        .gte("end_date", yearStart);

    if (error) {
        throw error;
    }

    return data || [];
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

async function upsertTeamMember(slackUserId, employeeName) {
    const { error } = await supabase
        .from("team_members")
        .upsert(
            {
                slack_user_id: slackUserId,
                employee_name: employeeName,
                is_active: true,
                updated_at: new Date().toISOString(),
            },
            { onConflict: "slack_user_id" },
        );

    if (error) {
        throw error;
    }
}

async function deactivateTeamMembers(slackUserIds) {
    if (!slackUserIds.length) {
        return;
    }

    const { error } = await supabase
        .from("team_members")
        .update({
            is_active: false,
            updated_at: new Date().toISOString(),
        })
        .in("slack_user_id", slackUserIds);

    if (error) {
        throw error;
    }
}

async function syncWorkspaceUsers(client) {
    let cursor = undefined;
    let synced = 0;

    do {
        const result = await client.users.list({ cursor, limit: 200 });
        const members = result.members || [];

        for (const member of members) {
            if (!member || member.deleted || member.is_bot || member.id === "USLACKBOT") {
                continue;
            }

            const profile = member.profile || {};
            const employeeName =
                profile.display_name ||
                profile.real_name ||
                member.real_name ||
                member.name ||
                member.id;

            await upsertTeamMember(member.id, employeeName);
            synced += 1;
        }

        cursor =
            result.response_metadata && result.response_metadata.next_cursor
                ? result.response_metadata.next_cursor
                : undefined;
    } while (cursor);

    return synced;
}

function buildTeamMembersPreviewText(teamMembers) {
    if (!teamMembers.length) {
        return "No active team members yet.";
    }

    const preview = teamMembers
        .slice(0, 10)
        .map((member) => `• ${member.employee_name}`)
        .join("\n");

    const extraCount =
        teamMembers.length > 10 ? `\n…and ${teamMembers.length - 10} more.` : "";

    return `${preview}${extraCount}`;
}

function numberEmoji(index) {
    const numbers = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
    if (index >= 0 && index < numbers.length) {
        return numbers[index];
    }
    return `${index + 1}.`;
}

async function getAllRequestsForUser(slackUserId) {
    const { data, error } = await supabase
        .from("time_off_requests")
        .select("id, slack_user_id, employee_name, start_date, end_date, reason, status, created_at")
        .eq("slack_user_id", slackUserId)
        .order("start_date", { ascending: false });

    if (error) {
        throw error;
    }

    return data || [];
}

async function getMyHolidaySummary(slackUserId) {
    const currentYear = new Date().getFullYear();
    const globalAnnualLeaveDays = await getAnnualLeaveDaysLimit();
    const userOverride = await getUserAnnualLeaveAllowance(slackUserId, currentYear);
    const annualLeaveDays = userOverride ?? globalAnnualLeaveDays;
    const approvedRequests = await getApprovedRequestsForUserInYear(slackUserId, currentYear);

    let usedWorkingDays = 0;
    for (const request of approvedRequests) {
        const clipped = clipRequestToYear(request.start_date, request.end_date, currentYear);
        if (!clipped) {
            continue;
        }
        usedWorkingDays += calculateTimeOffStats(clipped.startDate, clipped.endDate).workingDays;
    }

    return {
        year: currentYear,
        annualLeaveDays,
        usedWorkingDays,
        availableWorkingDays: Math.max(annualLeaveDays - usedWorkingDays, 0),
    };
}

async function getTeamMemberSummaries() {
    const currentYear = new Date().getFullYear();
    const globalAnnualLeaveDays = await getAnnualLeaveDaysLimit();
    const members = await getTeamMembers();
    const today = new Date().toISOString().slice(0, 10);

    const summaries = [];

    for (const member of members) {
        const userOverride = await getUserAnnualLeaveAllowance(member.slack_user_id, currentYear);
        const annualLeaveDays = userOverride ?? globalAnnualLeaveDays;
        const approvedRequests = await getApprovedRequestsForUserInYear(member.slack_user_id, currentYear);
        const allRequests = await getAllRequestsForUser(member.slack_user_id);

        let usedWorkingDays = 0;
        for (const request of approvedRequests) {
            const clipped = clipRequestToYear(request.start_date, request.end_date, currentYear);
            if (!clipped) continue;
            usedWorkingDays += calculateTimeOffStats(clipped.startDate, clipped.endDate).workingDays;
        }

        summaries.push({
            slack_user_id: member.slack_user_id,
            employee_name: member.employee_name,
            annualLeaveDays,
            usedWorkingDays,
            availableWorkingDays: Math.max(annualLeaveDays - usedWorkingDays, 0),
            plannedRequests: allRequests.filter(
                (request) => request.status === "approved" && request.end_date >= today,
            ),
            pastRequests: allRequests.filter(
                (request) => request.status === "approved" && request.end_date < today,
            ),
        });
    }

    return summaries;
}

async function getTimeOffRequestById(requestId) {
    const { data, error } = await supabase
        .from("time_off_requests")
        .select("id, slack_user_id, employee_name, start_date, end_date, reason, status")
        .eq("id", requestId)
        .single();

    if (error) {
        throw error;
    }

    return data;
}

function managerSummaryText(managerIds) {
    if (!managerIds.length) {
        return "No managers selected yet.";
    }

    return managerIds.map((id) => `• <@${id}>`).join("\n");
}

function isManagerUser(userId, managerIds) {
    return managerIds.includes(userId);
}

function canUseManagerDashboard(userId, managerIds, isOwner) {
    return isOwner || isManagerUser(userId, managerIds);
}

function buildApprovalActionBlock(requestId) {
    return {
        type: "actions",
        elements: [
            {
                type: "button",
                text: {
                    type: "plain_text",
                    text: "Approve",
                },
                style: "primary",
                action_id: "approve_timeoff",
                value: requestId,
            },
            {
                type: "button",
                text: {
                    type: "plain_text",
                    text: "Reject",
                },
                style: "danger",
                action_id: "reject_timeoff",
                value: requestId,
            },
            {
                type: "button",
                text: {
                    type: "plain_text",
                    text: "Edit",
                },
                action_id: "manager_edit_timeoff",
                value: requestId,
            },
        ],
    };
}

function buildMyRequestActionBlock(requestId, status) {
    return {
        type: "actions",
        elements: [
            {
                type: "button",
                text: { type: "plain_text", text: "Edit" },
                action_id: "edit_my_timeoff",
                value: requestId,
            },
            {
                type: "button",
                text: { type: "plain_text", text: status === "approved" ? "Cancel approved" : "Cancel request" },
                style: "danger",
                action_id: "cancel_timeoff",
                value: requestId,
            },
        ],
    };
}

function buildManagerUpcomingActionBlock(requestId) {
    return {
        type: "actions",
        elements: [
            {
                type: "button",
                text: { type: "plain_text", text: "Edit" },
                action_id: "manager_edit_timeoff",
                value: requestId,
            },
            {
                type: "button",
                text: { type: "plain_text", text: "Cancel" },
                style: "danger",
                action_id: "manager_cancel_timeoff",
                value: requestId,
            },
        ],
    };
}

function buildRequestDetailsText(request) {
    const reasonText = request.reason && request.reason.trim() ? `\n${request.reason.trim()}` : "";
    return `*${request.employee_name}*\n${formatDateWithWeekday(request.start_date)} → ${formatDateWithWeekday(request.end_date)}\n${buildDurationText(request.start_date, request.end_date)}${reasonText}`;
}
app.action("switch_to_user_dashboard", async ({ ack, body, client }) => {
    await ack();

    try {
        await setHomeViewPreference(body.user.id, HOME_VIEW_USER);
        await publishHomeTab(client, body.user.id);
    } catch (error) {
        console.error("Failed to switch to user dashboard:", error);
    }
});

app.action("switch_to_manager_dashboard", async ({ ack, body, client }) => {
    await ack();

    try {
        const managerIds = await getManagerIds();
        const isOwner = await isWorkspaceOwner(client, body.user.id);
        if (!canUseManagerDashboard(body.user.id, managerIds, isOwner)) {
            await notifyRequester(client, body.user.id, "Only managers can view the manager dashboard.");
            return;
        }

        await setHomeViewPreference(body.user.id, HOME_VIEW_MANAGER);
        await publishHomeTab(client, body.user.id);
    } catch (error) {
        console.error("Failed to switch to manager dashboard:", error);
    }
});
app.action("manager_adjust_allowance", async ({ ack, body, client }) => {
    await ack();

    try {
        const isOwner = await isWorkspaceOwner(client, body.user.id);
        if (!isOwner) {
            await notifyRequester(client, body.user.id, "Only workspace owners can adjust user allowance.");
            return;
        }

        await client.views.open({
            trigger_id: body.trigger_id,
            view: {
                type: "modal",
                callback_id: "manager_adjust_allowance_form",
                title: {
                    type: "plain_text",
                    text: "Adjust allowance",
                },
                submit: {
                    type: "plain_text",
                    text: "Save",
                },
                close: {
                    type: "plain_text",
                    text: "Cancel",
                },
                blocks: [
                    {
                        type: "input",
                        block_id: "user",
                        label: {
                            type: "plain_text",
                            text: "Employee",
                        },
                        element: {
                            type: "users_select",
                            action_id: "user_id",
                        },
                    },
                    {
                        type: "input",
                        block_id: "days",
                        label: {
                            type: "plain_text",
                            text: "Available annual leave days for current year",
                        },
                        element: {
                            type: "plain_text_input",
                            action_id: "days_value",
                        },
                    },
                ],
            },
        });
    } catch (error) {
        console.error("Failed to open allowance modal:", error);
    }
});
app.view("manager_adjust_allowance_form", async ({ ack, body, view, client }) => {
    await ack();

    try {
        const slackUserId = view.state.values.user.user_id.selected_user;
        const days = Number(view.state.values.days.days_value.value || "0");

        if (!Number.isFinite(days) || days < 0) {
            await notifyRequester(client, body.user.id, "Allowance must be zero or a positive number.");
            return;
        }

        const currentYear = new Date().getFullYear();
        await setUserAnnualLeaveAllowance(slackUserId, currentYear, days);
        const employeeName = await getSlackDisplayName(client, slackUserId);

        await notifyRequester(
            client,
            body.user.id,
            `✅ Allowance updated for *${employeeName}* to *${days} day(s)* for *${currentYear}*.`,
        );

        await publishHomeTab(client, body.user.id);
        await publishHomeTab(client, slackUserId);
    } catch (error) {
        console.error("Failed to save user allowance override:", error);
    }
});

async function notifyRequester(client, slackUserId, text, blocks = null) {
    try {
        const dm = await client.conversations.open({ users: slackUserId });
        await client.chat.postMessage({
            channel: dm.channel.id,
            text,
            ...(blocks ? { blocks } : {}),
        });
    } catch (error) {
        console.error("Requester notification failed:", error);
    }
}

async function publishHomeTab(client, userId) {
    const managerIds = await getManagerIds();
    const isOwner = await isWorkspaceOwner(client, userId);
    const canViewManagerDashboard = canUseManagerDashboard(userId, managerIds, isOwner);
    const requestedView = await getHomeViewPreference(userId);
    const activeView = canViewManagerDashboard && requestedView === HOME_VIEW_MANAGER
        ? HOME_VIEW_MANAGER
        : HOME_VIEW_USER;

    const myHolidaySummary = await getMyHolidaySummary(userId);
    const upcomingTimeOff = await getUpcomingApprovedTimeOff();
    const myEditableRequests = await getEditableRequestsForUser(userId);
    const pendingRequests = canViewManagerDashboard ? await getPendingTimeOffRequests() : [];
    const annualLeaveDays = await getAnnualLeaveDaysLimit();
    const teamMemberSummaries = canViewManagerDashboard ? await getTeamMemberSummaries() : [];
    const activeTeamMembers = canViewManagerDashboard ? await getTeamMembers() : [];

    const blocks = [
        {
            type: "header",
            text: {
                type: "plain_text",
                text: activeView === HOME_VIEW_MANAGER ? "Holiday Planner · Manager Dashboard" : "Holiday Planner · My Dashboard",
            },
        },
        {
            type: "actions",
            elements: [
                {
                    type: "button",
                    text: {
                        type: "plain_text",
                        text: "My Dashboard",
                    },
                    ...(activeView === HOME_VIEW_USER ? { style: "primary" } : {}),
                    action_id: "switch_to_user_dashboard",
                },
                ...(canViewManagerDashboard
                    ? [
                        {
                            type: "button",
                            text: {
                                type: "plain_text",
                                text: "Manager Dashboard",
                            },
                            ...(activeView === HOME_VIEW_MANAGER ? { style: "primary" } : {}),
                            action_id: "switch_to_manager_dashboard",
                        },
                    ]
                    : []),
            ],
        },
        {
            type: "divider",
        },
    ];

    if (activeView === HOME_VIEW_MANAGER) {
        blocks.push(
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `*Manager Settings*\n\nAnnual leave allowance: *${annualLeaveDays} day(s)*\nManagers:\n${managerSummaryText(managerIds)}\n\n*Active team members (${activeTeamMembers.length})*\n${buildTeamMembersPreviewText(activeTeamMembers)}`,
                },
            },
            {
                type: "actions",
                elements: [
                    ...(isOwner
                        ? [
                            {
                                type: "button",
                                text: { type: "plain_text", text: "Managers" },
                                action_id: "open_manager_config",
                            },
                        ]
                        : []),
                    {
                        type: "button",
                        text: { type: "plain_text", text: "Manage team" },
                        action_id: "open_team_management_panel",
                    },
                    {
                        type: "button",
                        text: { type: "plain_text", text: "Add time off" },
                        action_id: "manager_add_timeoff",
                    },
                    {
                        type: "button",
                        text: { type: "plain_text", text: "Adjust allowance" },
                        action_id: "manager_adjust_allowance",
                    },
                ],
            },
            {
                type: "divider",
            },
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `*Pending approvals*\n${pendingRequests.length} request(s) waiting for decision.`,
                },
            },
        );

        if (pendingRequests.length === 0) {
            blocks.push({
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: "No pending requests right now.",
                },
            });
        } else {
            for (const request of pendingRequests) {
                blocks.push(
                    {
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: `*Pending*\n\n${buildRequestDetailsText(request)}`,
                        },
                    },
                    buildApprovalActionBlock(request.id),
                    {
                        type: "divider",
                    },
                );
            }
        }

        blocks.push({
            type: "section",
            text: {
                type: "mrkdwn",
                text: "*All upcoming team requests*",
            },
        });





        if (upcomingTimeOff.length === 0) {
            blocks.push({
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: "No upcoming approved requests right now.",
                },
            });
        } else {
            for (const request of upcomingTimeOff) {
                blocks.push(
                    {
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: `*Approved*\n\n${buildRequestDetailsText(request)}`,
                        },
                    },
                    buildManagerUpcomingActionBlock(request.id),
                    {
                        type: "divider",
                    },
                );
            }
        }


        blocks.push(
            {
                type: "divider",
            },
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: "*Team members overview*",
                },
            },
        );

        if (teamMemberSummaries.length === 0) {
            blocks.push({
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: "No team members with recorded time off yet.",
                },
            });
        } else {
            for (const [index, member] of teamMemberSummaries.entries()) {
                const plannedText = member.plannedRequests.length
                    ? member.plannedRequests
                        .slice(0, 5)
                        .map((request) => `• ${formatDateWithWeekday(request.start_date)} → ${formatDateWithWeekday(request.end_date)} (${buildDurationText(request.start_date, request.end_date)})`)
                        .join("\n")
                    : "No planned approved time off.";

                const pastText = member.pastRequests.length
                    ? member.pastRequests
                        .slice(0, 5)
                        .map((request) => `• ${formatDateWithWeekday(request.start_date)} → ${formatDateWithWeekday(request.end_date)} (${buildDurationText(request.start_date, request.end_date)})`)
                        .join("\n")
                    : "No past approved time off.";

                blocks.push(
                    {
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: `*${numberEmoji(index)} ${member.employee_name}*\nUsed: *${member.usedWorkingDays} working day(s)*\nAvailable: *${member.availableWorkingDays} working day(s)*\nAllowance: *${member.annualLeaveDays} day(s)*\n\n*Planned time off*\n${plannedText}\n\n*Past time off*\n${pastText}`,
                        },
                    },
                    {
                        type: "divider",
                    },
                );
            }
        }

    } else {
        const myPendingRequests = myEditableRequests.filter((request) => request.status === "pending");
        const myApprovedRequests = myEditableRequests.filter((request) => request.status === "approved");

        blocks.push(
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `📅 *My Holiday*\n\nYear: *${myHolidaySummary.year}*\nUsed: *${myHolidaySummary.usedWorkingDays} working day(s)*\nAvailable: *${myHolidaySummary.availableWorkingDays} working day(s)*\nAnnual allowance: *${myHolidaySummary.annualLeaveDays} day(s)*`,
                },
            },
            {
                type: "divider",
            },
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: "🌴 *Upcoming holidays*",
                },
            },
        );

        if (myEditableRequests.length === 0) {
            blocks.push({
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: "No upcoming requests to edit right now.",
                },
            });
        } else {
            for (const request of myEditableRequests) {
                blocks.push(
                    {
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: buildRequestDetailsText(request),
                        },
                    },
                    buildMyRequestActionBlock(request.id, request.status),
                    {
                        type: "divider",
                    },
                );
            }
        }

        blocks.push({
            type: "section",
            text: {
                type: "mrkdwn",
                text: `⏳ *Pending*\n${myPendingRequests.length} request(s) currently waiting for decision.`,
            },
        });

        if (myPendingRequests.length === 0) {
            blocks.push({
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: "No pending requests right now.",
                },
            });
        } else {
            for (const request of myPendingRequests) {
                blocks.push(
                    {
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: buildRequestDetailsText(request),
                        },
                    },
                    buildMyRequestActionBlock(request.id, request.status),
                    {
                        type: "divider",
                    },
                );
            }
        }

        blocks.push({
            type: "section",
            text: {
                type: "mrkdwn",
                text: `✅ *Approved*\n${myApprovedRequests.length} approved request(s).`,
            },
        });

        if (myApprovedRequests.length === 0) {
            blocks.push({
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: "No approved requests right now.",
                },
            });
        } else {
            for (const request of myApprovedRequests) {
                blocks.push(
                    {
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: buildRequestDetailsText(request),
                        },
                    },
                    buildMyRequestActionBlock(request.id, request.status),
                    {
                        type: "divider",
                    },
                );
            }
        }

        blocks.push(
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: "👥 *Team upcoming approved time off*",
                },
            },
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: buildUpcomingGroupedText(upcomingTimeOff),
                },
            },
            {
                type: "context",
                elements: [
                    {
                        type: "mrkdwn",
                        text: "Use `/timeoff` in any channel to post the upcoming time off list there.",
                    },
                ],
            },
        );
    }

    await client.views.publish({
        user_id: userId,
        view: {
            type: "home",
            blocks,
        },
    });
}

async function openManagerConfigModal(client, triggerId) {
    const managerIds = await getManagerIds();
    const annualLeaveDays = await getAnnualLeaveDaysLimit();

    await client.views.open({
        trigger_id: triggerId,
        view: {
            type: "modal",
            callback_id: "manager_config_form",
            title: {
                type: "plain_text",
                text: "Settings",
            },
            submit: {
                type: "plain_text",
                text: "Save",
            },
            close: {
                type: "plain_text",
                text: "Cancel",
            },
            blocks: [
                {
                    type: "input",
                    block_id: "annual_leave_days",
                    label: {
                        type: "plain_text",
                        text: "Annual leave allowance (working days)",
                    },
                    element: {
                        type: "plain_text_input",
                        action_id: "annual_leave_days_value",
                        initial_value: String(annualLeaveDays),
                    },
                },
                {
                    type: "input",
                    block_id: "manager_ids",
                    label: {
                        type: "plain_text",
                        text: "Who can approve time off?",
                    },
                    element: {
                        type: "multi_users_select",
                        action_id: "selected_manager_ids",
                        placeholder: {
                            type: "plain_text",
                            text: "Select managers from workspace",
                        },
                        initial_users: managerIds,
                    },
                },
            ],
        },
    });
}

async function openAddTeamMemberModal(client, triggerId, method = "open") {
    await client.views[method]({
        trigger_id: triggerId,
        view: {
            type: "modal",
            callback_id: "add_team_member_form",
            title: {
                type: "plain_text",
                text: "Add team member",
            },
            submit: {
                type: "plain_text",
                text: "Save",
            },
            close: {
                type: "plain_text",
                text: "Cancel",
            },
            blocks: [
                {
                    type: "input",
                    block_id: "user",
                    label: {
                        type: "plain_text",
                        text: "Select Slack user",
                    },
                    element: {
                        type: "users_select",
                        action_id: "user_id",
                    },
                },
                {
                    type: "input",
                    block_id: "name",
                    optional: true,
                    label: {
                        type: "plain_text",
                        text: "Display name override",
                    },
                    element: {
                        type: "plain_text_input",
                        action_id: "name_value",
                        placeholder: {
                            type: "plain_text",
                            text: "Leave empty to use Slack display name",
                        },
                    },
                },
            ],
        },
    });
}

async function openRemoveTeamMembersModal(client, triggerId, method = "open") {
    const teamMembers = await getTeamMembers();

    await client.views[method]({
        trigger_id: triggerId,
        view: {
            type: "modal",
            callback_id: "remove_team_members_form",
            title: {
                type: "plain_text",
                text: "Remove team members",
            },
            submit: {
                type: "plain_text",
                text: "Save",
            },
            close: {
                type: "plain_text",
                text: "Cancel",
            },
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: teamMembers.length
                            ? `*Active team members*\n\n${buildTeamMembersPreviewText(teamMembers)}`
                            : "No active team members yet.",
                    },
                },
                {
                    type: "input",
                    block_id: "users",
                    optional: true,
                    label: {
                        type: "plain_text",
                        text: "Select users to deactivate",
                    },
                    element: {
                        type: "multi_users_select",
                        action_id: "user_ids",
                        placeholder: {
                            type: "plain_text",
                            text: "Choose users to remove from active team",
                        },
                        initial_users: [],
                    },
                },
            ],
        },
    });
}

async function openTeamManagementPanel(client, triggerId) {
    const teamMembers = await getTeamMembers();

    await client.views.open({
        trigger_id: triggerId,
        view: {
            type: "modal",
            callback_id: "team_management_panel",
            title: {
                type: "plain_text",
                text: "Team management",
            },
            close: {
                type: "plain_text",
                text: "Close",
            },
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `*Active team members (${teamMembers.length})*\n\n${buildTeamMembersPreviewText(teamMembers)}`,
                    },
                },
                {
                    type: "actions",
                    elements: [
                        {
                            type: "button",
                            text: { type: "plain_text", text: "Sync workspace users" },
                            action_id: "sync_workspace_users",
                        },
                        {
                            type: "button",
                            text: { type: "plain_text", text: "Add manually" },
                            action_id: "open_add_team_member",
                        },
                        {
                            type: "button",
                            text: { type: "plain_text", text: "Remove users" },
                            style: "danger",
                            action_id: "open_remove_team_members",
                        },
                    ],
                },
            ],
        },
    });
}

async function openTimeOffModal(client, triggerId, initialValues = {}, metadata = {}) {
    await client.views.open({
        trigger_id: triggerId,
        view: {
            type: "modal",
            callback_id: "timeoff_form",
            private_metadata: JSON.stringify(metadata),
            title: {
                type: "plain_text",
                text: metadata.isEditing ? "Edit Time Off" : "New Time Off",
            },
            submit: {
                type: "plain_text",
                text: metadata.isEditing ? "Save" : "Submit",
            },
            close: {
                type: "plain_text",
                text: "Cancel",
            },
            blocks: [
                ...(metadata.isEditing
                    ? [
                        {
                            type: "section",
                            text: {
                                type: "mrkdwn",
                                text: metadata.editMode === "manager"
                                    ? "ℹ️ Manager edit mode. Changes are saved directly and the requester gets a notification."
                                    : "ℹ️ If you edit an already approved request, it will go back to *pending* and managers will need to approve it again.",
                            },
                        },
                    ]
                    : []),
                {
                    type: "input",
                    block_id: "start",
                    label: {
                        type: "plain_text",
                        text: "Start date",
                    },
                    element: {
                        type: "datepicker",
                        action_id: "start_date",
                        ...(initialValues.startDate ? { initial_date: initialValues.startDate } : {}),
                    },
                },
                {
                    type: "input",
                    block_id: "end",
                    label: {
                        type: "plain_text",
                        text: "End date",
                    },
                    element: {
                        type: "datepicker",
                        action_id: "end_date",
                        ...(initialValues.endDate ? { initial_date: initialValues.endDate } : {}),
                    },
                },
                {
                    type: "input",
                    block_id: "reason",
                    label: {
                        type: "plain_text",
                        text: "Reason / details",
                    },
                    optional: true,
                    element: {
                        type: "plain_text_input",
                        action_id: "reason_text",
                        multiline: true,
                        ...(initialValues.reason ? { initial_value: initialValues.reason } : {}),
                    },
                },
            ],
        },
    });
}

async function sendApprovalRequests(client, request) {
    const managerIds = await getManagerIds();
    const targetManagers = managerIds.filter((managerId) => managerId !== request.slack_user_id);

    if (!targetManagers.length) {
        console.warn("No other managers configured. Approval messages were not sent.");
        return;
    }

    for (const managerId of targetManagers) {
        const dm = await client.conversations.open({ users: managerId });
        await client.chat.postMessage({
            channel: dm.channel.id,
            text: `Time off request from ${request.employee_name}`,
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: buildReadableStatusMessage("🆕", "New time off request", request.employee_name, request.start_date, request.end_date, request.reason),
                    },
                },
                buildApprovalActionBlock(request.id),
            ],
        });
    }
}

async function updateApprovalSurface(client, body, statusLabel, data) {
    const statusEmoji = statusLabel === "Approved" ? "✅" : "❌";
    const summaryText = buildReadableStatusMessage(statusEmoji, statusLabel, data.employee_name, data.start_date, data.end_date, data.reason);

    if (body.channel && body.message && body.message.ts) {
        await client.chat.update({
            channel: body.channel.id,
            ts: body.message.ts,
            text: `${statusLabel}: ${data.employee_name}`,
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: summaryText,
                    },
                },
            ],
        });
        return;
    }

    if (body.view && body.user && body.user.id) {
        await publishHomeTab(client, body.user.id);
        return;
    }

    console.warn("Unknown Slack surface for approval action.", {
        hasChannel: Boolean(body.channel),
        hasMessage: Boolean(body.message),
        hasView: Boolean(body.view),
    });
}

app.event("app_home_opened", async ({ event, client }) => {
    try {
        await publishHomeTab(client, event.user);
    } catch (error) {
        console.error("Failed to publish App Home:", error);
    }
});

app.action("open_manager_config", async ({ ack, body, client }) => {
    await ack();

    const isOwner = await isWorkspaceOwner(client, body.user.id);
    if (!isOwner) {
        await notifyRequester(client, body.user.id, "Only workspace owners can configure settings.");
        return;
    }

    try {
        await openManagerConfigModal(client, body.trigger_id);
    } catch (error) {
        console.error("Failed to open manager config modal:", error);
    }
});

app.action("open_team_management_panel", async ({ ack, body, client }) => {
    await ack();

    try {
        const managerIds = await getManagerIds();
        const isOwner = await isWorkspaceOwner(client, body.user.id);

        if (!canUseManagerDashboard(body.user.id, managerIds, isOwner)) {
            await notifyRequester(client, body.user.id, "Only managers can manage team members.");
            return;
        }

        await openTeamManagementPanel(client, body.trigger_id);
    } catch (error) {
        console.error("Failed to open team management panel:", error);
    }
});

app.action("sync_workspace_users", async ({ ack, body, client }) => {
    await ack();

    try {
        const managerIds = await getManagerIds();
        const isOwner = await isWorkspaceOwner(client, body.user.id);

        if (!canUseManagerDashboard(body.user.id, managerIds, isOwner)) {
            await notifyRequester(client, body.user.id, "Only managers can sync workspace users.");
            return;
        }

        const syncedCount = await syncWorkspaceUsers(client);
        await notifyRequester(client, body.user.id, `✅ Workspace sync completed. Synced ${syncedCount} user(s).`);
        await publishHomeTab(client, body.user.id);
    } catch (error) {
        console.error("Failed to sync workspace users:", error);
        await notifyRequester(client, body.user.id, "Could not sync workspace users.");
    }
});

app.action("open_add_team_member", async ({ ack, body, client }) => {
    await ack();

    try {
        const managerIds = await getManagerIds();
        const isOwner = await isWorkspaceOwner(client, body.user.id);

        if (!canUseManagerDashboard(body.user.id, managerIds, isOwner)) {
            await notifyRequester(client, body.user.id, "Only managers can add team members.");
            return;
        }

        await openAddTeamMemberModal(client, body.trigger_id, body.view ? "push" : "open");
    } catch (error) {
        console.error("Failed to open add team member modal:", error);
    }
});

app.action("open_remove_team_members", async ({ ack, body, client }) => {
    await ack();

    try {
        const managerIds = await getManagerIds();
        const isOwner = await isWorkspaceOwner(client, body.user.id);

        if (!canUseManagerDashboard(body.user.id, managerIds, isOwner)) {
            await notifyRequester(client, body.user.id, "Only managers can remove team members.");
            return;
        }

        await openRemoveTeamMembersModal(client, body.trigger_id, body.view ? "push" : "open");
    } catch (error) {
        console.error("Failed to open remove team members modal:", error);
    }
});



app.view("manager_config_form", async ({ ack, body, view, client }) => {
    await ack();

    const isOwner = await isWorkspaceOwner(client, body.user.id);
    if (!isOwner) {
        console.warn("Non-owner attempted to save manager configuration.");
        return;
    }

    const selectedManagers = view.state.values.manager_ids.selected_manager_ids.selected_users || [];
    const annualLeaveDaysRaw = view.state.values.annual_leave_days.annual_leave_days_value.value || String(DEFAULT_ANNUAL_LEAVE_DAYS);
    const annualLeaveDays = Number(annualLeaveDaysRaw);

    if (!Number.isFinite(annualLeaveDays) || annualLeaveDays <= 0) {
        await notifyRequester(client, body.user.id, "Annual leave allowance must be a positive number.");
        return;
    }

    try {
        await saveManagerIds(selectedManagers);
        await saveAnnualLeaveDaysLimit(annualLeaveDays);
        await publishHomeTab(client, body.user.id);
        await notifyRequester(
            client,
            body.user.id,
            `⚙️ Settings updated.\n\n📌 Annual allowance: ${annualLeaveDays} day(s)\n👥 Managers: ${selectedManagers.length ? selectedManagers.map((id) => `<@${id}>`).join(", ") : "none"}`,
        );
    } catch (error) {
        console.error("Failed to save manager settings:", error);
    }
});

app.view("add_team_member_form", async ({ ack, body, view, client }) => {
    await ack();

    try {
        const slackUserId = view.state.values.user.user_id.selected_user;
        const manualName = (view.state.values.name.name_value.value || "").trim();
        const employeeName = manualName || await getSlackDisplayName(client, slackUserId, slackUserId);

        await upsertTeamMember(slackUserId, employeeName);
        await notifyRequester(client, body.user.id, `✅ Added *${employeeName}* to active team members.`);
        await publishHomeTab(client, body.user.id);
    } catch (error) {
        console.error("Failed to add team member:", error);
        await notifyRequester(client, body.user.id, "Could not add team member.");
    }
});

app.view("remove_team_members_form", async ({ ack, body, view, client }) => {
    await ack();

    try {
        const slackUserIds = view.state.values.users.user_ids.selected_users || [];

        await deactivateTeamMembers(slackUserIds);

        await notifyRequester(
            client,
            body.user.id,
            slackUserIds.length
                ? `✅ Removed ${slackUserIds.length} user(s) from active team members.`
                : "No users were selected for removal.",
        );

        await publishHomeTab(client, body.user.id);
    } catch (error) {
        console.error("Failed to remove team members:", error);
        await notifyRequester(client, body.user.id, "Could not remove team members.");
    }
});

app.action("edit_my_timeoff", async ({ ack, action, body, client }) => {
    await ack();

    try {
        const request = await getTimeOffRequestById(action.value);

        if (request.slack_user_id !== body.user.id) {
            await notifyRequester(client, body.user.id, "You can only edit your own request.");
            return;
        }

        await openTimeOffModal(
            client,
            body.trigger_id,
            {
                startDate: request.start_date,
                endDate: request.end_date,
                reason: request.reason || "",
            },
            {
                requestId: request.id,
                isEditing: true,
                editMode: "self",
            },
        );
    } catch (error) {
        console.error("Failed to open own time off for edit:", error);
    }
});

app.action("manager_edit_timeoff", async ({ ack, action, body, client }) => {
    await ack();

    try {
        const managerIds = await getManagerIds();
        const isOwner = await isWorkspaceOwner(client, body.user.id);
        if (!canUseManagerDashboard(body.user.id, managerIds, isOwner)) {
            await notifyRequester(client, body.user.id, "Only managers can edit team requests.");
            return;
        }

        const request = await getTimeOffRequestById(action.value);
        await openTimeOffModal(
            client,
            body.trigger_id,
            {
                startDate: request.start_date,
                endDate: request.end_date,
                reason: request.reason || "",
            },
            {
                requestId: request.id,
                isEditing: true,
                editMode: "manager",
            },
        );
    } catch (error) {
        console.error("Failed to open manager edit modal:", error);
    }
});

app.action("manager_add_timeoff", async ({ ack, body, client }) => {
    await ack();

    try {
        const managerIds = await getManagerIds();
        const isOwner = await isWorkspaceOwner(client, body.user.id);

        if (!canUseManagerDashboard(body.user.id, managerIds, isOwner)) {
            await notifyRequester(client, body.user.id, "Only managers can add time off for users.");
            return;
        }

        await client.views.open({
            trigger_id: body.trigger_id,
            view: {
                type: "modal",
                callback_id: "manager_add_timeoff_form",
                title: {
                    type: "plain_text",
                    text: "Add time off",
                },
                submit: {
                    type: "plain_text",
                    text: "Create",
                },
                close: {
                    type: "plain_text",
                    text: "Cancel",
                },
                blocks: [
                    {
                        type: "input",
                        block_id: "user",
                        label: {
                            type: "plain_text",
                            text: "Employee",
                        },
                        element: {
                            type: "users_select",
                            action_id: "user_id",
                        },
                    },
                    {
                        type: "input",
                        block_id: "start",
                        label: {
                            type: "plain_text",
                            text: "Start date",
                        },
                        element: {
                            type: "datepicker",
                            action_id: "start_date",
                        },
                    },
                    {
                        type: "input",
                        block_id: "end",
                        label: {
                            type: "plain_text",
                            text: "End date",
                        },
                        element: {
                            type: "datepicker",
                            action_id: "end_date",
                        },
                    },
                    {
                        type: "input",
                        block_id: "reason",
                        optional: true,
                        label: {
                            type: "plain_text",
                            text: "Reason",
                        },
                        element: {
                            type: "plain_text_input",
                            action_id: "reason_text",
                            multiline: true,
                        },
                    },
                ],
            },
        });
    } catch (error) {
        console.error("Failed to open manager add timeoff modal:", error);
    }
});

app.action("cancel_timeoff", async ({ ack, action, body, client }) => {
    await ack();

    try {
        const { data, error } = await supabase
            .from("time_off_requests")
            .update({ status: "cancelled" })
            .eq("id", action.value)
            .eq("slack_user_id", body.user.id)
            .select()
            .single();

        if (error) {
            throw error;
        }

        await notifyRequester(
            client,
            body.user.id,
            `🗑️ Your request was cancelled.\n\n📅 ${formatDateWithWeekday(data.start_date)} → ${formatDateWithWeekday(data.end_date)}\n⏳ ${buildDurationText(data.start_date, data.end_date)}`,
        );

        await publishHomeTab(client, body.user.id);
    } catch (error) {
        console.error("Failed to cancel own time off:", error);
    }
});

app.action("manager_cancel_timeoff", async ({ ack, action, body, client }) => {
    await ack();

    try {
        const managerIds = await getManagerIds();
        const isOwner = await isWorkspaceOwner(client, body.user.id);
        if (!canUseManagerDashboard(body.user.id, managerIds, isOwner)) {
            await notifyRequester(client, body.user.id, "Only managers can cancel team requests.");
            return;
        }

        const request = await getTimeOffRequestById(action.value);
        const { data, error } = await supabase
            .from("time_off_requests")
            .update({ status: "cancelled" })
            .eq("id", request.id)
            .select()
            .single();

        if (error) {
            throw error;
        }

        await notifyRequester(
            client,
            data.slack_user_id,
            `🗑️ Your request was cancelled by a manager.\n\n📅 ${formatDateWithWeekday(data.start_date)} → ${formatDateWithWeekday(data.end_date)}\n⏳ ${buildDurationText(data.start_date, data.end_date)}${data.reason ? `\n📝 ${data.reason}` : ""}`,
        );

        await publishHomeTab(client, body.user.id);
        await publishHomeTab(client, data.slack_user_id);
    } catch (error) {
        console.error("Failed to cancel team time off:", error);
    }
});

app.command("/configure-managers", async ({ ack, body, client }) => {
    await ack();

    const isOwner = await isWorkspaceOwner(client, body.user_id);
    if (!isOwner) {
        await notifyRequester(client, body.user_id, "Only workspace owners can configure settings.");
        return;
    }

    try {
        await openManagerConfigModal(client, body.trigger_id);
    } catch (error) {
        console.error("Failed to open config from slash command:", error);
    }
});

app.command("/timeoff", async ({ ack, respond }) => {
    await ack();

    try {
        const upcomingTimeOff = await getUpcomingApprovedTimeOff();
        await respond({
            response_type: "in_channel",
            text: "Upcoming approved time off",
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `🌴 *Upcoming approved time off*\n\n${buildUpcomingGroupedText(upcomingTimeOff)}`,
                    },
                },
            ],
        });
    } catch (error) {
        console.error("Failed to post upcoming time off:", error);
        await respond({
            response_type: "ephemeral",
            text: "Could not load upcoming time off.",
        });
    }
});

app.command("/holidays", async ({ ack, body, respond }) => {
    await ack();

    const parsedYear = Number((body.text || "").trim());
    const year = Number.isInteger(parsedYear) && parsedYear > 2000 ? parsedYear : new Date().getFullYear();

    try {
        await respond({
            response_type: "ephemeral",
            text: `Polish public holidays ${year}`,
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `🎉 ${buildHolidayListText(year)}`,
                    },
                },
            ],
        });
    } catch (error) {
        console.error("Failed to show holiday list:", error);
    }
});

app.command("/new-timeoff", async ({ ack, body, client }) => {
    await ack();
    await openTimeOffModal(client, body.trigger_id);
});

app.view("timeoff_form", async ({ ack, body, view, client }) => {
    await ack();

    const startDate = view.state.values.start.start_date.selected_date;
    const endDate = view.state.values.end.end_date.selected_date;
    const reason = view.state.values.reason?.reason_text?.value || "";
    const slackUserId = body.user.id;
    const employeeName = await getSlackDisplayName(client, slackUserId, body.user.username || body.user.id);
    const metadata = view.private_metadata ? JSON.parse(view.private_metadata) : {};
    const editingRequestId = metadata.requestId || null;
    const editMode = metadata.editMode || null;

    try {
        if (editingRequestId) {
            const existingRequest = await getTimeOffRequestById(editingRequestId);
            const isOwnRequest = existingRequest.slack_user_id === slackUserId;
            const managerIds = await getManagerIds();
            const isOwner = await isWorkspaceOwner(client, slackUserId);
            const canManagerEdit = canUseManagerDashboard(slackUserId, managerIds, isOwner);

            if (!isOwnRequest && !canManagerEdit) {
                await notifyRequester(client, slackUserId, "You are not allowed to edit this request.");
                return;
            }

            const nextStatus = editMode === "manager"
                ? existingRequest.status
                : existingRequest.status === "approved"
                    ? "pending"
                    : existingRequest.status;

            const { data, error } = await supabase
                .from("time_off_requests")
                .update({
                    start_date: startDate,
                    end_date: endDate,
                    reason,
                    status: nextStatus,
                })
                .eq("id", editingRequestId)
                .select()
                .single();

            if (error) {
                throw error;
            }

            if (editMode === "manager" && existingRequest.slack_user_id !== slackUserId) {
                await notifyRequester(
                    client,
                    existingRequest.slack_user_id,
                    `✏️ Your request was updated by a manager.\n\n📅 ${formatDateWithWeekday(startDate)} → ${formatDateWithWeekday(endDate)}\n⏳ ${buildDurationText(startDate, endDate)}${reason ? `\n📝 ${reason}` : ""}`,
                );
                await notifyRequester(
                    client,
                    slackUserId,
                    `✏️ Team request updated.\n\n👤 ${data.employee_name}\n📅 ${formatDateWithWeekday(startDate)} → ${formatDateWithWeekday(endDate)}\n⏳ ${buildDurationText(startDate, endDate)}${reason ? `\n📝 ${reason}` : ""}`,
                );
            } else {
                await notifyRequester(
                    client,
                    slackUserId,
                    existingRequest.status === "approved"
                        ? `✏️ Your approved request was updated and moved back to pending approval.\n\n📅 ${formatDateWithWeekday(startDate)} → ${formatDateWithWeekday(endDate)}\n⏳ ${buildDurationText(startDate, endDate)}${reason ? `\n📝 ${reason}` : ""}`
                        : `✏️ Your request was updated.\n\n📅 ${formatDateWithWeekday(startDate)} → ${formatDateWithWeekday(endDate)}\n⏳ ${buildDurationText(startDate, endDate)}${reason ? `\n📝 ${reason}` : ""}`,
                );
            }

            if (existingRequest.status === "approved" && editMode !== "manager") {
                await sendApprovalRequests(client, data);
            }

            await publishHomeTab(client, slackUserId);
            if (existingRequest.slack_user_id !== slackUserId) {
                await publishHomeTab(client, existingRequest.slack_user_id);
            }
            return;
        }

        const { data, error } = await supabase
            .from("time_off_requests")
            .insert({
                slack_user_id: slackUserId,
                employee_name: employeeName,
                start_date: startDate,
                end_date: endDate,
                reason,
                status: "pending",
            })
            .select()
            .single();

        if (error) {
            throw error;
        }

        await notifyRequester(
            client,
            slackUserId,
            `📝 Your time off request was saved.\n\n📅 ${formatDateWithWeekday(startDate)} → ${formatDateWithWeekday(endDate)}\n⏳ ${buildDurationText(startDate, endDate)}${reason ? `\n📝 ${reason}` : ""}`,
        );

        await sendApprovalRequests(client, data);
        await publishHomeTab(client, slackUserId);
    } catch (error) {
        console.error("Failed to save time off form:", error);
        await notifyRequester(client, slackUserId, "Could not save the time off request.");
    }
});

app.view("manager_add_timeoff_form", async ({ ack, body, view, client }) => {
    await ack();

    try {
        const slackUserId = view.state.values.user.user_id.selected_user;
        const startDate = view.state.values.start.start_date.selected_date;
        const endDate = view.state.values.end.end_date.selected_date;
        const reason = view.state.values.reason?.reason_text?.value || "";

        const employeeName = await getSlackDisplayName(client, slackUserId);

        const { data, error } = await supabase
            .from("time_off_requests")
            .insert({
                slack_user_id: slackUserId,
                employee_name: employeeName,
                start_date: startDate,
                end_date: endDate,
                reason,
                status: "approved",
            })
            .select()
            .single();

        if (error) {
            throw error;
        }

        await notifyRequester(
            client,
            slackUserId,
            `📅 Time off added by manager.\n\n${buildReadableStatusMessage("📅", "Time off recorded", employeeName, startDate, endDate, reason)}`
        );

        await publishHomeTab(client, body.user.id);
        await publishHomeTab(client, slackUserId);

    } catch (error) {
        console.error("Failed to create manager timeoff:", error);
    }
});

app.action("approve_timeoff", async ({ ack, action, body, client }) => {
    await ack();

    try {
        const { data, error } = await supabase
            .from("time_off_requests")
            .update({ status: "approved" })
            .eq("id", action.value)
            .select()
            .single();

        if (error) {
            throw error;
        }

        await updateApprovalSurface(client, body, "Approved", data);
        await notifyRequester(
            client,
            data.slack_user_id,
            `✅ Your request was approved.\n\n📅 ${formatDateWithWeekday(data.start_date)} → ${formatDateWithWeekday(data.end_date)}\n⏳ ${buildDurationText(data.start_date, data.end_date)}${data.reason ? `\n📝 ${data.reason}` : ""}`,
        );

        if (body.user && body.user.id) {
            await publishHomeTab(client, body.user.id);
        }
        await publishHomeTab(client, data.slack_user_id);
    } catch (error) {
        console.error("Approval failed:", error);
    }
});

app.action("reject_timeoff", async ({ ack, action, body, client }) => {
    await ack();

    try {
        const { data, error } = await supabase
            .from("time_off_requests")
            .update({ status: "rejected" })
            .eq("id", action.value)
            .select()
            .single();

        if (error) {
            throw error;
        }

        await updateApprovalSurface(client, body, "Rejected", data);
        await notifyRequester(
            client,
            data.slack_user_id,
            `❌ Your request was rejected.\n\n📅 ${formatDateWithWeekday(data.start_date)} → ${formatDateWithWeekday(data.end_date)}\n⏳ ${buildDurationText(data.start_date, data.end_date)}${data.reason ? `\n📝 ${data.reason}` : ""}`,
        );

        if (body.user && body.user.id) {
            await publishHomeTab(client, body.user.id);
        }
        await publishHomeTab(client, data.slack_user_id);
    } catch (error) {
        console.error("Rejection failed:", error);
    }
});

(async () => {
    await app.start(process.env.PORT || 3000);
    console.log(`⚡ Slack bot running on port ${process.env.PORT || 3000}`);
})();
