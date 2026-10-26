/**
 * Semantic BPMN edits. Callers pass short operations; this module updates the moddle tree,
 * lays out structural changes, and rejects the result when the build-profile lint has errors.
 */
import { BadRequestError, ValidationError } from "../errors";
import { layoutDiagram } from "./layout";
import { lintDiagram } from "./lint";
import {
  children,
  collectIds,
  createId,
  findContainer,
  findElement,
  readDiagram,
  writeDiagram,
  type Element,
} from "./moddle";
import {
  ELEMENT_TYPES,
  type DiagramOp,
  type ElementProperties,
  type ElementType,
  type EventDefinitionInput,
  type EventDefinitionType,
  type Issue,
  type ListenerProperties,
} from "./types";

const EVENT_DEFINITION_TYPES: Record<EventDefinitionType, string> = {
  message: "bpmn:MessageEventDefinition",
  timer: "bpmn:TimerEventDefinition",
  error: "bpmn:ErrorEventDefinition",
  signal: "bpmn:SignalEventDefinition",
  escalation: "bpmn:EscalationEventDefinition",
  terminate: "bpmn:TerminateEventDefinition",
  conditional: "bpmn:ConditionalEventDefinition",
  link: "bpmn:LinkEventDefinition",
  compensation: "bpmn:CompensateEventDefinition",
  cancel: "bpmn:CancelEventDefinition",
};

const ALLOWED_EVENTS: Record<string, EventDefinitionType[]> = {
  "bpmn:StartEvent": ["message", "timer", "conditional", "signal", "error", "escalation", "compensation"],
  "bpmn:EndEvent": ["message", "error", "escalation", "cancel", "compensation", "signal", "terminate"],
  "bpmn:IntermediateCatchEvent": ["message", "timer", "conditional", "link", "signal"],
  "bpmn:IntermediateThrowEvent": ["message", "link", "compensation", "signal", "escalation"],
  "bpmn:BoundaryEvent": ["message", "timer", "conditional", "signal", "error", "escalation", "cancel", "compensation"],
};

const IMPLEMENTATION_KEYS = ["class", "delegateExpression", "expression", "topic"] as const;

const STRING_PROPERTIES = [
  "assignee",
  "candidateUsers",
  "candidateGroups",
  "dueDate",
  "followUpDate",
  "priority",
  "formKey",
  "formRef",
  "formRefBinding",
  "formRefVersion",
  "formHandlerClass",
  "class",
  "delegateExpression",
  "expression",
  "resultVariable",
  "type",
  "topic",
  "decisionRef",
  "decisionRefBinding",
  "decisionRefVersion",
  "mapDecisionResult",
  "calledElement",
  "calledElementBinding",
  "calledElementVersion",
  "taskPriority",
  "historyTimeToLive",
  "candidateStarterUsers",
  "candidateStarterGroups",
  "scriptFormat",
  "script",
] as const;

const BOOLEAN_PROPERTIES = ["asyncBefore", "asyncAfter", "exclusive"] as const;

export async function createExecutableDiagram(input: {
  name: string;
  processId: string;
  historyTimeToLive?: string;
}): Promise<string> {
  const diagram = await readDiagram(blankDefinitions());
  diagram.definitions.id = "Definitions_1";
  diagram.process.id = input.processId;
  diagram.process.name = input.name;
  diagram.process.isExecutable = true;
  diagram.process.historyTimeToLive = input.historyTimeToLive ?? "180";

  // StartEvent_1 is stable so an agent can chain from a process it just created.
  const start = diagram.moddle.create("bpmn:StartEvent", { id: "StartEvent_1", name: "Start" });
  diagram.process.flowElements = [start];
  const xml = await writeDiagram(diagram);
  return layoutDiagram(xml);
}

