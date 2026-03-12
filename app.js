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

function formatDate(dateString) {
    return new Date(dateString).toLocaleDateString("pl-PL", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
    });
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
                (item) => `• *${item.employee_name}* — ${formatDate(item.start_date)} → ${formatDate(item.end_date)}`,
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
                                        text: `*${request.employee_name}*\n${formatDate(request.start_date)} → ${formatDate(request.end_date)}${request.reason && request.reason.trim() ? `\n_${request.reason.trim()}_` : ""}`,
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
                text: `*New time off request*\n*${request.employee_name}*\n${formatDate(request.start_date)} → ${formatDate(request.end_date)}\n${request.reason || "No details provided"}`,
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
    const employeeName = body.user.username || body.user.id;

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

    await notifyRequester(client, slackUserId, `Twój wniosek urlopowy został zapisany: ${startDate} → ${endDate}`);

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

        await client.chat.update({
            channel: body.channel.id,
            ts: body.message.ts,
            text: `Approved: ${data.employee_name}`,
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `*Approved*\n*${data.employee_name}*\n${formatDate(data.start_date)} → ${formatDate(data.end_date)}\n${data.reason || "No details provided"}`,
                    },
                },
            ],
        });

        await notifyRequester(client, data.slack_user_id, `Twój wniosek został zaakceptowany: ${formatDate(data.start_date)} → ${formatDate(data.end_date)}`);

        try {
            await publishHomeTab(client, body.user.id);
        } catch (homeError) {
            console.error("Failed to refresh manager home after approval:", homeError);
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

        await client.chat.update({
            channel: body.channel.id,
            ts: body.message.ts,
            text: `Rejected: ${data.employee_name}`,
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `*Rejected*\n*${data.employee_name}*\n${formatDate(data.start_date)} → ${formatDate(data.end_date)}\n${data.reason || "No details provided"}`,
                    },
                },
            ],
        });

        await notifyRequester(client, data.slack_user_id, `Twój wniosek został odrzucony: ${formatDate(data.start_date)} → ${formatDate(data.end_date)}`);

        try {
            await publishHomeTab(client, body.user.id);
        } catch (homeError) {
            console.error("Failed to refresh manager home after rejection:", homeError);
        }
    } catch (error) {
        console.error("Rejection failed:", error);
    }
});

(async () => {
    await app.start(process.env.PORT || 3000);
    console.log(`⚡ Slack bot running on port ${process.env.PORT || 3000}`);
})();