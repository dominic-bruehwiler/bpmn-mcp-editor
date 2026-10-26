/**
 * MCP tools for Camunda 7 diagrams.
 * The tool set follows the semantic style of bpmn-js-mcp (element operations, lint, layout)
 * and the live-canvas idea of Camunda-mcp, with an exclusive lock so the browser stays still.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HttpError } from "./errors";
import {
  acquireLock,
  createProcess,
  deleteProcess,
  getProcess,
  importProcessXml,
  listProcesses,
  mutateProcess,
  releaseLock,
  validateStoredDiagram,
} from "./processes";
import type { DiagramOp, ElementType } from "./bpmn/types";

const elementTypes = [
  "startEvent",
  "endEvent",
  "intermediateCatchEvent",
  "intermediateThrowEvent",
  "boundaryEvent",
  "task",
  "userTask",
  "serviceTask",
  "scriptTask",
  "businessRuleTask",
  "sendTask",
  "receiveTask",
  "manualTask",
  "callActivity",
  "subProcess",
  "exclusiveGateway",
  "parallelGateway",
  "inclusiveGateway",
  "eventBasedGateway",
  "textAnnotation",
] as const satisfies readonly ElementType[];

const propertiesSchema = z.object({
  assignee: z.string().nullable().optional(),
  candidateUsers: z.string().nullable().optional(),
  candidateGroups: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  followUpDate: z.string().nullable().optional(),
  priority: z.string().nullable().optional(),
  formKey: z.string().nullable().optional(),
  formRef: z.string().nullable().optional(),
  formRefBinding: z.string().nullable().optional(),
  formRefVersion: z.string().nullable().optional(),
  formHandlerClass: z.string().nullable().optional(),
  class: z.string().nullable().optional(),
  delegateExpression: z.string().nullable().optional(),
  expression: z.string().nullable().optional(),
  resultVariable: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  topic: z.string().nullable().optional(),
  decisionRef: z.string().nullable().optional(),
  decisionRefBinding: z.string().nullable().optional(),
  decisionRefVersion: z.string().nullable().optional(),
  mapDecisionResult: z.string().nullable().optional(),
  calledElement: z.string().nullable().optional(),
  calledElementBinding: z.string().nullable().optional(),
  calledElementVersion: z.string().nullable().optional(),
  asyncBefore: z.boolean().nullable().optional(),
  asyncAfter: z.boolean().nullable().optional(),
  exclusive: z.boolean().nullable().optional(),
  taskPriority: z.string().nullable().optional(),
  historyTimeToLive: z.string().nullable().optional(),
  candidateStarterUsers: z.string().nullable().optional(),
  candidateStarterGroups: z.string().nullable().optional(),
  scriptFormat: z.string().nullable().optional(),
  script: z.string().nullable().optional(),
  inputParameters: z.array(z.object({ name: z.string(), value: z.string().optional() })).optional(),
  outputParameters: z.array(z.object({ name: z.string(), value: z.string().optional() })).optional(),
  executionListeners: z.array(listenerSchema()).optional(),
  taskListeners: z.array(listenerSchema()).optional(),
}).optional();

function listenerSchema() {
  return z.object({
    event: z.string(),
    class: z.string().optional(),
    expression: z.string().optional(),
    delegateExpression: z.string().optional(),
  });
}

const eventDefinitionSchema = z.object({
  type: z.enum(["message", "timer", "error", "signal", "escalation", "terminate", "conditional", "link", "compensation", "cancel"]),
  timerDuration: z.string().optional(),
  timerDate: z.string().optional(),
  timerCycle: z.string().optional(),
  messageName: z.string().optional(),
  errorCode: z.string().optional(),
  signalName: z.string().optional(),
  escalationCode: z.string().optional(),
  linkName: z.string().optional(),
  condition: z.string().optional(),
}).optional();

const addSchema = z.object({
  type: z.enum(elementTypes),
  id: z.string().optional(),
  ref: z.string().optional(),
  name: z.string().optional(),
  parentId: z.string().optional(),
  attachToId: z.string().optional(),
  cancelActivity: z.boolean().optional(),
  eventDefinition: eventDefinitionSchema,
  documentation: z.string().optional(),
  properties: propertiesSchema,
});

const lockFields = {
  id: z.string().describe("Stored diagram id (proc_...), not the BPMN process id."),
  lockToken: z.string().describe("Token from acquire_lock or create_process."),
  expectedRevision: z.number().int().describe("Revision from the last read or write. The call is rejected if it does not match."),
};

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "bpmn-mcp-editor", version: "1.0.0" });

  server.registerTool("list_processes", {
    description: "List stored Camunda 7 diagrams with revision and lock state. Does not return XML.",
    annotations: { readOnlyHint: true },
  }, async () => result(async () => listProcesses()));

  server.registerTool("create_process", {
    description: "Create an executable Camunda 7 process with a start event and historyTimeToLive. Locks it for the agent and returns lockToken, revision, and the start event id StartEvent_1.",
    inputSchema: {
      name: z.string().min(1),
      processId: z.string().optional().describe("BPMN process id. Generated when omitted."),
      historyTimeToLive: z.string().optional().describe("Days the engine keeps history. Defaults to 180."),
    },
  }, async (input) => result(() => createProcess({ ...input, lockForAgent: true })));

  server.registerTool("get_process", {
    description: "Read a diagram. view=summary returns counts and lint, view=elements returns every node and flow, view=xml returns the BPMN XML.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      id: z.string(),
      view: z.enum(["summary", "elements", "xml"]).optional(),
      profile: z.enum(["build", "deploy"]).optional().describe("deploy flags missing end events and labels as errors. build is the lenient profile used while editing."),
    },
  }, async ({ id, view = "summary", profile = "deploy" }) => result(async () => {
    const process = await getProcess(id);
    if (view === "xml") {
      return { id: process.id, name: process.name, revision: process.revision, lock: process.lock, xml: process.xml };
    }
    const described = await validateStoredDiagram(id, profile);
    if (view === "summary") {
      return {
        id: described.id,
        revision: described.revision,
        profile: described.profile,
        process: described.process,
        counts: described.counts,
        issues: described.issues,
      };
    }
    return described;
  }));

  server.registerTool("acquire_lock", {
    description: "Lock a diagram so the user cannot edit while the agent works. Fails when the user edited in the last few seconds or another agent holds the lock. Lock expires after 45 seconds without a mutation.",
    inputSchema: { id: z.string() },
  }, async ({ id }) => result(() => acquireLock(id)));

  server.registerTool("release_lock", {
    description: "Release the agent lock and return a deploy-profile lint report.",
    inputSchema: { id: z.string(), lockToken: z.string() },
  }, async ({ id, lockToken }) => result(() => releaseLock(id, lockToken)));

  server.registerTool("add_elements", {
    description: "Add one or more BPMN elements. connect=chain links them in order, optionally starting at sourceId (use StartEvent_1 on a new process). A service task, script task, business rule task, or call activity must include its Camunda implementation in properties or the change is rejected. Boundary events need attachToId. Timer events need timerDuration, timerDate, or timerCycle. Message events need messageName.",
    inputSchema: {
      ...lockFields,
      connect: z.enum(["chain", "none"]).optional(),
      sourceId: z.string().optional(),
      elements: z.array(addSchema).min(1),
    },
  }, async ({ id, lockToken, expectedRevision, connect = "none", sourceId, elements }) => result(() => {
    const ops: DiagramOp[] = [];
    let previous = sourceId;
    elements.forEach((element, index) => {
      const ref = element.ref ?? `added_${index}`;
      ops.push({ op: "add", ...element, ref });
      if (connect === "chain" && previous) ops.push({ op: "connect", sourceId: previous, targetId: ref });
      previous = ref;
    });
    return mutateProcess({ id, lockToken, expectedRevision, ops });
  }));

  server.registerTool("connect_elements", {
    description: "Add a sequence flow. Use condition (${approved}) on exclusive-gateway branches and isDefault for the default branch. Connecting a text annotation creates an association.",
    inputSchema: {
      ...lockFields,
      sourceId: z.string(),
      targetId: z.string(),
      name: z.string().optional(),
      condition: z.string().optional(),
      isDefault: z.boolean().optional(),
    },
  }, async ({ id, lockToken, expectedRevision, sourceId, targetId, name, condition, isDefault }) => result(() =>
    mutateProcess({
      id,
      lockToken,
      expectedRevision,
      ops: [{ op: "connect", sourceId, targetId, name, condition, isDefault }],
    }),
  ));

  server.registerTool("update_element", {
    description: "Change a label, documentation, sequence-flow condition, or Camunda 7 properties without moving shapes. Set a string property to null to clear it. class, expression, delegateExpression, and topic are mutually exclusive. topic sets the task to an external worker.",
    inputSchema: {
      ...lockFields,
      elementId: z.string().describe("Element id or the BPMN process id for process-level properties such as historyTimeToLive."),
      name: z.string().optional(),
      documentation: z.string().optional(),
      isExecutable: z.boolean().optional(),
      condition: z.string().nullable().optional(),
      properties: propertiesSchema,
    },
  }, async ({ id, lockToken, expectedRevision, elementId, name, documentation, isExecutable, condition, properties }) => result(() =>
    mutateProcess({
      id,
      lockToken,
      expectedRevision,
      ops: [{ op: "update", elementId, name, documentation, isExecutable, condition, properties }],
    }),
  ));

  server.registerTool("delete_element", {
    description: "Delete a node or flow, including its sequence flows and boundary events, then auto-align the diagram.",
    annotations: { destructiveHint: true },
    inputSchema: { ...lockFields, elementId: z.string() },
  }, async ({ id, lockToken, expectedRevision, elementId }) => result(() =>
    mutateProcess({ id, lockToken, expectedRevision, ops: [{ op: "delete", elementId }] }),
  ));

  server.registerTool("batch_edit", {
    description: "Apply several add, connect, update, and delete operations as one revision. Later operations can use ref values from earlier adds. The diagram is auto-aligned once at the end and rejected as a whole when validation fails.",
    inputSchema: {
      ...lockFields,
      operations: z.array(z.discriminatedUnion("op", [
        addSchema.extend({ op: z.literal("add") }),
        z.object({
          op: z.literal("connect"),
          sourceId: z.string(),
          targetId: z.string(),
          ref: z.string().optional(),
          name: z.string().optional(),
          condition: z.string().optional(),
          isDefault: z.boolean().optional(),
        }),
        z.object({
          op: z.literal("update"),
          elementId: z.string(),
          name: z.string().optional(),
          documentation: z.string().optional(),
          isExecutable: z.boolean().optional(),
          condition: z.string().nullable().optional(),
          properties: propertiesSchema,
        }),
        z.object({ op: z.literal("delete"), elementId: z.string() }),
      ])).min(1),
    },
  }, async ({ id, lockToken, expectedRevision, operations }) => result(() =>
    mutateProcess({ id, lockToken, expectedRevision, ops: operations }),
  ));

  server.registerTool("auto_layout", {
    description: "Re-align the diagram left to right. Rejected when the diagram has validation errors.",
    inputSchema: { ...lockFields },
  }, async ({ id, lockToken, expectedRevision }) => result(() =>
    mutateProcess({ id, lockToken, expectedRevision, ops: [], layout: true }),
  ));

  server.registerTool("validate_process", {
    description: "Lint a diagram. profile=deploy is the Camunda 7 readiness check (missing start, end, and labels are errors). profile=build is what editing tools enforce.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      id: z.string(),
      profile: z.enum(["build", "deploy"]).optional(),
    },
  }, async ({ id, profile = "deploy" }) => result(() => validateStoredDiagram(id, profile)));

  server.registerTool("import_bpmn", {
    description: "Replace a diagram with BPMN XML. Missing DI is auto-aligned. The import is rejected when the build-profile validation fails, and the previous XML stays stored.",
    inputSchema: { ...lockFields, xml: z.string().min(1) },
  }, async ({ id, lockToken, expectedRevision, xml }) => result(() =>
    importProcessXml({ id, lockToken, expectedRevision, xml }),
  ));

  server.registerTool("delete_process", {
    description: "Delete a stored diagram. Fails while an agent lock is held.",
    annotations: { destructiveHint: true },
    inputSchema: { id: z.string() },
  }, async ({ id }) => result(async () => {
    await deleteProcess(id);
    return { deleted: id };
  }));

  return server;
}

function result(work: () => Promise<unknown>) {
  return work()
    .then((value) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] }))
    .catch((error: unknown) => {
      const body = error instanceof HttpError
        ? { error: error.message, status: error.status, issues: error.issues }
        : { error: error instanceof Error ? error.message : "Unknown error" };
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
      };
    });
}