export async function editDiagram(
  xml: string,
  ops: DiagramOp[],
  options?: { layout?: boolean; profile?: "build" | "deploy" },
): Promise<{ xml: string; issues: Issue[]; refs: Record<string, string>; name: string }> {
  const diagram = await readDiagram(xml);
  const refs: Record<string, string> = {};
  for (const op of ops) applyOp(diagram, op, refs);

  let next = await writeDiagram(diagram);
  const structural = options?.layout ?? ops.some((op) => op.op !== "update");
  if (structural) next = await layoutDiagram(next);

  const profile = options?.profile ?? "build";
  const issues = await lintDiagram(next, profile);
  const errors = issues.filter((issue) => issue.severity === "error");
  if (errors.length > 0) {
    throw new ValidationError("The change was rejected because the diagram would be invalid.", issues);
  }

  const named = await readDiagram(next);
  return {
    xml: next,
    issues,
    refs,
    name: stringValue(named.process.name) ?? stringValue(named.process.id) ?? "Process",
  };
}

export async function renameDiagram(xml: string, name: string): Promise<string> {
  const diagram = await readDiagram(xml);
  diagram.process.name = name;
  return writeDiagram(diagram);
}

function applyOp(
  diagram: Awaited<ReturnType<typeof readDiagram>>,
  op: DiagramOp,
  refs: Record<string, string>,
) {
  if (op.op === "add") addElement(diagram, op, refs);
  else if (op.op === "connect") connectElements(diagram, op, refs);
  else if (op.op === "update") updateElement(diagram, op, refs);
  else deleteElement(diagram, resolveId(refs, op.elementId));
}

function addElement(
  diagram: Awaited<ReturnType<typeof readDiagram>>,
  op: Extract<DiagramOp, { op: "add" }>,
  refs: Record<string, string>,
) {
  const taken = collectIds(diagram.definitions);
  const bpmnType = ELEMENT_TYPES[op.type];
  const id = op.id ?? createId(idPrefix(op.type), taken);
  if (taken.has(id) && op.id) {
    throw new BadRequestError(`Element id "${id}" already exists.`);
  }
  if (!/^[A-Za-z_][\w.-]*$/.test(id)) {
    throw new BadRequestError(`Element id "${id}" is not a valid BPMN id.`);
  }

  const element = diagram.moddle.create(bpmnType, { id, name: op.name });
  if (op.type === "textAnnotation" && op.name) element.text = op.name;

  const container = op.parentId
    ? requireSubProcess(diagram, resolveId(refs, op.parentId))
    : diagram.process;

  if (op.type === "boundaryEvent") {
    const hostId = op.attachToId ? resolveId(refs, op.attachToId) : undefined;
    const host = hostId ? findElement(diagram, hostId) : undefined;
    if (!host || !isActivity(host.$type)) {
      throw new BadRequestError("A boundary event needs attachToId pointing at an activity.");
    }
    element.attachedToRef = host;
    element.cancelActivity = op.cancelActivity ?? true;
    const hostContainer = findContainer(diagram.process, host.id ?? "") ?? diagram.process;
    pushFlowElement(hostContainer, element);
  } else {
    pushFlowElement(container, element);
  }

  if (op.eventDefinition) applyEventDefinition(diagram, element, op.eventDefinition);
  else if (requiresDefinition(element.$type)) {
    throw new BadRequestError(`${op.type} needs an eventDefinition.`);
  }

  if (op.documentation) setDocumentation(diagram, element, op.documentation);
  if (op.properties) applyProperties(diagram, element, op.properties);
  if (op.ref) refs[op.ref] = id;
}

