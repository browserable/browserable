var express = require("express");
var router = express.Router();
var cors = require("cors");
var { getReadableFromUTCToLocal } = require("../utils/datetime");
var {
    createFlow,
    changeFlowStatus,
} = require("../logic/flow");
var {
    callOpenAICompatibleLLMWithRetry,
    updateMetadataOfLLMCall,
} = require("../services/llm");
var {
    processUserInputForRun,
    processUserInputForNode,
    getAvailableTriggers,
} = require("../agents/jarvis");
var db = require("../services/db");
const {
    addDocumentsToDataTable,
    updateDocumentInDataTable,
    getDocumentsFromDataTable,
    getDataTableSchema,
    updateDataTableSchema,
} = require("../logic/datatable");

const {
    checkAccountAccess,
    checkAccountAdminAccess,
    addUserToRequest,
} = require("../logic/middleware");


// create an api to generate otp
router.options(
    "/create/generator",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    })
);
router.post(
    "/create/generator",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    }),
    addUserToRequest,
    checkAccountAccess,
    async (req, res) => {
        const { fingerprint, initMessage, agent_codes, accountId } =
            req.body || {};

        try {
            let user = req.user;

            const uniqueKeyInMetadata = "generator";
            const uniqueValInMetadata = Date.now();
            const timezoneOffsetInSeconds = user?.settings?.timezoneOffsetInSeconds || 0;

            const llmResponse = await callOpenAICompatibleLLMWithRetry({
                messages: [
                    {
                        role: "system",
                        content: `Create a simple readable_name (max 4-5 words) and readable_description (max 2-3 sentences) based on the user's inital message.`,
                    },
                    {
                        role: "user",
                        content: `Initial message: ${initMessage}
                        
Output format: (JSON)
{
    "readable_name": "<readable_name>",
    "readable_description": "<readable_description>"
}
ONLY output the JSON, nothing else.`,
                    },
                ],
                metadata: {
                    [uniqueKeyInMetadata]: uniqueValInMetadata,
                    usecase: "generator",
                    accountId,
                },
                models: [
                    "gemini-2.0-flash",
                    "deepseek-chat",
                    "gpt-4o-mini",
                    "claude-3-5-haiku",
                    "qwen-plus",
                ],
                max_attempts: 4,
            });

            // figure out triggers
            let triggers = [];

            const triggersResponse = await callOpenAICompatibleLLMWithRetry({
                messages: [
                    {
                        role: "system",
                        content: `You are a helpful assistant to figure out the when to run a task.`,
                    },
                    {
                        role: "user",
                        content: `Given the following task that user wants to run (user entered in natural language):
------------
${initMessage}
------------


Figure out the when to run the task. (i.e, what all triggers are possible for the task)

Available triggers are:
1. "once|<delay>|" ---> instantly creates a run with the provided delay. delay is in milliseconds.
- Use this if the user asked to run something once. 
- Or they asked to run something with a delay.
- Or they didn't mention any other trigger at all.
2. "crontab|<crontab_string>|" ---> creates a task with the crontab string to run as long as it is active
- Use this if the user asked to run something repeatedly at some specific time/day/routine
3. event.once|<event_id>|" ---> integrations can parse this event id to create a run. (event_id options are available in action details of the agents)
- Use this if there's a specific available trigger below & user mentioned to run it once when that trigger is triggered next
4. event.every|<event_id>|" ---> integrations can parse this event id to create a run. 
- Use this if there's a specific available trigger below & user mentioned to run it repeatedly everytime the event is triggered

It's mandatory to have at least one trigger. Worst case, you can use "once|0|" as a trigger.


Available triggers for the task:
${getAvailableTriggers({
    agent_codes: agent_codes || [],
})}

Current date and time at user's timezone: ${getReadableFromUTCToLocal(
    new Date(),
    timezoneOffsetInSeconds
)}

Current data and time at server's timezone: ${getReadableFromUTCToLocal(
    new Date(),
    0
)}

Timezone:
Server is at UTC timezone.
User's timezone offset is ${timezoneOffsetInSeconds} seconds.

Rules:
- When creating delay and crontab expressions, you need to take into account the user's timezone offset. and generate the value that server will use.
- Ex: If the user's time is 4PM and user says run at 5PM. then delay is 1 hour.
- Ex: If the user's time is 4PM and user says run at 3PM. then delay is 25 hours.
- Ex: If the user's time is 4PM Monday (and server time is 2PM Monday) and user says run at 5PM every Monday. then crontab is "0 3 * * 1" (notice the 5PM user time is converted to 3PM server time)

Output format: (JSON)
{
    "readableDescriptionOfTriggers": "<readableDescriptionOfTriggers>", // describe the triggers in a way that is easy to understand for the user
    "triggers": ["trigger1", "trigger2", "trigger3"]
}

ONLY output the JSON, nothing else.`,
                    },
                ],
                models: [
                    "gemini-2.0-flash",
                    "deepseek-chat",
                    "deepseek-reasoner",
                    "claude-3-5-sonnet",
                    "gpt-4o",
                    "qwen-plus",        
                ],
                metadata: {
                    [uniqueKeyInMetadata]: uniqueValInMetadata,
                    accountId,
                    usecase: "generator",
                },
                max_attempts: 5,
            });

            triggers = triggersResponse.triggers;

            const task = initMessage;

            let mandatoryColumnsInResultsTable = [];

            if (agent_codes.includes("DEEPRESEARCH_AGENT")) {
                mandatoryColumnsInResultsTable = [
                    {
                        key: "deepResearchReport",
                        name: "DeepResearch Report",
                        type: "string",
                        description: "Detailed report of the deepresearch agent in markdown format",
                    },
                ];
            }

            const { flowId } = await createFlow({
                flow: {
                    account_id: accountId,
                    readable_name: llmResponse?.readable_name || "Flow",
                    readable_description:
                        llmResponse?.readable_description || "Flow",
                    user_id: user.id,
                    task: task || "",
                    triggers: triggers || ["once|0|"],
                    data: {},
                    status: "active",
                    metadata: {
                        agent_codes,
                        initMessage,
                        readableDescriptionOfTriggers:
                            triggersResponse?.readableDescriptionOfTriggers ||
                            "",
                        mandatoryColumns: mandatoryColumnsInResultsTable,
                    },
                },
            });

            await updateMetadataOfLLMCall({
                uniqueKeyInMetadata,
                uniqueValInMetadata,
                metadataToUpdate: {
                    flowId,
                },
            });

            res.json({ success: true, data: { flowId } });
        } catch (e) {
            console.log(e);

            res.json({
                success: false,
                error: e.message,
            });
        }
    }
);

