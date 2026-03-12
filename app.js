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

const SETTINGS_KEY = "manager_user_ids";

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
        return {
            totalDays: 0,
            workingDays: 0,
        };
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
    return new Date(dateString).toLocaleDateString("en-US", {
        month: "long",
        year: "numeric",
    });
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

async function getUpcomingApprovedTimeOff() {
    const today = new Date().toISOString().slice(0, 10);

    const { data, error } = await supabase
        .from("time_off_requests")
        .select("id, employee_name, start_date, end_date, status")
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
    const { data, error } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", SETTINGS_KEY)
        .maybeSingle();

    if (error) {
        console.error("Failed to load managers from app_settings:", error);
        return [];
    }

    if (!data || !data.value) {
        return [];
    }

    if (Array.isArray(data.value)) {
        return data.value.filter(Boolean);
    }

    return [];
}

async function saveManagerIds(managerIds) {
    const { error } = await supabase.from("app_settings").upsert(
        {
            key: SETTINGS_KEY,
            value: managerIds,
            updated_at: new Date().toISOString(),
        },
        {
            onConflict: "key",
        },
    );

    if (error) {
        throw error;
    }
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
        ],
    };
}

function canUseManagerDashboard(userId, managerIds, isOwner) {
    return isOwner || isManagerUser(userId, managerIds);
}

async function publishHomeTab(client, userId) {
    const managerIds = await getManagerIds();
    const isOwner = await isWorkspaceOwner(client, userId);
    const canManageManagers = isOwner;
    const canViewManagerDashboard = canUseManagerDashboard(userId, managerIds, isOwner);
    const upcomingTimeOff = await getUpcomingApprovedTimeOff();
    const pendingRequests = canViewManagerDashboard ? await getPendingTimeOffRequests() : [];

    await client.views.publish({
        user_id: userId,
        view: {
            type: "home",
            blocks: [
                {
                    type: "header",
                    text: {
                        type: "plain_text",
                        text: canViewManagerDashboard ? "Holiday Planner · Manager Dashboard" : "Holiday Planner",
                    },
                },
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: "*Manager approval settings*\nChoose managers directly from your Slack workspace.",
                    },
                },
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `*Current managers*\n${managerSummaryText(managerIds)}`,
                    },
                    ...(canManageManagers
                        ? {
                            accessory: {
                                type: "button",
                                text: {
                                    type: "plain_text",
                                    text: "Configure managers",
                                },
                                action_id: "open_manager_config",
                            },
                        }
                        : {}),
                },
                {
                    type: "context",
                    elements: [
                        {
                            type: "mrkdwn",
                            text: canManageManagers
                                ? "Only workspace owners can manage approvers."
                                : "You can view the manager list, but only workspace owners can change it.",
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
                        text: "*Upcoming approved time off*",
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
                ...(canViewManagerDashboard
                    ? [
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
                        ...(pendingRequests.length === 0
                            ? [
                                {
                                    type: "section",
                                    text: {
                                        type: "mrkdwn",
                                        text: "No pending requests right now.",
                                    },
                                },
                            ]
                            : pendingRequests.flatMap((request) => [
                                {
                                    type: "section",
                                    text: {
                                        type: "mrkdwn",
                                        text: `*${request.employee_name}*\n${formatDateWithWeekday(request.start_date)} → ${formatDateWithWeekday(request.end_date)}\n${buildDurationText(request.start_date, request.end_date)}${request.reason && request.reason.trim() ? `\n_${request.reason.trim()}_` : ""}`,
                                    },
                                },
                                buildApprovalActionBlock(request.id),
                            ])),
                    ]
                    : []),
            ],
        },
    });
}