function connectElements(
  diagram: Awaited<ReturnType<typeof readDiagram>>,
  op: Extract<DiagramOp, { op: "connect" }>,
  refs: Record<string, string>,
) {
  const source = requireElement(diagram, resolveId(refs, op.sourceId));
  const target = requireElement(diagram, resolveId(refs, op.targetId));
  if (source.id === target.id) throw new BadRequestError("An element cannot connect to itself.");

  const annotation = source.$type === "bpmn:TextAnnotation" || target.$type === "bpmn:TextAnnotation";
  const type = annotation ? "bpmn:Association" : "bpmn:SequenceFlow";
  if (!annotation) assertFlowConnection(source, target);

  const duplicate = children(findContainer(diagram.process, source.id ?? "") ?? diagram.process, "flowElements").some(
    (element) =>
      element.$type === type &&
      (element.sourceRef as Element | undefined)?.id === source.id &&
      (element.targetRef as Element | undefined)?.id === target.id,
  );
  if (duplicate) throw new BadRequestError(`"${source.id}" is already connected to "${target.id}".`);

  const id = createId(annotation ? "Association" : "Flow", collectIds(diagram.definitions));
  const flow = diagram.moddle.create(type, { id, name: op.name, sourceRef: source, targetRef: target });
  if (!annotation && op.condition) {
    flow.conditionExpression = diagram.moddle.create("bpmn:FormalExpression", { body: op.condition });
  }
  if (op.isDefault) {
    if (!source.$type.endsWith("Gateway")) {
      throw new BadRequestError("Only a gateway can mark a default flow.");
    }
    source.default = flow;
  }

  source.outgoing = [...children(source, "outgoing"), flow];
  target.incoming = [...children(target, "incoming"), flow];
  const container = findContainer(diagram.process, source.id ?? "") ?? diagram.process;
  pushFlowElement(container, flow);
  if (op.ref) refs[op.ref] = id;
}

function updateElement(
  diagram: Awaited<ReturnType<typeof readDiagram>>,
  op: Extract<DiagramOp, { op: "update" }>,
  refs: Record<string, string>,
) {
  const element = requireElement(diagram, resolveId(refs, op.elementId));
  if (op.name !== undefined) {
    element.name = op.name;
    if (element.$type === "bpmn:TextAnnotation") element.text = op.name;
  }
  if (op.documentation !== undefined) setDocumentation(diagram, element, op.documentation);
  if (op.isExecutable !== undefined) {
    if (element.$type !== "bpmn:Process") throw new BadRequestError("isExecutable belongs on the process.");
    element.isExecutable = op.isExecutable;
  }
  if (op.condition !== undefined) {
    if (element.$type !== "bpmn:SequenceFlow") {
      throw new BadRequestError("A condition belongs on a sequence flow.");
    }
    element.conditionExpression = op.condition
      ? diagram.moddle.create("bpmn:FormalExpression", { body: op.condition })
      : undefined;
  }
  if (op.properties) applyProperties(diagram, element, op.properties);
}

function deleteElement(diagram: Awaited<ReturnType<typeof readDiagram>>, id: string) {
  if (id === diagram.process.id) throw new BadRequestError("The process element cannot be deleted.");
  const container = findContainer(diagram.process, id);
  const element = findElement(diagram, id);
  if (!container || !element) throw new BadRequestError(`Unknown element "${id}".`);

  const attached = children(container, "flowElements").filter(
    (candidate) => (candidate.attachedToRef as Element | undefined)?.id === id,
  );
  for (const boundary of attached) deleteElement(diagram, boundary.id ?? "");

  const flows = children(container, "flowElements").filter((candidate) => {
    if (candidate.$type !== "bpmn:SequenceFlow" && candidate.$type !== "bpmn:Association") return false;
    return (candidate.sourceRef as Element | undefined)?.id === id || (candidate.targetRef as Element | undefined)?.id === id;
  });
  for (const flow of flows) removeFlow(diagram, flow);

  removeFromContainer(container, id);
  for (const node of [diagram.process, ...descendants(diagram.process)]) {
    node.incoming = children(node, "incoming").filter((item) => item.id !== id);
    node.outgoing = children(node, "outgoing").filter((item) => item.id !== id);
    if ((node.default as Element | undefined)?.id === id) node.default = undefined;
    if ((node.attachedToRef as Element | undefined)?.id === id) node.attachedToRef = undefined;
  }
}