router.options(
    "/get/flows/before",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    })
);
router.post(
    "/get/flows/before",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    }),
    addUserToRequest,
    checkAccountAccess,
    async (req, res) => {
        let { before, limit = 50, accountId } = req.body || {};

        try {
            let user = req.user;

            before = before || Date.now();
            before = new Date(before);

            // make sure limit is 50 or lower
            limit = Math.min(50, Number(limit) || 50);

            const tasksDB = await db.getTasksDB();
            // remove the flows that have generatedFlowId not null inside metadata from it
            const { rows: flows } = await tasksDB.query(
                `SELECT id, readable_name, readable_description, status, created_at FROM browserable.flows WHERE account_id = $1 AND created_at < $2 AND metadata->>'generatedFlowId' IS NULL AND metadata->>'archived' IS NULL ORDER BY status, created_at DESC LIMIT $3`,
                [accountId, before, limit]
            );

            res.json({ success: true, data: { flows } });
        } catch (e) {
            console.log(e);

            res.json({
                success: false,
                data: { user: null, isLoggedIn: false },
                error: e.message,
            });
            return;
        }
    }
);

router.options(
    "/update/flow/status",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    })
);
router.post(
    "/update/flow/status",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    }),
    addUserToRequest,
    checkAccountAccess,
    async (req, res) => {
        let { flowId, status, accountId } = req.body || {};
        try {
            let user = req.user;

            // status should be one of "active" or "inactive"
            if (status !== "active" && status !== "inactive") {
                res.json({ success: false, error: "Invalid status" });
                return;
            }

            // get current status from db
            const tasksDB = await db.getTasksDB();
            const {
                rows: [currentStatus],
            } = await tasksDB.query(
                `SELECT status FROM browserable.flows WHERE id = $1 AND account_id = $2`,
                [flowId, accountId]
            );

            if (currentStatus.status === status) {
                res.json({ success: true });
                return;
            }

            await changeFlowStatus({
                flow_id: flowId,
                user_id: user.id,
                account_id: accountId,
                status,
                currentStatus: currentStatus.status,
            });

            // get the flow from db
            const {
                rows: [flow],
            } = await tasksDB.query(
                `SELECT * FROM browserable.flows WHERE id = $1 AND account_id = $2`,
                [flowId, accountId]
            );

            res.json({ success: true, data: { flow } });
        } catch (e) {
            console.log(e);
            res.json({ success: false, error: e.message });
        }
    }
);

