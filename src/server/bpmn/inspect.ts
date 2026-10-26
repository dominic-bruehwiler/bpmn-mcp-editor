/** Compact read models so an agent can inspect a diagram without parsing XML. */
import { children, flowElementsDeep, readDiagram, type Element } from "./moddle";
import { lintDiagram } from "./lint";
import { shortType, type Issue } from "./types";

const PROPERTY_KEYS = [
  "assignee",
  "candidateUsers",
  "candidateGroups",
  "dueDate",
  "followUpDate",
  "priority",
  "formKey",
  "formRef",
  "class",
  "delegateExpression",
  "expression",
  "resultVariable",
  "type",
  "topic",
  "decisionRef",
  "calledElement",
  "asyncBefore",
  "asyncAfter",
  "exclusive",
  "taskPriority",
  "historyTimeToLive",
  "scriptFormat",
  "script",
] as const;

export async function describeDiagram(xml: string, profile: "build" | "deploy" = "build") {
  const diagram = await readDiagram(xml);
  const elements = flowElementsDeep(diagram.process)
    .filter((element) => element.$type !== "bpmn:SequenceFlow" && element.$type !== "bpmn:Association")
    .map((element) => describeElement(diagram.process, element));
  const flows = flowElementsDeep(diagram.process)
    .filter((element) => element.$type === "bpmn:SequenceFlow" || element.$type === "bpmn:Association")
    .map((element) => ({
      id: element.id,
      kind: element.$type === "bpmn:Association" ? "association" : "sequence",
      name: element.name ?? null,
      sourceId: (element.sourceRef as Element | undefined)?.id ?? null,
      targetId: (element.targetRef as Element | undefined)?.id ?? null,
      condition: expressionBody(element.conditionExpression),
      isDefault: ((element.sourceRef as Element | undefined)?.default as Element | undefined)?.id === element.id,
    }));

  const issues = await lintDiagram(xml, profile);
  return {
    process: {
      id: diagram.process.id,
      name: diagram.process.name ?? null,
      isExecutable: diagram.process.isExecutable === true,
      historyTimeToLive: diagram.process.historyTimeToLive ?? null,
    },
    elements,
    flows,
    issues,
    counts: {
      elements: elements.length,
      flows: flows.filter((flow) => flow.kind === "sequence").length,
      errors: issues.filter((issue: Issue) => issue.severity === "error").length,
      warnings: issues.filter((issue: Issue) => issue.severity === "warning").length,
    },
  };
}

function describeElement(process: Element, element: Element) {
  const properties: Record<string, unknown> = {};
  for (const key of PROPERTY_KEYS) {
    if (element[key] !== undefined && element[key] !== null && element[key] !== "") {
      properties[key] = element[key];
    }
  }
  const extension = element.extensionElements as Element | undefined;
  const values = children(extension, "values");
  const inputOutput = values.find((value) => value.$type === "camunda:InputOutput");
  if (inputOutput) {
    properties.inputParameters = children(inputOutput, "inputParameters").map(parameterOf);
    properties.outputParameters = children(inputOutput, "outputParameters").map(parameterOf);
  }

  return {
    id: element.id,
    type: shortType(element.$type),
    name: element.name ?? (element.text as string | undefined) ?? null,
    parentId: parentId(process, element.id ?? "") ?? process.id,
    attachedToId: (element.attachedToRef as Element | undefined)?.id ?? null,
    documentation: documentationText(element),
    eventDefinitions: children(element, "eventDefinitions").map(describeDefinition),
    properties,
  };
}

function describeDefinition(definition: Element) {
  return {
    type: shortType(definition.$type).replace("EventDefinition", "").replace(/^./, (char) => char.toLowerCase()),
    timerDuration: expressionBody(definition.timeDuration),
    timerDate: expressionBody(definition.timeDate),
    timerCycle: expressionBody(definition.timeCycle),
    messageName: (definition.messageRef as Element | undefined)?.name ?? null,
    errorCode: (definition.errorRef as Element | undefined)?.errorCode ?? null,
    signalName: (definition.signalRef as Element | undefined)?.name ?? null,
    linkName: definition.name ?? null,
  };
}

function parentId(process: Element, id: string): string | undefined {
  const walk = (container: Element): string | undefined => {
    for (const child of children(container, "flowElements")) {
      if (child.id === id) return container.id;
      const nested = walk(child);
      if (nested) return nested;
    }
    return undefined;
  };
  return walk(process);
}

function parameterOf(parameter: Element) {
  return { name: parameter.name ?? null, value: parameter.value ?? null };
}

function expressionBody(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const body = (value as Element).body;
  return typeof body === "string" ? body : null;
}

function documentationText(element: Element): string | null {
  const text = children(element, "documentation")
    .map((entry) => entry.text)
    .filter((entry): entry is string => typeof entry === "string");
  return text[0] ?? null;
}