function removeFlow(diagram: Awaited<ReturnType<typeof readDiagram>>, flow: Element) {
  const source = flow.sourceRef as Element | undefined;
  const target = flow.targetRef as Element | undefined;
  if (source) {
    source.outgoing = children(source, "outgoing").filter((item) => item.id !== flow.id);
    if ((source.default as Element | undefined)?.id === flow.id) source.default = undefined;
  }
  if (target) target.incoming = children(target, "incoming").filter((item) => item.id !== flow.id);
  const container = findContainer(diagram.process, flow.id ?? "");
  if (container && flow.id) removeFromContainer(container, flow.id);
}

function applyEventDefinition(
  diagram: Awaited<ReturnType<typeof readDiagram>>,
  element: Element,
  input: EventDefinitionInput,
) {
  const allowed = ALLOWED_EVENTS[element.$type];
  if (!allowed?.includes(input.type)) {
    throw new BadRequestError(`${input.type} is not allowed on ${element.$type}.`);
  }

  const definition = diagram.moddle.create(EVENT_DEFINITION_TYPES[input.type], {
    id: createId(input.type[0].toUpperCase() + input.type.slice(1) + "Definition", collectIds(diagram.definitions)),
  });

  if (input.type === "timer") {
    if (!input.timerDuration && !input.timerDate && !input.timerCycle) {
      throw new BadRequestError("A timer needs timerDuration, timerDate, or timerCycle.");
    }
    if (input.timerDuration) definition.timeDuration = formal(diagram, input.timerDuration);
    if (input.timerDate) definition.timeDate = formal(diagram, input.timerDate);
    if (input.timerCycle) definition.timeCycle = formal(diagram, input.timerCycle);
  }
  if (input.type === "message") {
    if (!input.messageName) throw new BadRequestError("A message event needs messageName.");
    definition.messageRef = upsertRoot(diagram, "bpmn:Message", input.messageName, { name: input.messageName });
  }
  if (input.type === "error") {
    definition.errorRef = upsertRoot(diagram, "bpmn:Error", input.errorCode ?? input.messageName ?? "Error", {
      name: input.errorCode ?? "Error",
      errorCode: input.errorCode ?? "ERROR",
    });
  }
  if (input.type === "signal") {
    if (!input.signalName) throw new BadRequestError("A signal event needs signalName.");
    definition.signalRef = upsertRoot(diagram, "bpmn:Signal", input.signalName, { name: input.signalName });
  }
  if (input.type === "escalation") {
    definition.escalationRef = upsertRoot(diagram, "bpmn:Escalation", input.escalationCode ?? "Escalation", {
      name: input.escalationCode ?? "Escalation",
      escalationCode: input.escalationCode ?? "ESCALATION",
    });
  }
  if (input.type === "link") {
    if (!input.linkName) throw new BadRequestError("A link event needs linkName.");
    definition.name = input.linkName;
  }
  if (input.type === "conditional" && input.condition) {
    definition.condition = formal(diagram, input.condition);
  }

  element.eventDefinitions = [definition];
}

function applyProperties(
  diagram: Awaited<ReturnType<typeof readDiagram>>,
  element: Element,
  properties: ElementProperties,
) {
  const providedImplementation = IMPLEMENTATION_KEYS.filter((key) => properties[key]);
  if (providedImplementation.length > 1) {
    throw new BadRequestError("Set only one of class, expression, delegateExpression, or topic.");
  }

  if (providedImplementation.length === 1) {
    for (const key of IMPLEMENTATION_KEYS) delete element[key];
    delete element.type;
  }

  for (const key of STRING_PROPERTIES) {
    if (properties[key] === undefined) continue;
    assertPropertyAllowed(element, key);
    if (properties[key] === null || properties[key] === "") delete element[key];
    else element[key] = properties[key];
  }
  for (const key of BOOLEAN_PROPERTIES) {
    if (properties[key] === undefined) continue;
    assertPropertyAllowed(element, key);
    if (properties[key] === null) delete element[key];
    else element[key] = properties[key];
  }

  if (properties.topic) {
    element.type = properties.type ?? "external";
  }

  if (properties.inputParameters || properties.outputParameters) {
    replaceParameters(diagram, element, properties);
  }
  if (properties.executionListeners) replaceListeners(diagram, element, "camunda:ExecutionListener", properties.executionListeners);
  if (properties.taskListeners) {
    if (element.$type !== "bpmn:UserTask") throw new BadRequestError("Task listeners belong on a user task.");
    replaceListeners(diagram, element, "camunda:TaskListener", properties.taskListeners);
  }
}