router.options(
    "/get/flows/after",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    })
);
router.post(
    "/get/flows/after",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    }),
    addUserToRequest,
    checkAccountAccess,
    async (req, res) => {
        let { after, limit = 50, accountId } = req.body || {};

        try {
            let user = req.user;

            after = after || 0;
            after = new Date(after);
            // make sure limit is 50 or lower
            limit = Math.min(50, Number(limit) || 50);

            const tasksDB = await db.getTasksDB();
            const { rows: flows } = await tasksDB.query(
                `SELECT id, readable_name, readable_description, created_at FROM browserable.flows WHERE account_id = $1 AND (created_at > $2 OR updated_at > $2) AND metadata->>'generatedFlowId' IS NULL AND metadata->>'archived' IS NULL ORDER BY status, created_at DESC LIMIT $3`,
                [accountId, after, limit]
            );

            res.json({ success: true, data: { flows } });
        } catch (e) {
            console.log(e);

            res.json({
                success: false,
                error: e.message,
            });
        }
    }
);

router.options(
    "/get/flow/messages/before",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    })
);
router.post(
    "/get/flow/messages/before",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    }),
    addUserToRequest,
    checkAccountAccess,
    async (req, res) => {
        let {
            before,
            limit = 50,
            flowId: flow_id,
            segment = "user",
            accountId,
        } = req.body || {};


        try {
            let user = req.user;


            before = before || Date.now();
            before = new Date(before);

            // make sure limit is 50 or lower
            limit = Math.min(50, Number(limit) || 50);

            const tasksDB = await db.getTasksDB();

            if (segment === "agent") {
                segment = "debug";
            }

            const { rows: messages } = await tasksDB.query(
                `SELECT id, messages, created_at FROM browserable.message_logs WHERE flow_id = $1 AND created_at < $2 ${
                    segment ? `AND segment = $4` : ""
                } ORDER BY created_at DESC LIMIT $3`,
                [flow_id, before, limit, ...(segment ? [segment] : [])]
            );

            res.json({ success: true, data: { messages } });
        } catch (e) {
            console.log(e);

            res.json({
                success: false,
                error: e.message,
            });
            return;
        }
    }
);

router.options(
    "/get/flow/messages/after",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    })
);
router.post(
    "/get/flow/messages/after",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    }),
    addUserToRequest,
    checkAccountAccess,
    async (req, res) => {
        let {
            after,
            limit = 50,
            flowId: flow_id,
            segment = "user",
            accountId,
        } = req.body || {};


        try {
            let user = req.user;

            if (segment === "agent") {
                segment = "debug";
            }

            after = after || 0;
            after = new Date(after);

            // make sure limit is 50 or lower
            limit = Math.min(50, Number(limit) || 50);
            const tasksDB = await db.getTasksDB();

            const { rows: messages } = await tasksDB.query(
                `SELECT id, messages, created_at FROM browserable.message_logs WHERE flow_id = $1 AND created_at > $2 AND segment = $3 ORDER BY created_at ASC LIMIT $4`,
                [flow_id, after, segment, limit]
            );

            res.json({ success: true, data: { messages } });
        } catch (e) {
            console.log(e);

            res.json({
                success: false,
                data: { user: null, isLoggedIn: false },
                error: e.message,
            });
            return;
        }
    }
);

router.options(
    "/get/flow/details",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    })
);
router.post(
    "/get/flow/details",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    }),
    addUserToRequest,   
    checkAccountAccess,
    async (req, res) => {
        let { flowId: flow_id, accountId } = req.body || {};

        try {
            let user = req.user;

            const tasksDB = await db.getTasksDB();

            const { rows: flow } = await tasksDB.query(
                `SELECT * FROM browserable.flows WHERE id = $1 AND account_id = $2`,
                [flow_id, accountId]
            );

            res.json({
                success: true,
                data: { ...(flow.length > 0 ? flow[0] : {}) },
            });
        } catch (e) {
            console.log(e);
            res.json({ success: false, error: e.message });
        }
    }
);

