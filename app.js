const { App } = require("@slack/bolt");
const { createClient } = require("@supabase/supabase-js");

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.command("/new-timeoff", async ({ ack, body, client }) => {
  await ack();

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal",
      callback_id: "timeoff_form",
      title: {
        type: "plain_text",
        text: "New Time Off"
      },
      submit: {
        type: "plain_text",
        text: "Submit"
      },
      close: {
        type: "plain_text",
        text: "Cancel"
      },
      blocks: [
        {
          type: "input",
          block_id: "start",
          label: {
            type: "plain_text",
            text: "Start date"
          },
          element: {
            type: "datepicker",
            action_id: "start_date"
          }
        },
        {
          type: "input",
          block_id: "end",
          label: {
            type: "plain_text",
            text: "End date"
          },
          element: {
            type: "datepicker",
            action_id: "end_date"
          }
        },
        {
          type: "input",
          block_id: "reason",
          label: {
            type: "plain_text",
            text: "Reason / details"
          },
          element: {
            type: "plain_text_input",
            action_id: "reason_text",
            multiline: true
          }
        }
      ]
    }
  });
});

app.view("timeoff_form", async ({ ack, body, view, client }) => {
  await ack();

  const startDate = view.state.values.start.start_date.selected_date;
  const endDate = view.state.values.end.end_date.selected_date;
  const reason = view.state.values.reason.reason_text.value || "";
  const slackUserId = body.user.id;
  const employeeName = body.user.username || body.user.id;

  const { error } = await supabase.from("time_off_requests").insert({
    slack_user_id: slackUserId,
    employee_name: employeeName,
    start_date: startDate,
    end_date: endDate,
    reason: reason,
    status: "pending"
  });

  if (error) {
    console.error("Supabase insert error:", error);

    await client.chat.postEphemeral({
      channel: body.user.id,
      user: body.user.id,
      text: "Nie udało się zapisać wniosku urlopowego."
    });

    return;
  }

  try {
    await client.chat.postMessage({
      channel: body.user.id,
      text: `Twój wniosek urlopowy został zapisany: ${startDate} → ${endDate}`
    });
  } catch (postError) {
    console.error("Slack DM error:", postError);
  }
});

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log(`⚡ Slack bot running on port ${process.env.PORT || 3000}`);
})();