function assertPropertyAllowed(element: Element, key: string) {
  const type = element.$type;
  const allowed =
    (key === "assignee" || key === "candidateUsers" || key === "candidateGroups" || key === "dueDate" || key === "followUpDate" || key === "priority"
      ? type === "bpmn:UserTask"
      : key === "formKey" || key === "formRef" || key === "formRefBinding" || key === "formRefVersion" || key === "formHandlerClass"
        ? type === "bpmn:UserTask" || type === "bpmn:StartEvent"
        : key === "class" || key === "delegateExpression" || key === "expression" || key === "resultVariable" || key === "type" || key === "topic"
          ? type === "bpmn:ServiceTask" || type === "bpmn:SendTask" || type === "bpmn:BusinessRuleTask" || type === "bpmn:MessageEventDefinition"
          : key === "decisionRef" || key === "decisionRefBinding" || key === "decisionRefVersion" || key === "mapDecisionResult"
            ? type === "bpmn:BusinessRuleTask"
            : key === "calledElement" || key === "calledElementBinding" || key === "calledElementVersion"
              ? type === "bpmn:CallActivity"
              : key === "script" || key === "scriptFormat"
                ? type === "bpmn:ScriptTask"
                : key === "historyTimeToLive" || key === "candidateStarterUsers" || key === "candidateStarterGroups" || key === "taskPriority"
                  ? type === "bpmn:Process"
                  : isFlowNode(type));

  if (!allowed) {
    throw new BadRequestError(`Property "${key}" is not valid on ${type}.`);
  }
}

function replaceParameters(
  diagram: Awaited<ReturnType<typeof readDiagram>>,
  element: Element,
  properties: ElementProperties,
) {
  if (!isFlowNode(element.$type)) throw new BadRequestError(`Input/output mappings are not valid on ${element.$type}.`);
  const values = extensionValues(diagram, element).filter((value) => value.$type !== "camunda:InputOutput");
  const current = extensionValues(diagram, element).find((value) => value.$type === "camunda:InputOutput");
  const inputOutput = diagram.moddle.create("camunda:InputOutput", {
    inputParameters: (properties.inputParameters ?? parameterList(current?.inputParameters)).map((parameter) =>
      diagram.moddle.create("camunda:InputParameter", { name: parameter.name, value: parameter.value ?? "" }),
    ),
    outputParameters: (properties.outputParameters ?? parameterList(current?.outputParameters)).map((parameter) =>
      diagram.moddle.create("camunda:OutputParameter", { name: parameter.name, value: parameter.value ?? "" }),
    ),
  });
  values.push(inputOutput);
  setExtensionValues(diagram, element, values);
}

function replaceListeners(
  diagram: Awaited<ReturnType<typeof readDiagram>>,
  element: Element,
  type: "camunda:ExecutionListener" | "camunda:TaskListener",
  listeners: ListenerProperties[],
) {
  const values = extensionValues(diagram, element).filter((value) => value.$type !== type);
  for (const listener of listeners) {
    if (!listener.class && !listener.expression && !listener.delegateExpression) {
      throw new BadRequestError("A listener needs class, expression, or delegateExpression.");
    }
    values.push(diagram.moddle.create(type, listener));
  }
  setExtensionValues(diagram, element, values);
}

function extensionValues(diagram: Awaited<ReturnType<typeof readDiagram>>, element: Element): Element[] {
  const extension = element.extensionElements as Element | undefined;
  if (!extension) {
    element.extensionElements = diagram.moddle.create("bpmn:ExtensionElements", { values: [] });
  }
  const values = (element.extensionElements as Element).values;
  if (!Array.isArray(values)) (element.extensionElements as Element).values = [];
  return (element.extensionElements as Element).values as Element[];
}