router.options(
    "/get/flow/active-run-status",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    })
);
router.post(
    "/get/flow/active-run-status",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    }),
    addUserToRequest,
    checkAccountAccess,
    async (req, res) => {
        const { flowId: flow_id, accountId } = req.body || {};


        try {
            let user = req.user;

            const tasksDB = await db.getTasksDB();

            // get the first run that is not "completed" (first and not most recent)
            const { rows: runs } = await tasksDB.query(
                `SELECT status, input_wait, id, live_status, private_data->>'workingOnNodeId' AS working_on_node_id FROM browserable.runs WHERE flow_id = $1 AND status != 'completed' ORDER BY created_at ASC LIMIT 1`,
                [flow_id]
            );

            if (runs.length > 0) {
                let runStatus = runs[0].status;
                let inputWait = runs[0].input_wait;
                let liveStatus = runs[0].live_status;

                if (inputWait) {
                    inputWait.runId = runs[0].id;
                }

                if (runStatus === "running" && runs[0].working_on_node_id) {
                    // get workingNodeId from run's private_data
                    const { rows: nodes } = await tasksDB.query(
                        `SELECT status, live_status, input_wait, id FROM browserable.nodes WHERE run_id = $1 AND id = $2`,
                        [runs[0].id, runs[0].working_on_node_id]
                    );

                    if (nodes.length > 0 && nodes[0].live_status) {
                        liveStatus = nodes[0].live_status;
                    }

                    if (
                        nodes.length > 0 &&
                        runStatus !== "ask_user_for_input"
                    ) {
                        runStatus = nodes[0].status;

                        if (
                            nodes[0].input_wait &&
                            nodes[0].status === "ask_user_for_input" &&
                            nodes[0].input_wait != "completed"
                        ) {
                            inputWait = nodes[0].input_wait;
                            inputWait.nodeId = nodes[0].id;
                            inputWait.runId = runs[0].id;
                        }
                    }
                }

                res.json({
                    success: true,
                    data: { runStatus, inputWait, liveStatus },
                });
            } else {
                res.json({
                    success: true,
                    data: {
                        runStatus: null,
                        inputWait: null,
                        liveStatus: null,
                    },
                });
            }
        } catch (e) {
            console.log(e);
            res.json({ success: false, error: e.message });
        }
    }
);

router.options(
    "/get/flow/data/before",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    })
);
router.post(
    "/get/flow/data/before",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    }),
    addUserToRequest,
    checkAccountAccess,
    async (req, res) => {
        let {
            flowId: flow_id,
            before,
            limit = 50,
            accountId,
        } = req.body || {};


        try {
            let user = req.user;

            before = before || Date.now();
            before = new Date(before);

            const tasksDB = await db.getTasksDB();

            // get status, error, structured_output, created_at, input from runs of this flow that are either completed or error (status) DESC of created_at with provided limit
            let { rows: runs } = await tasksDB.query(
                `SELECT status, error, structured_output, created_at, input FROM browserable.runs WHERE flow_id = $1 AND (status = 'completed' OR status = 'error') AND created_at < $2 ORDER BY created_at DESC LIMIT $3`,
                [flow_id, before, limit]
            );

            // get users timezone offset
            const { rows: userTimezoneOffset } = await tasksDB.query(
                `SELECT settings->>'timezoneOffsetInSeconds' AS timezone_offset FROM browserable.users WHERE id = $1`,
                [user.id]
            );

            const timezoneOffset = userTimezoneOffset[0].timezone_offset;

            runs = runs.map((run) => {
                let data = {};
                data = {
                    ...(run.structured_output || {}),
                    // status: run.status,
                    Error: run.error || "N/A",
                    ["Date"]: getReadableFromUTCToLocal(
                        run.created_at,
                        timezoneOffset,
                        {
                            readableTimeAndDate: true,
                        }
                    ),
                    Task: run.input,
                    created_at: run.created_at,
                };
                return data;
            });

            res.json({ success: true, data: { runs } });
        } catch (e) {
            console.log(e);
            res.json({ success: false, error: e.message });
        }
    }
);

