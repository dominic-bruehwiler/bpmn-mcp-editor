declare module "bpmn-moddle" {
  export function BpmnModdle(packages?: Record<string, unknown>): unknown;
}

declare module "bpmn-auto-layout" {
  export function layoutProcess(xml: string): Promise<string>;
}