function setExtensionValues(diagram: Awaited<ReturnType<typeof readDiagram>>, element: Element, values: Element[]) {
  if (values.length === 0) {
    element.extensionElements = undefined;
    return;
  }
  element.extensionElements = diagram.moddle.create("bpmn:ExtensionElements", { values });
}

function parameterList(value: unknown): { name: string; value?: string }[] {
  if (!Array.isArray(value)) return [];
  return value.map((parameter: Element) => ({
    name: String(parameter.name ?? ""),
    value: parameter.value === undefined ? undefined : String(parameter.value),
  }));
}

function upsertRoot(
  diagram: Awaited<ReturnType<typeof readDiagram>>,
  type: string,
  name: string,
  attributes: Record<string, unknown>,
): Element {
  const roots = children(diagram.definitions, "rootElements");
  const existing = roots.find((element) => element.$type === type && element.name === name);
  if (existing) return existing;
  const created = diagram.moddle.create(type, {
    id: createId(type.split(":")[1], collectIds(diagram.definitions)),
    ...attributes,
  });
  diagram.definitions.rootElements = [...roots, created];
  return created;
}

function formal(diagram: Awaited<ReturnType<typeof readDiagram>>, body: string): Element {
  return diagram.moddle.create("bpmn:FormalExpression", { body });
}

function setDocumentation(diagram: Awaited<ReturnType<typeof readDiagram>>, element: Element, text: string) {
  element.documentation = text
    ? [diagram.moddle.create("bpmn:Documentation", { text })]
    : [];
}

function resolveId(refs: Record<string, string>, token: string): string {
  return refs[token] ?? token;
}

function requireElement(diagram: Awaited<ReturnType<typeof readDiagram>>, id: string): Element {
  const element = findElement(diagram, id);
  if (!element) throw new BadRequestError(`Unknown element "${id}".`);
  return element;
}

function requireSubProcess(diagram: Awaited<ReturnType<typeof readDiagram>>, id: string): Element {
  const element = requireElement(diagram, id);
  if (element.$type !== "bpmn:SubProcess") throw new BadRequestError(`"${id}" is not a subprocess.`);
  return element;
}

function pushFlowElement(container: Element, element: Element) {
  container.flowElements = [...children(container, "flowElements"), element];
}

function removeFromContainer(container: Element, id: string) {
  container.flowElements = children(container, "flowElements").filter((element) => element.id !== id);
}

function descendants(process: Element): Element[] {
  const found: Element[] = [];
  const walk = (container: Element) => {
    for (const child of children(container, "flowElements")) {
      found.push(child);
      walk(child);
    }
  };
  walk(process);
  return found;
}

function assertFlowConnection(source: Element, target: Element) {
  if (!isFlowNode(source.$type) || !isFlowNode(target.$type)) {
    throw new BadRequestError("Sequence flows connect flow nodes. Use a text annotation for an association.");
  }
  if (target.$type === "bpmn:StartEvent") throw new BadRequestError("A start event cannot have an incoming flow.");
  if (source.$type === "bpmn:EndEvent") throw new BadRequestError("An end event cannot have an outgoing flow.");
}

function requiresDefinition(type: string): boolean {
  return type === "bpmn:IntermediateCatchEvent" || type === "bpmn:BoundaryEvent";
}

function isActivity(type: string): boolean {
  return type.endsWith("Task") || type === "bpmn:CallActivity" || type === "bpmn:SubProcess" || type === "bpmn:Task";
}

function isFlowNode(type: string): boolean {
  return isActivity(type) || type.endsWith("Event") || type.endsWith("Gateway");
}

function idPrefix(type: ElementType): string {
  return ELEMENT_TYPES[type].split(":")[1];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function blankDefinitions(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:camunda="http://camunda.org/schema/1.0/bpmn" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="true" />
</bpmn:definitions>`;
}
