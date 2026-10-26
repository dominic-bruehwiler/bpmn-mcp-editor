/** The invoice sample is a complete executable Camunda 7 process, used to seed an empty database. */
import { createExecutableDiagram, editDiagram } from "./bpmn/edit";

export async function invoiceDiagram(): Promise<string> {
  const blank = await createExecutableDiagram({
    name: "Invoice approval",
    processId: "Process_invoice",
  });

  const edited = await editDiagram(blank, [
    {
      op: "add",
      type: "userTask",
      ref: "approve",
      name: "Approve invoice",
      properties: {
        assignee: "demo",
        candidateGroups: "accounting",
        formKey: "embedded:app:forms/invoice.html",
      },
    },
    { op: "add", type: "exclusiveGateway", ref: "decision", name: "Approved?" },
    { op: "add", type: "endEvent", ref: "paid", name: "Paid" },
    { op: "add", type: "endEvent", ref: "rejected", name: "Rejected" },
    { op: "connect", sourceId: "StartEvent_1", targetId: "approve" },
    { op: "connect", sourceId: "approve", targetId: "decision" },
    { op: "connect", sourceId: "decision", targetId: "paid", name: "yes", condition: "${approved}" },
    { op: "connect", sourceId: "decision", targetId: "rejected", name: "no", condition: "${!approved}" },
  ]);

  return edited.xml;
}