async function openManagerConfigModal(client, triggerId) {
    const managerIds = await getManagerIds();

    await client.views.open({
        trigger_id: triggerId,
        view: {
            type: "modal",
            callback_id: "manager_config_form",
            title: {
                type: "plain_text",
                text: "Managers",
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

async function sendApprovalRequests(client, request) {
    const managerIds = await getManagerIds();

    if (!managerIds.length) {
        console.warn("No managers configured. Approval messages were not sent.");
        return;
    }

    const blocks = [
        {
            type: "section",
            text: {
                type: "mrkdwn",
                text: `*New time off request*\n*${request.employee_name}*\n${formatDateWithWeekday(request.start_date)} → ${formatDateWithWeekday(request.end_date)}\n${buildDurationText(request.start_date, request.end_date)}\n${request.reason || "No details provided"}`,
            },
        },
        {
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
                    value: request.id,
                },
                {
                    type: "button",
                    text: {
                        type: "plain_text",
                        text: "Reject",
                    },
                    style: "danger",
                    action_id: "reject_timeoff",
                    value: request.id,
                },
            ],
        },
    ];

    for (const managerId of managerIds) {
        const dm = await client.conversations.open({ users: managerId });
        await client.chat.postMessage({
            channel: dm.channel.id,
            text: `Time off request from ${request.employee_name}`,
            blocks,
        });
    }
}

async function notifyRequester(client, slackUserId, text) {
    try {
        const dm = await client.conversations.open({ users: slackUserId });
        await client.chat.postMessage({
            channel: dm.channel.id,
            text,
        });
    } catch (error) {
        console.error("Requester notification failed:", error);
    }
}

// Helper to update approval/rejection message surface (DM, Home, etc.)
async function updateApprovalSurface(client, body, statusLabel, data) {
    const summaryText = `*${statusLabel}*\n*${data.employee_name}*\n${formatDateWithWeekday(data.start_date)} → ${formatDateWithWeekday(data.end_date)}\n${buildDurationText(data.start_date, data.end_date)}\n${data.reason || "No details provided"}`;

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
        try {
            await client.chat.postEphemeral({
                channel: body.user.id,
                user: body.user.id,
                text: "Only workspace owners can configure managers.",
            });
        } catch (error) {
            console.error("Failed to send owner-only message:", error);
        }
        return;
    }

    try {
        await openManagerConfigModal(client, body.trigger_id);
    } catch (error) {
        console.error("Failed to open manager config modal:", error);
    }
});

app.view("manager_config_form", async ({ ack, body, view, client }) => {
    await ack();

    const isOwner = await isWorkspaceOwner(client, body.user.id);
    if (!isOwner) {
        console.warn("Non-owner attempted to save manager configuration.");
        return;
    }

    const selectedManagers =
        view.state.values.manager_ids.selected_manager_ids.selected_users || [];

    try {
        await saveManagerIds(selectedManagers);
        await publishHomeTab(client, body.user.id);

        const dm = await client.conversations.open({ users: body.user.id });
        await client.chat.postMessage({
            channel: dm.channel.id,
            text: `Manager list updated. Selected managers: ${selectedManagers.length ? selectedManagers.map((id) => `<@${id}>`).join(", ") : "none"}`,
        });
    } catch (error) {
        console.error("Failed to save manager settings:", error);
    }
});

app.command("/configure-managers", async ({ ack, body, client }) => {
    await ack();

    const isOwner = await isWorkspaceOwner(client, body.user_id);
    if (!isOwner) {
        await client.chat.postEphemeral({
            channel: body.channel_id,
            user: body.user_id,
            text: "Only workspace owners can configure managers.",
        });
        return;
    }

    try {
        await openManagerConfigModal(client, body.trigger_id);
    } catch (error) {
        console.error("Failed to open config from slash command:", error);
    }
});


app.command("/timeoff", async ({ ack, body, client, respond }) => {
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
                        text: `*Upcoming approved time off*\n\n${buildUpcomingGroupedText(upcomingTimeOff)}`,
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
                        text: buildHolidayListText(year),
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

    await client.views.open({
        trigger_id: body.trigger_id,
        view: {
            type: "modal",
            callback_id: "timeoff_form",
            title: {
                type: "plain_text",
                text: "New Time Off",
            },
            submit: {
                type: "plain_text",
                text: "Submit",
            },
            close: {
                type: "plain_text",
                text: "Cancel",
            },
            blocks: [
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
                    label: {
                        type: "plain_text",
                        text: "Reason / details",
                    },
                    optional: true,
                    element: {
                        type: "plain_text_input",
                        action_id: "reason_text",
                        multiline: true,
                    },
                },
            ],
        },
    });
});

app.view("timeoff_form", async ({ ack, body, view, client }) => {
    await ack();

    const startDate = view.state.values.start.start_date.selected_date;
    const endDate = view.state.values.end.end_date.selected_date;
    const reason = view.state.values.reason?.reason_text?.value || "";
    const slackUserId = body.user.id;
    const employeeName = await getSlackDisplayName(client, slackUserId, body.user.username || body.user.id);

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
        console.error("Supabase insert error:", error);

        await notifyRequester(client, slackUserId, "Nie udało się zapisać wniosku urlopowego.");

        return;
    }


    await notifyRequester(client, slackUserId, `Twój wniosek urlopowy został zapisany: ${formatDateWithWeekday(startDate)} → ${formatDateWithWeekday(endDate)} (${buildDurationText(startDate, endDate)})`);

    try {
        await sendApprovalRequests(client, data);
    } catch (approvalError) {
        console.error("Failed to send approval requests:", approvalError);
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

        await notifyRequester(client, data.slack_user_id, `Twój wniosek został zaakceptowany: ${formatDateWithWeekday(data.start_date)} → ${formatDateWithWeekday(data.end_date)} (${buildDurationText(data.start_date, data.end_date)})`);

        if (body.user && body.user.id) {
            try {
                await publishHomeTab(client, body.user.id);
            } catch (homeError) {
                console.error("Failed to refresh manager home after approval:", homeError);
            }
        }
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

        await notifyRequester(client, data.slack_user_id, `Twój wniosek został odrzucony: ${formatDateWithWeekday(data.start_date)} → ${formatDateWithWeekday(data.end_date)} (${buildDurationText(data.start_date, data.end_date)})`);

        if (body.user && body.user.id) {
            try {
                await publishHomeTab(client, body.user.id);
            } catch (homeError) {
                console.error("Failed to refresh manager home after rejection:", homeError);
            }
        }
    } catch (error) {
        console.error("Rejection failed:", error);
    }
});

(async () => {
    await app.start(process.env.PORT || 3000);
    console.log(`⚡ Slack bot running on port ${process.env.PORT || 3000}`);
})();