router.options(
    "/get/flow/data/after",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    })
);
router.post(
    "/get/flow/data/after",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    }),
    addUserToRequest,
    checkAccountAccess,
    async (req, res) => {
        let {
            flowId: flow_id,
            after,
            limit = 50,
            accountId,
        } = req.body || {};


        try {
            let user = req.user;

            after = after || 0;
            after = new Date(after);

            const tasksDB = await db.getTasksDB();

            // get status, error, structured_output, created_at, input from runs of this flow that are either completed or error (status) DESC of created_at with provided limit
            let { rows: runs } = await tasksDB.query(
                `SELECT id, status, error, structured_output, created_at, input FROM browserable.runs WHERE flow_id = $1 AND (status = 'completed' OR status = 'error') AND created_at > $2 ORDER BY created_at ASC LIMIT $3`,
                [flow_id, after, limit]
            );

            runs = runs.map((run) => {
                let data = {};
                data = {
                    ...(run.structured_output || {}),
                    status: run.status,
                    error: run.error,
                    created_at: run.created_at,
                    input: run.input,
                    id: run.id,
                };
                return data;
            });

            res.json({ success: true, data: { runs } });
        } catch (e) {
            console.log(e);
            res.json({ success: false, error: e.message });
        }
    }
);

router.options(
    "/submit/flow/run/user-input",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    })
);
router.post(
    "/submit/flow/run/user-input",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    }),
    addUserToRequest,
    checkAccountAccess,
    async (req, res) => {
        let { run_id, messages, inputWaitId, accountId } = req.body || {};

        try {
            let user = req.user;

            await processUserInputForRun({
                runId: run_id,
                inputWaitId,
                messages,
                userId: user.id,
                accountId,
            });

            res.json({ success: true });
        } catch (e) {
            console.log(e);
            res.json({ success: false, error: e.message });
        }
    }
);

router.options(
    "/submit/flow/node/user-input",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    })
);
router.post(
    "/submit/flow/node/user-input",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    }),
    addUserToRequest,
    checkAccountAccess,
    async (req, res) => {
        let { node_id, run_id, messages, inputWaitId, accountId } =
            req.body || {};

        try {
            let user = req.user;

            await processUserInputForNode({
                nodeId: node_id,
                runId: run_id,
                inputWaitId,
                messages,
                userId: user.id,
                accountId,
            });

            res.json({ success: true });
        } catch (e) {
            console.log(e);
            res.json({ success: false, error: e.message });
        }
    }
);

router.options(
    "/archive/flow",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    })
);
router.post(
    "/archive/flow",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    }),
    addUserToRequest,
    checkAccountAccess,
    async (req, res) => {
        let { flowId, accountId } = req.body || {};

        try {
            const tasksDB = await db.getTasksDB();

            // Update the flow status to archived, but only if the flow belongs to this user
            const { rows } = await tasksDB.query(
                `SELECT metadata FROM browserable.flows WHERE id = $1 AND account_id = $2 AND (status = 'inactive' OR status = 'error')`,
                [flowId, accountId]
            );

            if (rows.length === 0) {
                res.json({ success: false, error: "No flow found or unauthorized" });
                return;
            }

            const { metadata } = rows[0];
            metadata.archived = true;

            await tasksDB.query(
                `UPDATE browserable.flows SET metadata = $1 WHERE id = $2 AND account_id = $3`,
                [JSON.stringify(metadata), flowId, accountId]
            );

            res.json({ success: true });
        } catch (e) {
            console.log(e);
            res.json({ success: false, error: e.message });
        }
    }
);

router.options(
    "/get/llm-calls",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    })
);
router.post(
    "/get/llm-calls",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    }),
    addUserToRequest,
    checkAccountAdminAccess,
    async (req, res) => {
        let { pageSize = 50, pageNumber = 1, flowId, accountId } = req.body || {};

        try {
            let user = req.user;

            // Ensure positive integers
            pageSize = Math.max(1, Math.floor(Number(pageSize)));
            pageNumber = Math.max(1, Math.floor(Number(pageNumber)));
            pageSize = pageSize > 50 ? 50 : pageSize;

            const offset = (pageNumber - 1) * pageSize;

            const tasksDB = await db.getTasksDB();

            // Get total count and paginated results in parallel
            const [countResult, llmCalls] = await Promise.all([
                tasksDB.query(
                    `SELECT COUNT(*) as count FROM browserable.llm_calls 
                    WHERE account_id = $1 
                    AND metadata->>'flowId' = $2`,
                    [accountId, flowId]
                ),
                tasksDB.query(
                    `SELECT *
                    FROM browserable.llm_calls 
                    WHERE account_id = $1 
                    AND metadata->>'flowId' = $2
                    ORDER BY created_at DESC
                    LIMIT $3 OFFSET $4`,
                    [accountId, flowId, pageSize, offset]
                )
            ]);

            const totalCount = parseInt(countResult.rows[0].count);

            res.json({
                success: true,
                data: {
                    llmCalls: llmCalls.rows,
                    totalCount,
                    pageSize,
                    pageNumber,
                    totalPages: Math.ceil(totalCount / pageSize)
                }
            });
        } catch (e) {
            console.log(e);
            res.json({ success: false, error: e.message });
        }
    }
);

