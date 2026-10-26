/**
 * Lints a diagram with bpmnlint's recommended rules plus the Camunda Platform 7.24 profile.
 * The build profile downgrades completeness rules so an agent can construct a process step by step.
 * The deploy profile keeps those rules as errors and is what "is this ready for Camunda?" answers.
 */
import { createRequire } from "node:module";
import { readDiagram } from "./moddle";
import type { Element } from "./moddle";
import type { Issue } from "./types";

const require = createRequire(import.meta.url);
const { Linter } = require("bpmnlint") as {
  Linter: new (options: { resolver: unknown; config: unknown }) => {
    lint: (root: unknown) => Promise<Record<string, { id?: string; message: string; category?: string }[]>>;
  };
};
const NodeResolver = require("bpmnlint/lib/resolver/node-resolver") as new () => unknown;

const BUILD_RULES = {
  "label-required": "warn",
  "no-disconnected": "warn",
  "end-event-required": "warn",
  "start-event-required": "warn",
  "no-implicit-end": "warn",
  "no-implicit-start": "warn",
};

function linterFor(profile: "build" | "deploy") {
  return new Linter({
    resolver: new NodeResolver(),
    config: {
      extends: ["bpmnlint:recommended", "plugin:camunda-compat/camunda-platform-7-24"],
      rules: profile === "build" ? BUILD_RULES : {},
    },
  });
}

function severityOf(category: string | undefined): Issue["severity"] {
  if (category === "warn") return "warning";
  if (category === "info") return "info";
  return "error";
}

export async function lintDiagram(xml: string, profile: "build" | "deploy"): Promise<Issue[]> {
  const diagram = await readDiagram(xml);
  const reports = await linterFor(profile).lint(diagram.definitions);
  const issues: Issue[] = [];

  for (const [rule, entries] of Object.entries(reports)) {
    for (const entry of entries) {
      issues.push({
        rule,
        severity: severityOf(entry.category),
        message: entry.message,
        elementId: entry.id,
      });
    }
  }

  issues.push(...camundaExecutionIssues(diagram.process));
  return issues;
}

/**
 * Camunda 7 deploys a service task, script, business rule, or call activity only when its
 * implementation is set. bpmnlint's platform profile does not cover that, so we do.
 * Send tasks stay a warning because they are often implemented with a connector.
 */
function camundaExecutionIssues(process: Element): Issue[] {
  const issues: Issue[] = [];

  if (process.isExecutable && !process.historyTimeToLive) {
    issues.push({
      rule: "camunda/history-time-to-live",
      severity: "error",
      elementId: process.id,
      message: "An executable Camunda 7 process needs camunda:historyTimeToLive.",
    });
  }

  const elements = collect(process);
  for (const element of elements) {
    if (element.$type === "bpmn:ServiceTask" && !hasServiceImplementation(element)) {
      issues.push(implementationIssue(element, "Service task"));
    }
    if (element.$type === "bpmn:BusinessRuleTask" && !element.decisionRef && !hasServiceImplementation(element)) {
      issues.push(implementationIssue(element, "Business rule task", "decisionRef, class, expression, or delegateExpression"));
    }
    if (element.$type === "bpmn:ScriptTask" && (!element.scriptFormat || !element.script)) {
      issues.push({
        rule: "camunda/script-task",
        severity: "error",
        elementId: element.id,
        message: "Script task needs scriptFormat and script.",
      });
    }
    if (element.$type === "bpmn:CallActivity" && !element.calledElement) {
      issues.push({
        rule: "camunda/call-activity",
        severity: "error",
        elementId: element.id,
        message: "Call activity needs calledElement.",
      });
    }
    if (element.$type === "bpmn:SendTask" && !hasServiceImplementation(element)) {
      issues.push({
        rule: "camunda/send-task",
        severity: "warning",
        elementId: element.id,
        message: "Send task has no class, expression, delegateExpression, or external topic.",
      });
    }
    if (element.$type === "bpmn:UserTask" && !hasUserAssignment(element)) {
      issues.push({
        rule: "camunda/user-task",
        severity: "warning",
        elementId: element.id,
        message: "User task has no assignee, candidate users/groups, or formKey.",
      });
    }
    for (const definition of arrayOf(element.eventDefinitions)) {
      if (definition.$type === "bpmn:TimerEventDefinition" && !definition.timeDuration && !definition.timeDate && !definition.timeCycle) {
        issues.push({
          rule: "camunda/timer",
          severity: "error",
          elementId: element.id,
          message: "Timer event needs timerDuration, timerDate, or timerCycle.",
        });
      }
    }
  }

  return issues;
}

function implementationIssue(element: Element, label: string, expected = "class, expression, delegateExpression, or an external topic"): Issue {
  return {
    rule: "camunda/implementation",
    severity: "error",
    elementId: element.id,
    message: `${label} needs ${expected}.`,
  };
}

function hasServiceImplementation(element: Element): boolean {
  if (typeof element.class === "string" && element.class) return true;
  if (typeof element.delegateExpression === "string" && element.delegateExpression) return true;
  if (typeof element.expression === "string" && element.expression) return true;
  return element.type === "external" && typeof element.topic === "string" && element.topic.length > 0;
}

function hasUserAssignment(element: Element): boolean {
  return ["assignee", "candidateUsers", "candidateGroups", "formKey", "formRef"].some(
    (key) => typeof element[key] === "string" && element[key],
  );
}

function collect(process: Element): Element[] {
  const found: Element[] = [];
  const walk = (container: Element) => {
    for (const child of arrayOf(container.flowElements)) {
      found.push(child);
      walk(child);
    }
  };
  walk(process);
  return found;
}

function arrayOf(value: unknown): Element[] {
  return Array.isArray(value) ? (value as Element[]) : [];
}
