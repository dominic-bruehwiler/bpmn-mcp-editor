/**
 * Shared BPMN editing types. The short element names are the MCP-facing vocabulary;
 * they map onto BPMN 2.0 types in the editor.
 */

export type Issue = {
  rule: string;
  severity: "error" | "warning" | "info";
  message: string;
  elementId?: string;
};

export type ElementType =
  | "startEvent"
  | "endEvent"
  | "intermediateCatchEvent"
  | "intermediateThrowEvent"
  | "boundaryEvent"
  | "task"
  | "userTask"
  | "serviceTask"
  | "scriptTask"
  | "businessRuleTask"
  | "sendTask"
  | "receiveTask"
  | "manualTask"
  | "callActivity"
  | "subProcess"
  | "exclusiveGateway"
  | "parallelGateway"
  | "inclusiveGateway"
  | "eventBasedGateway"
  | "textAnnotation";

export type EventDefinitionType =
  | "message"
  | "timer"
  | "error"
  | "signal"
  | "escalation"
  | "terminate"
  | "conditional"
  | "link"
  | "compensation"
  | "cancel";

/** Camunda 7 attributes plus the few BPMN fields an executable process needs. */
export type ElementProperties = {
  assignee?: string | null;
  candidateUsers?: string | null;
  candidateGroups?: string | null;
  dueDate?: string | null;
  followUpDate?: string | null;
  priority?: string | null;
  formKey?: string | null;
  formRef?: string | null;
  formRefBinding?: string | null;
  formRefVersion?: string | null;
  formHandlerClass?: string | null;
  class?: string | null;
  delegateExpression?: string | null;
  expression?: string | null;
  resultVariable?: string | null;
  type?: string | null;
  topic?: string | null;
  decisionRef?: string | null;
  decisionRefBinding?: string | null;
  decisionRefVersion?: string | null;
  mapDecisionResult?: string | null;
  calledElement?: string | null;
  calledElementBinding?: string | null;
  calledElementVersion?: string | null;
  asyncBefore?: boolean | null;
  asyncAfter?: boolean | null;
  exclusive?: boolean | null;
  taskPriority?: string | null;
  historyTimeToLive?: string | null;
  candidateStarterUsers?: string | null;
  candidateStarterGroups?: string | null;
  scriptFormat?: string | null;
  script?: string | null;
  inputParameters?: { name: string; value?: string }[];
  outputParameters?: { name: string; value?: string }[];
  executionListeners?: ListenerProperties[];
  taskListeners?: ListenerProperties[];
};

export type ListenerProperties = {
  event: string;
  class?: string;
  expression?: string;
  delegateExpression?: string;
};

export type EventDefinitionInput = {
  type: EventDefinitionType;
  timerDuration?: string;
  timerDate?: string;
  timerCycle?: string;
  messageName?: string;
  errorCode?: string;
  signalName?: string;
  escalationCode?: string;
  linkName?: string;
  condition?: string;
};

export type DiagramOp =
  | {
      op: "add";
      type: ElementType;
      id?: string;
      ref?: string;
      name?: string;
      parentId?: string;
      attachToId?: string;
      cancelActivity?: boolean;
      eventDefinition?: EventDefinitionInput;
      documentation?: string;
      properties?: ElementProperties;
    }
  | {
      op: "connect";
      sourceId: string;
      targetId: string;
      ref?: string;
      name?: string;
      condition?: string;
      isDefault?: boolean;
    }
  | {
      op: "update";
      elementId: string;
      name?: string;
      documentation?: string;
      isExecutable?: boolean;
      condition?: string | null;
      properties?: ElementProperties;
    }
  | {
      op: "delete";
      elementId: string;
    };

export const ELEMENT_TYPES: Record<ElementType, string> = {
  startEvent: "bpmn:StartEvent",
  endEvent: "bpmn:EndEvent",
  intermediateCatchEvent: "bpmn:IntermediateCatchEvent",
  intermediateThrowEvent: "bpmn:IntermediateThrowEvent",
  boundaryEvent: "bpmn:BoundaryEvent",
  task: "bpmn:Task",
  userTask: "bpmn:UserTask",
  serviceTask: "bpmn:ServiceTask",
  scriptTask: "bpmn:ScriptTask",
  businessRuleTask: "bpmn:BusinessRuleTask",
  sendTask: "bpmn:SendTask",
  receiveTask: "bpmn:ReceiveTask",
  manualTask: "bpmn:ManualTask",
  callActivity: "bpmn:CallActivity",
  subProcess: "bpmn:SubProcess",
  exclusiveGateway: "bpmn:ExclusiveGateway",
  parallelGateway: "bpmn:ParallelGateway",
  inclusiveGateway: "bpmn:InclusiveGateway",
  eventBasedGateway: "bpmn:EventBasedGateway",
  textAnnotation: "bpmn:TextAnnotation",
};

export function shortType(bpmnType: string): string {
  const local = bpmnType.includes(":") ? bpmnType.split(":")[1] : bpmnType;
  return local.charAt(0).toLowerCase() + local.slice(1);
}