router.options(
    "/get/data-table",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    })
);
router.post(
    "/get/data-table",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    }),
    addUserToRequest,
    checkAccountAccess,
    async (req, res) => {
        let { pageSize = 50, pageNumber = 1, flowId, accountId, userId } = req.body || {};

        try {
            // Ensure positive integers
            pageSize = Math.max(1, Math.floor(Number(pageSize)));
            pageNumber = Math.max(1, Math.floor(Number(pageNumber)));
            pageSize = pageSize > 50 ? 50 : pageSize;

            const { documents, total } = await getDocumentsFromDataTable({
                flowId,
                accountId,
                userId,
                pageNumber,
                pageSize,
            });

            const schema = await getDataTableSchema({
                flowId,
                accountId,
                userId,
            });

            res.json({ success: true, data: { documents, total, schema, pageSize, pageNumber } });
        } catch (e) {
            console.log(e);
            res.json({ success: false, error: e.message });
        }
    }
);

router.options(
    "/get/flow/runs",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    })
);
router.post(
    "/get/flow/runs",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    }),
    addUserToRequest,
    checkAccountAccess,
    async (req, res) => {
        let { flowId, pageSize = 50, pageNumber = 1, sortOrder = 'DESC', accountId } = req.body || {};

        try {
            // Ensure positive integers and validate inputs
            pageSize = Math.max(1, Math.floor(Number(pageSize)));
            pageNumber = Math.max(1, Math.floor(Number(pageNumber)));
            pageSize = Math.min(50, pageSize);
            sortOrder = ['ASC', 'DESC'].includes(sortOrder) ? sortOrder : 'DESC';

            const offset = (pageNumber - 1) * pageSize;

            const tasksDB = await db.getTasksDB();

            // Get total count and paginated results in parallel
            const [countResult, runsResult] = await Promise.all([
                tasksDB.query(
                    `SELECT COUNT(*) as count FROM browserable.runs 
                    WHERE flow_id = $1 AND account_id = $2`,
                    [flowId, accountId]
                ),
                tasksDB.query(
                    `SELECT id, status, error, input, trigger_input, created_at, 
                            output, reasoning, structured_output, live_status
                    FROM browserable.runs 
                    WHERE flow_id = $1 AND account_id = $2
                    ORDER BY created_at ${sortOrder}
                    LIMIT $3 OFFSET $4`,
                    [flowId, accountId, pageSize, offset]
                )
            ]);

            const totalCount = parseInt(countResult.rows[0].count);

            res.json({
                success: true,
                data: {
                    runs: runsResult.rows,
                    totalCount,
                    pageSize,
                    pageNumber,
                    totalPages: Math.ceil(totalCount / pageSize)
                }
            });
        } catch (e) {
            console.log(e);
            res.json({ success: false, error: e.message });
        }
    }
);

router.options(
    "/get/flow/chart",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    })
);
router.post(
    "/get/flow/chart",
    cors({
        credentials: true,
        origin: process.env.CORS_DOMAINS.split(","),
    }),
    addUserToRequest,
    checkAccountAccess,
    async (req, res) => {
        const { runId, flowId, accountId } = req.body || {};

        try {
            const tasksDB = await db.getTasksDB();

            // Get nodes and threads in parallel with hard limits
            const [nodesResult, threadsResult, runResult] = await Promise.all([
                tasksDB.query(
                    `SELECT * FROM browserable.nodes 
                    WHERE run_id = $1
                    ORDER BY created_at ASC
                    LIMIT 50`,
                    [runId]
                ),
                tasksDB.query(
                    `SELECT * FROM browserable.threads 
                    WHERE run_id = $1
                    ORDER BY created_at ASC
                    LIMIT 50`,
                    [runId]
                ),
                tasksDB.query(
                    `SELECT * FROM browserable.runs 
                    WHERE id = $1`,
                    [runId]
                )
            ]);

            res.json({
                success: true,
                data: {
                    nodes: nodesResult.rows,
                    threads: threadsResult.rows,
                    run: runResult.rows[0]
                }
            });
        } catch (e) {
            console.log(e);
            res.json({ success: false, error: e.message });
        }
    }
);


module.exports = router;
